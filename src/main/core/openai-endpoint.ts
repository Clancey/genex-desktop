/**
 * Settings → Local Models → OpenAI-compatible endpoint: the address the person typed lives in a
 * plain file under userData, the optional API key only in the OS secret store. Whatever is saved
 * is applied to the endpoint engine at launch and after every change. The key never leaves main:
 * the renderer sees only whether one is saved.
 */
import { atomicWriteJson, isJsonObject, readJsonIfExists } from "../../substrate/fsx.ts";
import type { SecretPort } from "../../substrate/mcp/store.ts";
import type { OpenAIEndpointConfig } from "../../substrate/engines/openai-compatible.ts";
import {
  MAX_ENDPOINT_API_KEY_CHARS,
  normalizeEndpointUrl,
  type OpenAIEndpointView,
} from "../../shared/openai-endpoint.ts";
import { rm } from "node:fs/promises";

/** The secret store key the endpoint's API key is kept under. */
const API_KEY_SECRET = "openai-endpoint.api-key";
/** What a key may contain: printable ASCII, so it cannot smuggle a header line or control bytes. */
const API_KEY_PATTERN = /^[\x21-\x7e]+$/;

const MESSAGE = {
  NotAnUpdate: "The endpoint settings are not in the expected shape.",
  BadAddress: (problem: string) => `That endpoint address can't be used (${problem}).`,
  BadKey: "That API key can't be used: it must be printable characters without spaces.",
  KeyTooLong: "That API key is too long.",
  Locked: "The API key can't be saved because this Mac's secret storage (Keychain) is locked or unavailable.",
} as const;

/** What {@link OpenAIEndpointSettings} needs from the host. */
export interface OpenAIEndpointSettingsOptions {
  /** The plain JSON file holding the address. */
  file: string;
  /** The secret store, or null when it is locked; opened lazily, only once an endpoint exists. */
  secrets: () => Promise<SecretPort | null>;
  /** Point the endpoint engine at the saved endpoint, or at none. */
  apply: (config: OpenAIEndpointConfig | null) => void;
}

interface ParsedUpdate {
  baseUrl: string | null;
  apiKey: string | null | undefined;
}

function parseKey(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") throw new Error(MESSAGE.BadKey);
  if (value.length > MAX_ENDPOINT_API_KEY_CHARS) throw new Error(MESSAGE.KeyTooLong);
  if (!API_KEY_PATTERN.test(value)) throw new Error(MESSAGE.BadKey);
  return value;
}

/** The renderer's update, validated before anything is written. */
function parseUpdate(update: unknown): ParsedUpdate {
  if (!isJsonObject(update)) throw new Error(MESSAGE.NotAnUpdate);
  const apiKey = parseKey(update.apiKey);
  if (update.baseUrl === null) return { baseUrl: null, apiKey: null };
  const url = normalizeEndpointUrl(update.baseUrl);
  if (!url.ok) throw new Error(MESSAGE.BadAddress(url.problem));
  return { baseUrl: url.baseUrl, apiKey };
}

/** The saved address, or null when none is saved or the file is not one this app wrote. */
async function readSavedUrl(file: string): Promise<string | null> {
  const saved = await readJsonIfExists<unknown>(file).catch(() => null);
  if (!isJsonObject(saved)) return null;
  const url = normalizeEndpointUrl(saved.baseUrl);
  return url.ok ? url.baseUrl : null;
}

/** The person's endpoint as saved, applied to the engine. */
export class OpenAIEndpointSettings {
  readonly #options: OpenAIEndpointSettingsOptions;
  #baseUrl: string | null = null;
  #apiKey: string | null = null;
  #secrets: Promise<SecretPort | null> | null = null;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: OpenAIEndpointSettingsOptions) {
    this.#options = options;
  }

  #secretPort(): Promise<SecretPort | null> {
    this.#secrets ??= this.#options.secrets().catch(() => null);
    return this.#secrets;
  }

  /** Read what was saved and point the engine at it. */
  async load(): Promise<void> {
    this.#baseUrl = await readSavedUrl(this.#options.file);
    this.#apiKey = null;
    if (this.#baseUrl) {
      const secrets = await this.#secretPort();
      this.#apiKey = (await secrets?.get(API_KEY_SECRET).catch(() => null)) ?? null;
    }
    this.#apply();
  }

  /** What Settings shows. */
  async view(): Promise<OpenAIEndpointView> {
    return {
      baseUrl: this.#baseUrl,
      hasApiKey: this.#apiKey !== null,
      canStoreApiKey: (await this.#secretPort()) !== null,
    };
  }

  /** The saved key, for the event log's redactor. */
  secretValues(): string[] {
    return this.#apiKey ? [this.#apiKey] : [];
  }

  /** Validate and save a change, then point the engine at it. Nothing is written for bad input. */
  save(update: unknown): Promise<OpenAIEndpointView> {
    const next = this.#tail.then(() => this.#save(parseUpdate(update)));
    this.#tail = next.catch(() => {});
    return next;
  }

  async #save(update: ParsedUpdate): Promise<OpenAIEndpointView> {
    if (update.baseUrl === null) return this.#forget();
    const apiKey = update.apiKey === undefined ? this.#apiKey : update.apiKey;
    await this.#storeKey(update.apiKey);
    await atomicWriteJson(this.#options.file, { baseUrl: update.baseUrl });
    this.#baseUrl = update.baseUrl;
    this.#apiKey = apiKey;
    this.#apply();
    return this.view();
  }

  /** Store, clear or keep the key, before the address is written so a failure saves nothing. */
  async #storeKey(apiKey: string | null | undefined): Promise<void> {
    if (apiKey === undefined) return;
    const secrets = await this.#secretPort();
    if (apiKey === null) {
      await secrets?.delete(API_KEY_SECRET);
      return;
    }
    if (!secrets) throw new Error(MESSAGE.Locked);
    await secrets.set(API_KEY_SECRET, apiKey);
  }

  async #forget(): Promise<OpenAIEndpointView> {
    const secrets = await this.#secretPort();
    await secrets?.delete(API_KEY_SECRET);
    await rm(this.#options.file, { force: true });
    this.#baseUrl = null;
    this.#apiKey = null;
    this.#apply();
    return this.view();
  }

  #apply(): void {
    this.#options.apply(this.#baseUrl ? { baseUrl: this.#baseUrl, apiKey: this.#apiKey } : null);
  }
}
