/**
 * OpenAI-compatible endpoint engine conformance: the person points the studio at a server on
 * another machine (LM Studio, vLLM, llama.cpp, an Ollama on the network…), the engine lists that
 * server's `/models` and runs its own turns over real pi-ai HTTP against it.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { OpenAICompatibleEngine } from "../../src/substrate/engines/openai-compatible.ts";
import { EngineError, ModelContextSource } from "../../src/substrate/engines/types.ts";
import { EngineStatusCode } from "../../src/shared/engine-descriptor.ts";
import { EngineFailureKind } from "../../src/shared/engine-requests.ts";
import { EndpointUrlProblem, normalizeEndpointUrl } from "../../src/shared/openai-endpoint.ts";
import { startFakeOllama, type FakeOllama } from "../helpers/fake-ollama.ts";

const servers: FakeOllama[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

async function fake(options?: Parameters<typeof startFakeOllama>[0]): Promise<FakeOllama> {
  const server = await startFakeOllama(options);
  servers.push(server);
  return server;
}

function engineFor(server: FakeOllama, apiKey: string | null = null): OpenAICompatibleEngine {
  return new OpenAICompatibleEngine({ endpoint: { baseUrl: `${server.host}/v1`, apiKey } });
}

const LM_STUDIO_MODELS = [
  {
    id: "qwen3-coder-30b",
    object: "model",
    type: "llm",
    loaded_context_length: 65536,
    max_context_length: 262144,
    capabilities: ["tool_use"],
  },
  { id: "gemma-3-12b", object: "model", type: "vlm", max_context_length: 131072 },
  { id: "nomic-embed-text", object: "model", type: "embeddings" },
];

describe("endpoint address", () => {
  const cases: Array<[string, unknown, string | EndpointUrlProblem]> = [
    ["bare host gets /v1", "http://192.168.1.20:1234", "http://192.168.1.20:1234/v1"],
    ["trailing slashes trimmed", "https://gpu-box.local:8000/v1/", "https://gpu-box.local:8000/v1"],
    ["custom path kept", "http://10.0.0.5:8080/openai/v1", "http://10.0.0.5:8080/openai/v1"],
    ["surrounding space trimmed", "  http://box:1234  ", "http://box:1234/v1"],
    ["empty", "", EndpointUrlProblem.Empty],
    ["not a string", 42, EndpointUrlProblem.Empty],
    ["not a url", "gpu box", EndpointUrlProblem.Invalid],
    ["file scheme", "file:///etc/passwd", EndpointUrlProblem.Protocol],
    ["javascript scheme", "javascript:alert(1)", EndpointUrlProblem.Protocol],
    ["embedded credentials", "http://user:secret@box:1234/v1", EndpointUrlProblem.Credentials],
    ["query", "http://box:1234/v1?key=secret", EndpointUrlProblem.QueryOrFragment],
    ["fragment", "http://box:1234/v1#x", EndpointUrlProblem.QueryOrFragment],
    ["too long", `http://box/${"a".repeat(3000)}`, EndpointUrlProblem.TooLong],
  ];
  for (const [name, input, expected] of cases) {
    it(name, () => {
      const result = normalizeEndpointUrl(input);
      if (result.ok) assert.equal(result.baseUrl, expected);
      else assert.equal(result.problem, expected);
    });
  }
});

describe("openai-compatible endpoint discovery", () => {
  it("is not set up until an endpoint is configured, and asks no server", async () => {
    const engine = new OpenAICompatibleEngine();
    const status = await engine.status();
    assert.equal(status.code, EngineStatusCode.NotInstalled);
    assert.match(status.remedy ?? "", /Settings/);
    assert.deepEqual(await engine.models(), []);
    assert.equal(await engine.defaultModel(), null);
  });

  it("lists the endpoint's chat models with what /models reports about them", async () => {
    const server = await fake({ openaiModels: LM_STUDIO_MODELS });
    const engine = engineFor(server);
    const models = await engine.models();
    assert.deepEqual(
      models.map((m) => m.id),
      ["qwen3-coder-30b", "gemma-3-12b"],
      "embedding models are not chat models",
    );
    const [coder, gemma] = models;
    assert.equal(coder?.contextWindow, 65536, "the loaded context wins over the trained maximum");
    assert.equal(coder?.contextSource, ModelContextSource.Configured);
    assert.equal(coder?.supportsTools, true);
    assert.equal(gemma?.contextWindow, 131072);
    assert.equal(gemma?.supportsVision, true);
    assert.equal((await engine.status()).code, EngineStatusCode.Ready);
    assert.equal(await engine.defaultModel(), "qwen3-coder-30b");
  });

  it("lists a bare /models conservatively but usably", async () => {
    const server = await fake({ openaiModels: [{ id: "llama-3.3-70b", object: "model" }] });
    const [model] = await engineFor(server).models();
    assert.equal(model?.id, "llama-3.3-70b");
    assert.equal(model?.contextSource, ModelContextSource.Unknown);
    assert.ok((model?.contextWindow ?? 0) > 0);
    assert.equal(model?.supportsTools, true, "an unreported capability is left to the server");
    assert.ok(model?.note, "an estimated context is explained");
  });

  it("sends the saved API key as a bearer token, and none when there is no key", async () => {
    const keyed = await fake({ requireBearer: "sk-local-test" });
    assert.equal((await engineFor(keyed, "sk-local-test").models()).length, 1);
    const keyless = await fake();
    await engineFor(keyless).models();
    assert.equal(keyless.requests.at(-1)?.headers.authorization, undefined);
  });

  it("says the key was refused rather than that the server is down", async () => {
    const server = await fake({ requireBearer: "right" });
    const status = await engineFor(server, "wrong").status();
    assert.equal(status.code, EngineStatusCode.NeedsLogin);
    assert.doesNotMatch(JSON.stringify(status), /wrong/, "the key never appears in a status");
  });

  it("reports an endpoint that does not answer as not running", async () => {
    const server = await fake();
    const baseUrl = `${server.host}/v1`;
    await server.close();
    const engine = new OpenAICompatibleEngine({ endpoint: { baseUrl, apiKey: null } });
    const status = await engine.status();
    assert.equal(status.code, EngineStatusCode.NotRunning);
    assert.match(status.detail ?? "", /127\.0\.0\.1/);
  });

  it("forgets the old endpoint's models when pointed at another", async () => {
    const first = await fake({ openaiModels: [{ id: "first-model" }] });
    const second = await fake({ openaiModels: [{ id: "second-model" }] });
    const engine = engineFor(first);
    assert.equal(await engine.defaultModel(), "first-model");
    engine.configure({ baseUrl: `${second.host}/v1`, apiKey: null });
    assert.equal(await engine.defaultModel(), "second-model");
    engine.configure(null);
    assert.equal((await engine.status()).code, EngineStatusCode.NotInstalled);
  });
});

describe("openai-compatible endpoint completions (real pi-ai over real HTTP)", () => {
  it("streams a turn from the endpoint with the key attached", async () => {
    const server = await fake({
      openaiModels: [{ id: "remote-coder" }],
      requireBearer: "sk-local-test",
      replies: [{ text: "Hello from the GPU box." }],
    });
    const deltas: string[] = [];
    const response = await engineFor(server, "sk-local-test").complete({
      model: "remote-coder",
      messages: [{ role: "user", content: "hi" }],
      onDelta: (delta) => deltas.push(delta),
    });
    assert.equal(response.message.content, "Hello from the GPU box.");
    assert.equal(deltas.join(""), "Hello from the GPU box.");
    const sent = server.requests.find((r) => r.path.startsWith("/v1/chat/completions"));
    assert.ok(sent);
    assert.equal((sent.body as { model?: string }).model, "remote-coder");
  });

  it("assembles tool calls with ids named for this engine", async () => {
    const server = await fake({
      openaiModels: [{ id: "remote-coder" }],
      replies: [{ toolCalls: [{ id: "", name: "write_file", arguments: { path: "a.js" } }] }],
    });
    const response = await engineFor(server).complete({
      model: "remote-coder",
      messages: [{ role: "user", content: "write" }],
      tools: [{ name: "write_file", description: "write", parameters: { type: "object", properties: {} } }],
    });
    const call = response.message.tool_calls?.[0];
    assert.equal(call?.name, "write_file");
    assert.deepEqual(call?.arguments, { path: "a.js" });
  });

  it("refuses tools for a model the endpoint says cannot call them, before asking it", async () => {
    const server = await fake({
      openaiModels: [{ id: "chat-only", supported_parameters: ["temperature", "max_tokens"] }],
    });
    await assert.rejects(
      engineFor(server).complete({
        model: "chat-only",
        messages: [{ role: "user", content: "use a tool" }],
        tools: [{ name: "probe", description: "probe", parameters: { type: "object", properties: {} } }],
      }),
      /tool.*not supported/,
    );
    assert.equal(server.requests.filter((r) => r.path.includes("chat/completions")).length, 0);
  });

  it("fails as unavailable, not as a broken engine, when no endpoint is configured", async () => {
    await assert.rejects(
      new OpenAICompatibleEngine().complete({ model: "x", messages: [{ role: "user", content: "hi" }] }),
      (err: unknown) => err instanceof EngineError && err.kind === EngineFailureKind.Unavailable,
    );
  });

  it("says a model the endpoint no longer serves is missing", async () => {
    const server = await fake({
      openaiModels: [{ id: "gone" }],
      replies: [{ httpStatus: 404, body: '{"error":"model not found"}' }],
    });
    await assert.rejects(
      engineFor(server).complete({ model: "gone", messages: [{ role: "user", content: "hi" }] }),
      /gone.*endpoint/,
    );
  });
});
