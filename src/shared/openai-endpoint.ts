/**
 * The person's OpenAI-compatible model endpoint (LM Studio, vLLM, llama.cpp server, LocalAI, an
 * Ollama on another machine…): the address the app lists `/models` from and sends completions to.
 * Shared by main (validation before saving) and the renderer (validation while typing).
 */

/** The longest endpoint address accepted. */
export const MAX_ENDPOINT_URL_CHARS = 2048;
/** The longest API key accepted. */
export const MAX_ENDPOINT_API_KEY_CHARS = 4096;
/** The path an address without one gets: every OpenAI-compatible server serves `/v1`. */
const DEFAULT_API_PATH = "/v1";

/** Why an endpoint address was refused. */
export const EndpointUrlProblem = {
  Empty: "empty",
  TooLong: "too-long",
  Invalid: "invalid",
  Protocol: "protocol",
  Credentials: "credentials",
  QueryOrFragment: "query-or-fragment",
} as const;
export type EndpointUrlProblem = (typeof EndpointUrlProblem)[keyof typeof EndpointUrlProblem];

/** A validated endpoint address, or why it is not one. */
export type EndpointUrlResult = { ok: true; baseUrl: string } | { ok: false; problem: EndpointUrlProblem };

/**
 * The canonical base URL for what the person typed: http or https only, no embedded credentials
 * (the key has its own secret field), no query or fragment, trailing slashes trimmed and `/v1`
 * supplied when no path is given.
 */
export function normalizeEndpointUrl(input: unknown): EndpointUrlResult {
  if (typeof input !== "string" || input.trim() === "") return { ok: false, problem: EndpointUrlProblem.Empty };
  const text = input.trim();
  if (text.length > MAX_ENDPOINT_URL_CHARS) return { ok: false, problem: EndpointUrlProblem.TooLong };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, problem: EndpointUrlProblem.Invalid };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, problem: EndpointUrlProblem.Protocol };
  if (url.username || url.password) return { ok: false, problem: EndpointUrlProblem.Credentials };
  if (url.search || url.hash || text.includes("?") || text.includes("#")) {
    return { ok: false, problem: EndpointUrlProblem.QueryOrFragment };
  }
  if (!url.hostname) return { ok: false, problem: EndpointUrlProblem.Invalid };
  const path = url.pathname.replace(/\/+$/, "");
  return { ok: true, baseUrl: `${url.origin}${path || DEFAULT_API_PATH}` };
}

/** What Settings shows about the endpoint. The API key itself never leaves main. */
export interface OpenAIEndpointView {
  baseUrl: string | null;
  hasApiKey: boolean;
  /** False when the OS secret store is locked, so a key cannot be saved. */
  canStoreApiKey: boolean;
}

/**
 * A change to the endpoint. `baseUrl: null` forgets the endpoint and its key. `apiKey` left out
 * keeps the saved key, `null` removes it, a string replaces it.
 */
export interface OpenAIEndpointUpdate {
  baseUrl: string | null;
  apiKey?: string | null;
}

/** The saved endpoint and what its `/models` answered right after saving. */
export interface OpenAIEndpointSaveResult {
  endpoint: OpenAIEndpointView;
  /** How many models the endpoint listed, or null when it could not be reached. */
  modelCount: number | null;
  /** Why the endpoint could not be listed; the endpoint is saved regardless. */
  error: string | null;
}
