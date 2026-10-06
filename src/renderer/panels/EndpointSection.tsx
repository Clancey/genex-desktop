/** Settings → Local Models → a server on another computer: any OpenAI-compatible endpoint. */
import type { FormEvent, JSX } from "react";
import { useEffect, useId, useState } from "react";
import { EngineStatusCode } from "../../shared/engine-descriptor.ts";
import { errorMessage } from "../../shared/errors.ts";
import {
  EndpointUrlProblem,
  normalizeEndpointUrl,
  type OpenAIEndpointSaveResult,
  type OpenAIEndpointView,
} from "../../shared/openai-endpoint.ts";
import type { EngineDescriptor } from "../types.ts";
import { Button } from "../ui/Button.tsx";

const WORDS = {
  title: "Models on another computer",
  hint: "Use any OpenAI-compatible server, such as LM Studio, vLLM, llama.cpp or Ollama on another machine. Genex lists the models it serves.",
  address: "Server address",
  addressPlaceholder: "http://192.168.1.20:1234/v1",
  apiKey: "API key",
  apiKeyPlaceholder: "Optional",
  apiKeySaved: "Saved. Type a new key to replace it.",
  clearKey: "Remove key",
  save: "Save",
  saving: "Saving…",
  remove: "Remove server",
  locked: "Keychain is unavailable, so an API key can't be saved. Servers without a key still work.",
  found: (count: number) => (count === 1 ? "Found 1 model." : `Found ${count} models.`),
  noTools: "no tools",
  problem: {
    [EndpointUrlProblem.Empty]: "Enter the server's address.",
    [EndpointUrlProblem.TooLong]: "That address is too long.",
    [EndpointUrlProblem.Invalid]: "Enter a full address, like http://192.168.1.20:1234/v1.",
    [EndpointUrlProblem.Protocol]: "The address must start with http:// or https://.",
    [EndpointUrlProblem.Credentials]: "Put the key in API key, not in the address.",
    [EndpointUrlProblem.QueryOrFragment]: "Remove the ? or # part of the address.",
  } satisfies Record<EndpointUrlProblem, string>,
} as const;

const INPUT_CLASS =
  "h-8 w-full min-w-0 rounded-control border border-input bg-field px-2.5 font-mono text-sm text-ink outline-none placeholder:text-muted-foreground focus:border-accent-primary";

/** What saving the endpoint last said: how many models it found, or why it could not list them. */
function resultWords(result: OpenAIEndpointSaveResult | null): string | null {
  if (!result?.endpoint.baseUrl) return null;
  return result.error ?? (result.modelCount === null ? null : WORDS.found(result.modelCount));
}

/** The engine's own status line, when it is not simply ready. */
function statusWords(engine: EngineDescriptor | undefined): string | null {
  if (!engine || engine.status.code === EngineStatusCode.Ready) return null;
  return [engine.status.detail, engine.status.remedy].filter(Boolean).join(" — ");
}

/** The models the saved endpoint serves, as the picker will list them. */
function ServedModels({ engine }: { engine: EngineDescriptor | undefined }): JSX.Element | null {
  if (!engine || engine.status.code !== EngineStatusCode.Ready || engine.models.length === 0) return null;
  return (
    <ul className="flex flex-col">
      {engine.models.map((model) => (
        <li key={model.id} className="flex items-center gap-4 border-b border-border py-2">
          <span className="min-w-0 flex-1 break-all font-mono text-sm text-ink">{model.id}</span>
          {!model.supportsTools && <span className="text-body-sm text-muted-foreground">{WORDS.noTools}</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * The address and optional key of the person's OpenAI-compatible server. The key goes to main and
 * stays there; this form only learns whether one is saved.
 */
export function EndpointSection({
  engine,
  onEnginesRefresh,
}: {
  engine: EngineDescriptor | undefined;
  onEnginesRefresh: () => Promise<void> | void;
}): JSX.Element {
  const [saved, setSaved] = useState<OpenAIEndpointView | null>(null);
  const [address, setAddress] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OpenAIEndpointSaveResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const addressId = useId();
  const keyId = useId();

  useEffect(() => {
    let live = true;
    void window.studio
      .openAIEndpoint()
      .then((view) => {
        if (!live) return;
        setSaved(view);
        setAddress(view.baseUrl ?? "");
      })
      .catch((err: unknown) => live && setFailure(errorMessage(err)));
    return () => {
      live = false;
    };
  }, []);

  const parsed = normalizeEndpointUrl(address);
  const problem = address.trim() && !parsed.ok ? WORDS.problem[parsed.problem] : null;

  const save = async (update: Parameters<typeof window.studio.saveOpenAIEndpoint>[0]): Promise<void> => {
    setBusy(true);
    setFailure(null);
    setResult(null);
    try {
      const next = await window.studio.saveOpenAIEndpoint(update);
      setSaved(next.endpoint);
      setAddress(next.endpoint.baseUrl ?? "");
      setApiKey("");
      setResult(next);
      await onEnginesRefresh();
    } catch (err) {
      setFailure(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!parsed.ok || busy) return;
    void save({ baseUrl: parsed.baseUrl, ...(apiKey ? { apiKey } : {}) });
  };

  const message = failure ?? resultWords(result) ?? statusWords(saved?.baseUrl ? engine : undefined);
  return (
    <form onSubmit={submit} data-openai-endpoint className="flex flex-col gap-2 pt-6">
      <span className="text-sm font-medium text-ink">{WORDS.title}</span>
      <p className="text-body-sm text-muted-foreground">{WORDS.hint}</p>
      <label htmlFor={addressId} className="pt-1 text-body-sm text-muted-foreground">
        {WORDS.address}
      </label>
      <input
        id={addressId}
        value={address}
        onChange={(event) => setAddress(event.target.value)}
        placeholder={WORDS.addressPlaceholder}
        autoComplete="off"
        spellCheck={false}
        className={INPUT_CLASS}
      />
      {problem && <p className="text-body-sm text-red">{problem}</p>}
      <label htmlFor={keyId} className="pt-1 text-body-sm text-muted-foreground">
        {WORDS.apiKey}
      </label>
      <input
        id={keyId}
        type="password"
        value={apiKey}
        onChange={(event) => setApiKey(event.target.value)}
        placeholder={saved?.hasApiKey ? WORDS.apiKeySaved : WORDS.apiKeyPlaceholder}
        disabled={saved?.canStoreApiKey === false}
        autoComplete="off"
        spellCheck={false}
        className={INPUT_CLASS}
      />
      {saved?.canStoreApiKey === false && <p className="text-body-sm text-muted-foreground">{WORDS.locked}</p>}
      <div className="flex gap-2 pt-1">
        <Button type="submit" disabled={!parsed.ok || busy}>
          {busy ? WORDS.saving : WORDS.save}
        </Button>
        {saved?.baseUrl && saved.hasApiKey && (
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => void save({ baseUrl: saved.baseUrl, apiKey: null })}
          >
            {WORDS.clearKey}
          </Button>
        )}
        {saved?.baseUrl && (
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void save({ baseUrl: null })}>
            {WORDS.remove}
          </Button>
        )}
      </div>
      {message && (
        <p role={failure || result?.error ? "alert" : "status"} className="text-body-sm text-muted-foreground">
          {message}
        </p>
      )}
      <ServedModels engine={saved?.baseUrl ? engine : undefined} />
    </form>
  );
}
