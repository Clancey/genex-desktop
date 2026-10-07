/**
 * The OpenAI-compatible `/chat/completions` turn every direct server engine shares (Ollama, and any
 * endpoint a person points the studio at), spoken through pi-ai's provider so streaming, tool-call
 * assembly and usage accounting are one code path. Each engine keeps its own discovery and its own
 * words; this module owns the wire.
 */
import { randomUUID } from "node:crypto";
import type { Message, Usage } from "../types.ts";
import {
  type CompleteRequest,
  type CompleteResponse,
  EngineError,
  type ToolDefinition,
  classifyHttpFailure,
} from "./types.ts";
import { EngineFailureKind } from "../../shared/engine-requests.ts";
import { ReasoningEffort } from "../../shared/model-preferences.ts";
import { CompletionStop, STOPPED_BY_USER } from "./common.ts";

/** The status a server answers for a model it does not have. */
const HTTP_NOT_FOUND = 404;

/** What the server and one of its models can do, as the engine learned it. */
export interface CompletionsModel {
  id: string;
  contextWindow: number;
  maxTokens: number;
  thinking: boolean;
  vision: boolean;
  tools: boolean;
}

/** Where completions go and what their failures say. */
export interface CompletionsTarget {
  engineId: string;
  /** The provider's name as pi-ai records it. */
  name: string;
  /** The OpenAI-compatible root, ending before `/chat/completions` (for Ollama, `<host>/v1`). */
  baseUrl: string;
  /** Sent as the bearer token. A keyless server ignores it; pi-ai requires one to call. */
  apiKey: () => Promise<string>;
  words: {
    /** A connection cut mid-generation, with the transport's own detail when it gave one. */
    cut: (detail: string | undefined) => string;
    /** A 404 for a named model: the server does not have it. */
    modelMissing: (model: string) => string;
  };
}

