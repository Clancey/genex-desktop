/**
 * A person's own OpenAI-compatible model server, usually on another machine on their network
 * (LM Studio, vLLM, llama.cpp server, LocalAI, an Ollama on the GPU box…). The engine lists what the
 * server offers from `GET {baseUrl}/models` and runs the studio's own turn loop against
 * `{baseUrl}/chat/completions` through the same pi-ai path as Ollama (`openai-completions.ts`).
 *
 * The address and the optional API key are configured from Settings (`main/core/openai-endpoint.ts`);
 * the key is sent as a bearer token and never appears in a status, a model row or an error.
 */
import { EngineId } from "../../shared/providers.ts";
import { EngineKind, EngineStatusCode } from "../../shared/engine-descriptor.ts";
import { EngineFailureKind } from "../../shared/engine-requests.ts";
import { HOUR_MS, SECOND_MS } from "../../shared/duration.ts";
import { isJsonObject } from "../fsx.ts";
import { type CompletionsModel, OpenAICompletions, isCutConnection } from "./openai-completions.ts";
import {
  type CompleteRequest,
  type CompleteResponse,
  type Engine,
  EngineError,
  type EngineModel,
  type EngineStatus,
  ModelContextSource,
  classifyHttpFailure,
} from "./types.ts";

/** How long a `/models` listing is reused before the endpoint is asked again. */
const MODEL_LIST_TTL_MS = 15 * SECOND_MS;
/** How long the endpoint has to answer `/models` before it counts as not answering. */
const MODEL_LIST_TIMEOUT_MS = 10 * SECOND_MS;
/** Ceiling on one completion; remote local models can be slow, but a dead stream must end. */
const COMPLETION_TIMEOUT_MS = HOUR_MS;
/** The planning budget for a model whose server does not report its context. */
const DEFAULT_CONTEXT_TOKENS = 8192;
/** The most a single reply may use, whatever the context. */
const MAX_REPLY_TOKENS = 32768;
/** The most models one listing keeps, so a hostile or huge server cannot flood the picker. */
const MAX_MODELS = 500;
/** The longest model id accepted from a listing. */
const MAX_MODEL_ID_CHARS = 200;
/**
 * pi-ai needs a bearer token to call; a keyless server ignores it. Only used when no key is saved,
 * so no secret is involved.
 */
const KEYLESS_PLACEHOLDER = "no-key";

/** The context fields servers report, most specific first (loaded/runtime before trained maximum). */
const CONTEXT_FIELDS = [
  ["loaded_context_length"],
  ["context_length"],
  ["max_model_len"],
  ["context_window"],
  ["max_context_length"],
  ["meta", "n_ctx"],
  ["meta", "n_ctx_train"],
  ["top_provider", "context_length"],
] as const;
/** Listing `type`s that are not chat models. */
const NON_CHAT_TYPES: readonly string[] = ["embeddings", "embedding", "rerank", "reranker"];
const TOOL_WORDS: readonly string[] = ["tools", "tool_use", "function_calling"];
const VISION_WORDS: readonly string[] = ["vision", "image"];
const THINKING_WORDS: readonly string[] = ["reasoning", "thinking"];

const MESSAGE = {
  NotConfiguredDetail: "No OpenAI-compatible endpoint is set up",
  SetupRemedy: "Add your server's address in Settings → Local Models.",
  NotConfigured: "no OpenAI-compatible endpoint is set up — add one in Settings → Local Models",
  NotAnsweringDetail: (baseUrl: string) => `no answer from ${baseUrl}`,
  NotAnsweringRemedy: "Check that the server is running and reachable from this Mac, then try again.",
  NoRouteDetail: (baseUrl: string) => `this computer has no route to ${baseUrl}`,
  NoRouteRemedy: "Check the address and that this computer is on the server's network, then try again.",
  NoRouteMacRemedy:
    "macOS may be blocking local network access: allow Genex (Electron when run from source) in System Settings → Privacy & Security → Local Network, then try again.",
  NotAnswering: (baseUrl: string) =>
    `the endpoint at ${baseUrl} is not answering — check that the server is running and reachable from this Mac`,
  KeyRefusedDetail: (baseUrl: string) => `${baseUrl} refused the API key`,
  KeyRemedy: "Check the API key in Settings → Local Models.",
  ListFailedDetail: (baseUrl: string, status: number) => `${baseUrl}/models answered HTTP ${status}`,
  NotAListing: (baseUrl: string) => `${baseUrl}/models did not answer with an OpenAI model list`,
  NoModelsDetail: (baseUrl: string) => `${baseUrl} lists no chat models`,
  NoModelsRemedy: "Load or serve a model on that server, then check again.",
  Ready: (baseUrl: string, count: number) => `${count} model(s) at ${baseUrl}`,
  NoModel: "the endpoint lists no chat model",
  NoTools: "tool calling is not supported by this model, as the endpoint reports it",
  NoVision: "vision input is not supported by this model, as the endpoint reports it",
  EstimatedContext:
    "The endpoint does not report this model's context; 8K is an estimated planning budget. Set it on the server to use more.",
  ModelMissing: (model: string) =>
    `the model ${model} is not served by the endpoint — load it on the server or pick another`,
  Cut: (detail: string | undefined) =>
    `the connection to the endpoint was cut mid-generation${detail ? ` (${detail})` : ""} — the partial turn was lost; check that the server is still running and send the message again`,
} as const;

