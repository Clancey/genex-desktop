/**
 * The endpoint Settings saves: the address in a plain file, the API key only in the secret store,
 * and the engine pointed at whatever is saved. Bad input changes nothing.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { OpenAIEndpointSettings } from "../../src/main/core/openai-endpoint.ts";
import type { OpenAIEndpointConfig } from "../../src/substrate/engines/openai-compatible.ts";
import { memorySecretPort } from "../../src/substrate/mcp/store.ts";
import { tmpDir } from "../helpers/tmp.ts";

async function settingsFor(options: { locked?: boolean; values?: Map<string, string> } = {}) {
  const dir = await tmpDir("openai-endpoint-");
  const values = options.values ?? new Map<string, string>();
  const applied: Array<OpenAIEndpointConfig | null> = [];
  const file = path.join(dir, "openai-endpoint.json");
  const settings = new OpenAIEndpointSettings({
    file,
    secrets: async () => (options.locked ? null : memorySecretPort(values)),
    apply: (config) => applied.push(config),
  });
  return { settings, file, values, applied };
}

describe("openai endpoint settings", () => {
  it("starts with no endpoint and points the engine at none", async () => {
    const { settings, applied } = await settingsFor();
    await settings.load();
    assert.deepEqual(await settings.view(), { baseUrl: null, hasApiKey: false, canStoreApiKey: true });
    assert.deepEqual(applied, [null]);
  });

  it("saves the address to its file and the key only to the secret store", async () => {
    const { settings, file, values, applied } = await settingsFor();
    const view = await settings.save({ baseUrl: "http://192.168.1.20:1234/", apiKey: "sk-remote" });
    assert.deepEqual(view, { baseUrl: "http://192.168.1.20:1234/v1", hasApiKey: true, canStoreApiKey: true });
    const saved = await readFile(file, "utf8");
    assert.doesNotMatch(saved, /sk-remote/, "the key never lands in the plain file");
    assert.deepEqual([...values.values()], ["sk-remote"]);
    assert.deepEqual(applied.at(-1), { baseUrl: "http://192.168.1.20:1234/v1", apiKey: "sk-remote" });
    assert.doesNotMatch(JSON.stringify(view), /sk-remote/, "the key never goes back to the renderer");
    assert.deepEqual(settings.secretValues(), ["sk-remote"], "the key is redacted from the event log");
  });

  it("keeps the saved key when only the address changes, and clears it on request", async () => {
    const { settings, applied } = await settingsFor();
    await settings.save({ baseUrl: "http://box:1234", apiKey: "sk-remote" });
    await settings.save({ baseUrl: "http://other:8000/v1" });
    assert.deepEqual(applied.at(-1), { baseUrl: "http://other:8000/v1", apiKey: "sk-remote" });
    const view = await settings.save({ baseUrl: "http://other:8000/v1", apiKey: null });
    assert.equal(view.hasApiKey, false);
    assert.deepEqual(applied.at(-1), { baseUrl: "http://other:8000/v1", apiKey: null });
  });

  it("restores the saved endpoint and key on the next launch", async () => {
    const first = await settingsFor();
    await first.settings.save({ baseUrl: "http://box:1234", apiKey: "sk-remote" });
    const applied: Array<OpenAIEndpointConfig | null> = [];
    const again = new OpenAIEndpointSettings({
      file: first.file,
      secrets: async () => memorySecretPort(first.values),
      apply: (config) => applied.push(config),
    });
    await again.load();
    assert.deepEqual(applied, [{ baseUrl: "http://box:1234/v1", apiKey: "sk-remote" }]);
  });

  it("removing the endpoint forgets its key too", async () => {
    const { settings, values, applied } = await settingsFor();
    await settings.save({ baseUrl: "http://box:1234", apiKey: "sk-remote" });
    const view = await settings.save({ baseUrl: null });
    assert.deepEqual(view, { baseUrl: null, hasApiKey: false, canStoreApiKey: true });
    assert.equal(values.size, 0);
    assert.equal(applied.at(-1), null);
  });

  it("refuses to save a key while the secret store is locked, and saves nothing", async () => {
    const { settings, file, applied } = await settingsFor({ locked: true });
    await settings.load();
    assert.equal((await settings.view()).canStoreApiKey, false);
    await assert.rejects(settings.save({ baseUrl: "http://box:1234", apiKey: "sk-remote" }), /secret|keychain/i);
    await assert.rejects(readFile(file, "utf8"), { code: "ENOENT" });
    assert.deepEqual(applied, [null]);
    const keyless = await settings.save({ baseUrl: "http://box:1234" });
    assert.equal(keyless.baseUrl, "http://box:1234/v1", "a keyless endpoint still saves");
  });

  const hostile: Array<[string, unknown]> = [
    ["not an object", "http://box:1234"],
    ["file scheme", { baseUrl: "file:///etc/passwd" }],
    ["credentials in the address", { baseUrl: "http://u:p@box/v1" }],
    ["query in the address", { baseUrl: "http://box/v1?api_key=x" }],
    ["address not a string", { baseUrl: 7 }],
    ["key not a string", { baseUrl: "http://box:1234", apiKey: 7 }],
    ["empty key", { baseUrl: "http://box:1234", apiKey: "   " }],
    ["key with a newline", { baseUrl: "http://box:1234", apiKey: "sk\nInjected: 1" }],
    ["oversized key", { baseUrl: "http://box:1234", apiKey: "k".repeat(5000) }],
  ];
  for (const [name, update] of hostile) {
    it(`refuses ${name} without writing anything`, async () => {
      const { settings, file, values, applied } = await settingsFor();
      await assert.rejects(settings.save(update));
      await assert.rejects(readFile(file, "utf8"), { code: "ENOENT" });
      assert.equal(values.size, 0);
      assert.deepEqual(applied, []);
    });
  }
});