// ── message conversion (substrate ⇄ pi-ai) ─────────────────────────────────────────────────
interface PiTextContent {
  type: "text";
  text: string;
}
interface PiToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** The substrate's messages as pi-ai's: system messages fold into one system prompt. */
export function toPiMessages(messages: Message[], engineId: string): { systemPrompt?: string; piMessages: unknown[] } {
  const piMessages: unknown[] = [];
  let systemPrompt: string | undefined;
  for (const message of messages) {
    if (message.role === "system") {
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${message.content}` : message.content;
      continue;
    }
    piMessages.push(piMessage(message, engineId));
  }
  return systemPrompt !== undefined ? { systemPrompt, piMessages } : { piMessages };
}

/** A non-system message as pi-ai spells it. */
function piMessage(message: Message, engineId: string): unknown {
  if (message.role === "user") return piUserMessage(message);
  if (message.role === "assistant") return piAssistantMessage(message, engineId);
  // role === "tool"
  return piToolResult(message);
}

/** A user message: plain text, or text plus its stills as image parts. */
function piUserMessage(message: Message): unknown {
  const images = message.images ?? [];
  if (images.length === 0) return { role: "user", content: message.content, timestamp: Date.now() };
  const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
  if (message.content) content.push({ type: "text", text: message.content });
  for (const image of images) {
    if (!image.data) continue;
    content.push({ type: "image", data: image.data, mimeType: image.mimeType || "image/jpeg" });
  }
  return { role: "user", content, timestamp: Date.now() };
}

/** An assistant message: its text, then its tool calls. */
function piAssistantMessage(message: Message, engineId: string): unknown {
  const content: (PiTextContent | PiToolCall)[] = [];
  if (message.content) content.push({ type: "text", text: message.content });
  for (const call of message.tool_calls ?? []) {
    content.push({
      type: "toolCall",
      id: call.id,
      name: call.name,
      arguments: (call.arguments ?? {}) as Record<string, unknown>,
    });
  }
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: engineId,
    model: "",
    usage: emptyPiUsage(),
    stopReason: CompletionStop.Stop,
    timestamp: Date.now(),
  };
}

/** A tool's answer. */
function piToolResult(message: Message): unknown {
  return {
    role: "toolResult",
    toolCallId: message.tool_call_id ?? "",
    toolName: message.name ?? "tool",
    content: [{ type: "text", text: message.content }],
    isError: message.is_error === true,
    timestamp: Date.now(),
  };
}

function emptyPiUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** A pi-ai assistant message, the fields an engine reads. */
export interface PiAssistant {
  content: Array<{ type: string; text?: string; id?: string; name?: string; arguments?: unknown }>;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  stopReason?: string;
  model?: string;
}

/** pi-ai's reply as the substrate's message, and its token counts. */
export function fromPiAssistant(assistant: PiAssistant, engineId: string): { message: Message; usage: Usage } {
  let text = "";
  let reasoning = "";
  const toolCalls: NonNullable<Message["tool_calls"]> = [];
  for (const part of assistant.content ?? []) {
    if (part.type === "text") text += part.text ?? "";
    else if (part.type === "thinking") reasoning += part.text ?? "";
    else if (part.type === "toolCall") {
      // A call the model left unnamed still needs an id no other round repeats: its result is bound by it.
      toolCalls.push({
        id: part.id || `${engineId}-${randomUUID()}`,
        name: part.name ?? "",
        arguments: part.arguments ?? {},
      });
    }
  }
  const message: Message = { role: "assistant", content: text };
  if (toolCalls.length) message.tool_calls = toolCalls;
  if (reasoning) message.reasoning = reasoning;
  return { message, usage: piUsage(assistant, engineId) };
}

/** A reply's token counts; a server the person runs bills nothing here. */
function piUsage(assistant: PiAssistant, engineId: string): Usage {
  const usage = assistant.usage;
  return {
    input_tokens: usage?.input ?? 0,
    output_tokens: usage?.output ?? 0,
    cache_read_tokens: usage?.cacheRead ?? 0,
    cache_write_tokens: usage?.cacheWrite ?? 0,
    cost_usd: 0,
    ...(assistant.model ? { model: assistant.model } : {}),
    engine: engineId,
  };
}

/**
 * Node's fetch (undici) kills any response that stays *silent* for 300 seconds
 * (`bodyTimeout`), surfacing the opaque `TypeError: terminated`. Ollama's tool-call parser
 * buffers a whole call server-side before emitting it, so while a model writes one big
 * write_file call — a 27B model authoring a full game is ~5 minutes of arguments at
 * ~10 tok/s — the wire carries nothing and the timeout fires mid-turn. Long silent phases
 * (prompt eval on a huge context) hit the same wall. Local generations are legitimately
 * unbounded and the Stop button, not a transport default, is the clock. pi-ai lets us
 * supply the fetch it hands its OpenAI client, so completions run through one whose
 * dispatcher never times out.
 *
 * The dispatcher class is taken from Node's own lazily-created global (the well-known
 * `undici.globalDispatcher.1` symbol) rather than an npm `undici` — a separately installed
 * copy can disagree with the built-in fetch about the handler protocol.
 */
let longHaulDispatcher: object | null = null;
async function ensureLongHaulDispatcher(): Promise<object | null> {
  if (longHaulDispatcher) return longHaulDispatcher;
  const key = Symbol.for("undici.globalDispatcher.1");
  const globals = globalThis as unknown as Record<symbol, { constructor: new (opts: object) => object } | undefined>;
  if (!globals[key]) {
    // Node initialises the global dispatcher on first fetch; force that cheaply (data: URL,
    // no network) so we can borrow its constructor.
    await fetch("data:,").catch(() => {});
  }
  const current = globals[key];
  if (!current) return null;
  longHaulDispatcher = new current.constructor({ headersTimeout: 0, bodyTimeout: 0 });
  return longHaulDispatcher;
}

/** Failures that are a connection cut: the engine may ask whether the server is still there. */
const CUT_CONNECTIONS = new WeakSet<EngineError>();

/** Whether `failure` is a connection cut before the reply was whole. */
export function isCutConnection(failure: EngineError): boolean {
  return CUT_CONNECTIONS.has(failure);
}

/**
 * A connection cut mid-stream surfaces as undici's bare `TypeError: terminated` (sometimes
 * wrapped as "Connection error." by the OpenAI client, or arriving via pi-ai's
 * stopReason "error" instead of a throw). The client's request timeout is the same story in
 * another spelling: "Request timed out." after an hour of silence is a dead connection, not
 * an answer. Translate every spelling into something a person can act on; everything else
 * passes through unchanged.
 */
function translateStreamFailure(
  target: CompletionsTarget,
  model: string,
  message: string,
  cause?: { message?: string; code?: string },
): EngineError {
  // An HTTP failure that arrives through the stream ("429: <body>") is the same failure as one
  // that arrives before it — without this, a throttled server reads as "other" and every
  // rate-limit policy above (backoff, direct-only fallback) is unreachable for this engine. A
  // server whose `error` is a bare string is spelled without the colon (`404 "model not found"`).
  const http = /^(\d{3}):?\s/.exec(message.trim());
  if (http) return httpFailure(target, Number(http[1]), message, model);
  const cut = /^(terminated|fetch failed|Connection error\.?|Request timed out\.?)$/i.test(message.trim());
  if (!cut) return new EngineError(EngineFailureKind.Other, target.engineId, message);
  const failure = new EngineError(
    EngineFailureKind.Other,
    target.engineId,
    target.words.cut(cause?.message ?? cause?.code),
  );
  CUT_CONNECTIONS.add(failure);
  return failure;
}

/** An HTTP failure; a 404 naming a model is the server saying it does not have it (P04-F8). */
function httpFailure(target: CompletionsTarget, status: number, body: string, model: string): EngineError {
  if (status === HTTP_NOT_FOUND && model)
    return new EngineError(EngineFailureKind.Unavailable, target.engineId, target.words.modelMissing(model));
  return classifyHttpFailure(target.engineId, status, body);
}

function throwAborted(engineId: string): never {
  throw new EngineError(EngineFailureKind.Aborted, engineId, STOPPED_BY_USER);
}

/** Unblock a silent stream (thinking, huge tool-call buffer) the moment Stop fires. */
function whenAborted(signal: AbortSignal | undefined, engineId: string): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) return;
    const fail = (): void => reject(new EngineError(EngineFailureKind.Aborted, engineId, STOPPED_BY_USER));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

/** pi-ai's streaming call, as the engines use it. */
type PiStream = AsyncIterable<{ type: string; delta?: string }> & { result: () => Promise<unknown> };
type PiStreamFn = (m: unknown, c: unknown, o?: unknown) => PiStream;

/**
 * One server's completions through pi-ai: the provider is built lazily and keeps a description
 * of every model asked for so far.
 */
export class OpenAICompletions {
  readonly target: CompletionsTarget;
  #models: unknown = null;
  #providerModels = new Map<string, unknown>();

  constructor(target: CompletionsTarget) {
    this.target = target;
  }

  /** Forget a model's description, so the next request describes it afresh. */
  forget(modelId: string): void {
    this.#providerModels.delete(modelId);
  }

  /** Refuse what the model cannot take before any inference request. */
  check(request: CompleteRequest, model: CompletionsModel, words: { noTools: string; noVision: string }): void {
    if (request.tools?.length && !model.tools) {
      throw new EngineError(EngineFailureKind.Unavailable, this.target.engineId, words.noTools);
    }
    const needsVision = request.messages.some((message) => Boolean(message.images?.length));
    if (needsVision && !model.vision) {
      throw new EngineError(EngineFailureKind.Unavailable, this.target.engineId, words.noVision);
    }
  }

  /** Stream one completion; every failure is an {@link EngineError} the run policy can act on. */
  async complete(model: CompletionsModel, request: CompleteRequest, timeoutMs: number): Promise<CompleteResponse> {
    const engineId = this.target.engineId;
    const { models, piModel } = await this.#ensureProvider(model);
    try {
      const stream = (models as { stream: PiStreamFn }).stream(piModel, piContext(request, engineId), {
        fetch: longHaulFetch(request.signal),
        // Without this, the OpenAI client's 10-minute default cuts long builds mid-turn.
        timeoutMs: Math.min(request.timeoutMs ?? timeoutMs, timeoutMs),
        ...(request.signal ? { signal: request.signal } : {}),
        ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}),
        ...(model.thinking && request.effort ? { reasoningEffort: normalizeEffort(request.effort) } : {}),
      });
      await drain(stream, request, engineId);
      const assistant = (await stream.result()) as PiAssistant & { errorMessage?: string };
      if (assistant.stopReason === CompletionStop.Aborted) throwAborted(engineId);
      if (assistant.stopReason === CompletionStop.Error) {
        throw translateStreamFailure(this.target, model.id, assistant.errorMessage ?? "model stream failed");
      }
      const { message, usage } = fromPiAssistant(assistant, engineId);
      return {
        message,
        usage,
        stopReason: assistant.stopReason ?? CompletionStop.Stop,
        model: model.id,
        engine: engineId,
      };
    } catch (err) {
      throw this.#failure(err, request, model.id);
    }
  }

  /** Lazily build pi-ai's provider around this server, describing `model` to it. */
  async #ensureProvider(model: CompletionsModel): Promise<{ models: unknown; piModel: unknown }> {
    const { createModels, createProvider } = await import("@earendil-works/pi-ai");
    const { openAICompletionsApi } = await import("@earendil-works/pi-ai/api/openai-completions.lazy");
    if (!this.#models) this.#models = createModels();
    const piModel = this.#piModel(model);
    this.#providerModels.set(model.id, piModel);
    const apiKey = await this.target.apiKey();
    (this.#models as { setProvider: (p: unknown) => void }).setProvider(
      createProvider({
        id: this.target.engineId,
        name: this.target.name,
        baseUrl: this.target.baseUrl,
        // pi-ai requires *some* api-key auth to consider a provider configured. A keyless server
        // ignores the value the engine supplies; a keyed one reads it as its bearer token.
        auth: {
          apiKey: {
            name: this.target.name,
            resolve: async () => ({ auth: { apiKey }, source: this.target.name }),
          },
        } as never,
        models: [...this.#providerModels.values()] as never,
        api: openAICompletionsApi(),
      }) as never,
    );
    return { models: this.#models, piModel };
  }

  /** pi-ai's description of one model. */
  #piModel(model: CompletionsModel): Record<string, unknown> {
    return {
      id: model.id,
      name: model.id,
      api: "openai-completions",
      provider: this.target.engineId,
      baseUrl: this.target.baseUrl,
      // A thinking-capable model gets the reasoning_effort knob — Ollama's OpenAI-compatible
      // endpoint maps it to the model's think level. Without it the newest locals default
      // deep and an unattended loop meditates instead of iterating.
      reasoning: model.thinking,
      supportsTools: model.tools,
      input: model.vision ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: model.thinking },
    };
  }

  /** What a failed completion throws, as an engine error the run policy can act on. */
  #failure(err: unknown, request: CompleteRequest, model: string): EngineError {
    if (err instanceof EngineError) return err;
    const engineId = this.target.engineId;
    // An abort wins over whatever error it caused — a stop must never read as a failure.
    if (request.signal?.aborted) return new EngineError(EngineFailureKind.Aborted, engineId, STOPPED_BY_USER);
    const error = err as Error & { status?: number; cause?: { message?: string; code?: string } };
    if (error.status) return httpFailure(this.target, error.status, error.message, model);
    return translateStreamFailure(this.target, model, error.message, error.cause);
  }
}

/** Read the stream to its end, passing text on as it comes; Stop unblocks even a silent stream. */
async function drain(stream: PiStream, request: CompleteRequest, engineId: string): Promise<void> {
  const iterator = stream[Symbol.asyncIterator]();
  let aborted = false;
  try {
    for (;;) {
      if (request.signal?.aborted) throwAborted(engineId);
      const step = iterator.next();
      const event = request.signal ? await Promise.race([step, whenAborted(request.signal, engineId)]) : await step;
      if (event.done) break;
      if (event.value.type === "text_delta" && event.value.delta) request.onDelta?.(event.value.delta);
    }
  } catch (err) {
    aborted = true;
    throw err;
  } finally {
    if (aborted) await iterator.return?.().catch(() => {});
  }
}

/** The request as pi-ai's context: one system prompt, the messages, and the tools. */
function piContext(request: CompleteRequest, engineId: string): Record<string, unknown> {
  const { systemPrompt, piMessages } = toPiMessages(request.messages, engineId);
  return {
    ...(request.systemPrompt || systemPrompt
      ? { systemPrompt: [request.systemPrompt, systemPrompt].filter(Boolean).join("\n\n") }
      : {}),
    messages: piMessages,
    ...(request.tools?.length ? { tools: request.tools.map(toPiTool) } : {}),
  };
}

/** The fetch pi-ai hands its OpenAI client: the long-haul dispatcher, and the user's Stop joined in. */
function longHaulFetch(stop: AbortSignal | undefined): typeof fetch {
  return async (input, init) => {
    const dispatcher = await ensureLongHaulDispatcher();
    // The client routes its request timeout through init.signal (an internal AbortController); the
    // user's Stop has to join that signal, not replace it — replacing would mask the
    // timeout and a dead connection would hang the loop instead of erroring.
    const signals = [init?.signal, stop].filter((s): s is AbortSignal => Boolean(s));
    return fetch(input, {
      ...init,
      ...(signals.length ? { signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) } : {}),
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit);
  };
}

function toPiTool(tool: ToolDefinition): unknown {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

/** OpenAI-compatible endpoints understand low/medium/high; clamp the wider scale into that range. */
function normalizeEffort(
  effort: string,
): typeof ReasoningEffort.Low | typeof ReasoningEffort.Medium | typeof ReasoningEffort.High {
  if (effort === ReasoningEffort.Minimal || effort === ReasoningEffort.Low) return ReasoningEffort.Low;
  if (effort === ReasoningEffort.Medium) return ReasoningEffort.Medium;
  return ReasoningEffort.High;
}