/** Where the engine sends requests: a validated base URL and the key, if one is saved. */
export interface OpenAIEndpointConfig {
  baseUrl: string;
  apiKey: string | null;
}

/** Options for {@link OpenAICompatibleEngine}. */
export interface OpenAICompatibleEngineOptions {
  endpoint?: OpenAIEndpointConfig | null;
  /** Injected in tests so the timeout path need not wait an hour. */
  timeoutMs?: number;
  /** Injected in tests to step past the listing cache. */
  now?: () => number;
  /** Injected in tests to simulate network failures; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Injected in tests; decides whether a blocked route points at macOS Local Network privacy. */
  platform?: NodeJS.Platform;
}

/**
 * Socket errors meaning the host could not be routed to at all. macOS Local Network privacy
 * refuses a LAN connection from an app it has not allowed with exactly this.
 */
const NO_ROUTE_CODES: ReadonlySet<string> = new Set(["EHOSTUNREACH", "ENETUNREACH"]);

/** How listing reaches the network, and on which platform. */
interface ListingTransport {
  fetch: typeof fetch;
  platform: NodeJS.Platform;
}

/** The socket error code under a failed fetch, if it carries one. */
function socketErrorCode(err: unknown): string | null {
  const cause = (err as { cause?: unknown } | null)?.cause;
  const code = (cause as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/** Why a fetch to the endpoint never got an answer. */
function unreachableStatus(config: OpenAIEndpointConfig, err: unknown, platform: NodeJS.Platform): EngineStatus {
  const code = socketErrorCode(err);
  if (code === null || !NO_ROUTE_CODES.has(code)) {
    return {
      code: EngineStatusCode.NotRunning,
      detail: MESSAGE.NotAnsweringDetail(config.baseUrl),
      remedy: MESSAGE.NotAnsweringRemedy,
    };
  }
  return {
    code: EngineStatusCode.NotRunning,
    detail: MESSAGE.NoRouteDetail(config.baseUrl),
    remedy: platform === "darwin" ? MESSAGE.NoRouteMacRemedy : MESSAGE.NoRouteRemedy,
  };
}

type Listing = { ok: true; models: EngineModel[] } | { ok: false; status: EngineStatus };

interface Connection {
  config: OpenAIEndpointConfig;
  completions: OpenAICompletions;
  listed: { at: number; listing: Promise<Listing> } | null;
  defaultModel: string | null;
}

/** A reply may use a quarter of its context, never more than the cap. */
function maxReplyTokens(contextWindow: number): number {
  return Math.min(MAX_REPLY_TOKENS, Math.floor(contextWindow / 4));
}

function stringsAt(row: Record<string, unknown>, key: string): string[] | null {
  const value = row[key];
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === "string").map((item) => item.toLowerCase());
}

function numberAt(row: Record<string, unknown>, path: readonly string[]): number | null {
  let value: unknown = row;
  for (const key of path) {
    if (!isJsonObject(value)) return null;
    value = value[key];
  }
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function reportedContext(row: Record<string, unknown>): number | null {
  for (const path of CONTEXT_FIELDS) {
    const tokens = numberAt(row, path);
    if (tokens !== null) return tokens;
  }
  return null;
}

/** What a listing row says the model accepts, from `supported_parameters` or `capabilities`. */
function reports(row: Record<string, unknown>, words: readonly string[]): boolean | null {
  const listed = stringsAt(row, "supported_parameters") ?? stringsAt(row, "capabilities");
  if (listed === null) return null;
  return listed.some((word) => words.includes(word));
}

function seesImages(row: Record<string, unknown>): boolean {
  const architecture = row.architecture;
  const modalities = isJsonObject(architecture) ? stringsAt(architecture, "input_modalities") : null;
  if (modalities?.includes("image")) return true;
  if (row.type === "vlm") return true;
  return stringsAt(row, "capabilities")?.some((word) => VISION_WORDS.includes(word)) ?? false;
}

function isChatRow(row: unknown): row is Record<string, unknown> & { id: string } {
  if (!isJsonObject(row)) return false;
  const { id, type } = row;
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_MODEL_ID_CHARS) return false;
  return typeof type !== "string" || !NON_CHAT_TYPES.includes(type.toLowerCase());
}

/** One `/models` row as the studio's model, with what the server reported about it. */
function toEngineModel(row: Record<string, unknown> & { id: string }): EngineModel {
  const context = reportedContext(row);
  const contextWindow = context ?? DEFAULT_CONTEXT_TOKENS;
  return {
    id: row.id,
    label: row.id,
    contextWindow,
    contextSource: context === null ? ModelContextSource.Unknown : ModelContextSource.Configured,
    maxTokens: maxReplyTokens(contextWindow),
    // A server that does not say is asked anyway: most serve tool calls, and it refuses clearly if not.
    supportsTools: reports(row, TOOL_WORDS) ?? true,
    supportsVision: seesImages(row),
    supportsThinking: reports(row, THINKING_WORDS) ?? false,
    installed: true,
    ...(context === null ? { note: MESSAGE.EstimatedContext } : {}),
  };
}

/** The chat models in a `/models` answer, or null when it is not an OpenAI model list. */
export function parseModelList(body: unknown): EngineModel[] | null {
  if (!isJsonObject(body) || !Array.isArray(body.data)) return null;
  const seen = new Set<string>();
  const models: EngineModel[] = [];
  for (const row of body.data) {
    if (!isChatRow(row) || seen.has(row.id)) continue;
    seen.add(row.id);
    models.push(toEngineModel(row));
    if (models.length >= MAX_MODELS) break;
  }
  return models;
}

function authHeaders(config: OpenAIEndpointConfig): Record<string, string> {
  return config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {};
}

function failedListing(config: OpenAIEndpointConfig, status: number): Listing {
  const failure = classifyHttpFailure(EngineId.OpenAICompatible, status, "");
  if (failure.kind === EngineFailureKind.Auth) {
    return {
      ok: false,
      status: {
        code: EngineStatusCode.NeedsLogin,
        detail: MESSAGE.KeyRefusedDetail(config.baseUrl),
        remedy: MESSAGE.KeyRemedy,
      },
    };
  }
  return {
    ok: false,
    status: { code: EngineStatusCode.Error, detail: MESSAGE.ListFailedDetail(config.baseUrl, status) },
  };
}

async function listModels(config: OpenAIEndpointConfig, transport: ListingTransport): Promise<Listing> {
  let response: Response;
  try {
    response = await transport.fetch(`${config.baseUrl}/models`, {
      headers: { accept: "application/json", ...authHeaders(config) },
      signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
      redirect: "error",
    });
  } catch (err) {
    return { ok: false, status: unreachableStatus(config, err, transport.platform) };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return failedListing(config, response.status);
  }
  const models = parseModelList(await response.json().catch(() => null));
  if (models === null) {
    return { ok: false, status: { code: EngineStatusCode.Error, detail: MESSAGE.NotAListing(config.baseUrl) } };
  }
  return { ok: true, models };
}

/** The engine for a person's own OpenAI-compatible endpoint. Unconfigured until Settings gives it one. */
export class OpenAICompatibleEngine implements Engine {
  readonly id = EngineId.OpenAICompatible;
  readonly label = "OpenAI-compatible endpoint";
  readonly kind = EngineKind.Direct;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #transport: ListingTransport;
  #connection: Connection | null = null;

  constructor(options: OpenAICompatibleEngineOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? COMPLETION_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
    this.#transport = { fetch: options.fetch ?? globalThis.fetch, platform: options.platform ?? process.platform };
    this.configure(options.endpoint ?? null);
  }

  /** The configured base URL, or null when no endpoint is set up. */
  get baseUrl(): string | null {
    return this.#connection?.config.baseUrl ?? null;
  }

  /** Point the engine at another endpoint (or none); everything learned from the old one is dropped. */
  configure(endpoint: OpenAIEndpointConfig | null): void {
    if (!endpoint) {
      this.#connection = null;
      return;
    }
    const config = { ...endpoint };
    this.#connection = {
      config,
      listed: null,
      defaultModel: null,
      completions: new OpenAICompletions({
        engineId: EngineId.OpenAICompatible,
        name: "OpenAI-compatible",
        baseUrl: config.baseUrl,
        apiKey: async () => config.apiKey ?? KEYLESS_PLACEHOLDER,
        words: { cut: MESSAGE.Cut, modelMissing: MESSAGE.ModelMissing },
      }),
    };
  }

  /** The endpoint's listing, reused for a short while so the picker and turns do not re-ask. */
  async #listing(connection: Connection, fresh = false): Promise<Listing> {
    const now = this.#now();
    const cached = connection.listed;
    if (!fresh && cached && now - cached.at < MODEL_LIST_TTL_MS) return cached.listing;
    const listing = listModels(connection.config, this.#transport);
    connection.listed = { at: now, listing };
    return listing;
  }

  /** Ask the endpoint again now, bypassing the listing cache (after saving it in Settings). */
  async refreshModels(): Promise<void> {
    if (this.#connection) await this.#listing(this.#connection, true);
  }

  async status(): Promise<EngineStatus> {
    const connection = this.#connection;
    if (!connection) {
      return { code: EngineStatusCode.NotInstalled, detail: MESSAGE.NotConfiguredDetail, remedy: MESSAGE.SetupRemedy };
    }
    const listing = await this.#listing(connection);
    if (!listing.ok) return listing.status;
    const { baseUrl } = connection.config;
    if (listing.models.length === 0) {
      return {
        code: EngineStatusCode.NotInstalled,
        detail: MESSAGE.NoModelsDetail(baseUrl),
        remedy: MESSAGE.NoModelsRemedy,
      };
    }
    return { code: EngineStatusCode.Ready, detail: MESSAGE.Ready(baseUrl, listing.models.length) };
  }

  async models(): Promise<EngineModel[]> {
    if (!this.#connection) return [];
    const listing = await this.#listing(this.#connection);
    return listing.ok ? listing.models : [];
  }

  async defaultModel(): Promise<string | null> {
    const connection = this.#connection;
    if (!connection) return null;
    if (connection.defaultModel) return connection.defaultModel;
    const models = await this.models();
    // Prefer a tool-capable model: without tool calling the studio's own loop cannot build.
    const chosen = models.find((m) => m.supportsTools) ?? models[0];
    if (this.#connection === connection) connection.defaultModel = chosen?.id ?? null;
    return chosen?.id ?? null;
  }

  async #describe(modelId: string): Promise<CompletionsModel> {
    const listed = (await this.models()).find((m) => m.id === modelId);
    const contextWindow = listed?.contextWindow ?? DEFAULT_CONTEXT_TOKENS;
    return {
      id: modelId,
      contextWindow,
      maxTokens: listed?.maxTokens ?? maxReplyTokens(contextWindow),
      thinking: listed?.supportsThinking ?? false,
      vision: listed?.supportsVision ?? false,
      tools: listed?.supportsTools ?? true,
    };
  }

  async complete(request: CompleteRequest): Promise<CompleteResponse> {
    const connection = this.#connection;
    if (!connection) throw new EngineError(EngineFailureKind.Unavailable, this.id, MESSAGE.NotConfigured);
    const modelId = request.model ?? (await this.defaultModel());
    if (!modelId) throw new EngineError(EngineFailureKind.Unavailable, this.id, MESSAGE.NoModel);
    const model = await this.#describe(modelId);
    connection.completions.check(request, model, { noTools: MESSAGE.NoTools, noVision: MESSAGE.NoVision });
    try {
      return await connection.completions.complete(model, request, this.#timeoutMs);
    } catch (err) {
      throw await this.#unlessServerGone(connection, err as EngineError);
    }
  }

  /** A cut connection with the endpoint no longer answering at all is a server that went away. */
  async #unlessServerGone(connection: Connection, failure: EngineError): Promise<EngineError> {
    if (!(failure instanceof EngineError) || !isCutConnection(failure)) return failure;
    const listing = await this.#listing(connection, true);
    if (listing.ok || listing.status.code !== EngineStatusCode.NotRunning) return failure;
    return new EngineError(EngineFailureKind.Unavailable, this.id, MESSAGE.NotAnswering(connection.config.baseUrl));
  }
}
