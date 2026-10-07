/**
 * The model providers the app knows, in one table: the name a person says, the sign-in words and
 * install link for a subscription, how its sign-in runs, and what kind of roles it takes.
 * `EngineRegistry.describe` serves the row on each `EngineDescriptor` (`provider`), main and the
 * renderer take `SUBSCRIPTION_ENGINES` from here, and the harness seed's role tables are held to
 * it by `tests/conformance/providers.test.ts`. Adding a provider starts here
 * (docs/agent/recipes.md, "Provider or engine").
 */

/** How a subscription signs in: Claude through a piped or embedded terminal plus status polling, Codex through its native login reported from the in-app console. */
export type LoginKind = "terminal" | "console" | "none";

/**
 * Which roles a provider can run: `presets` has the model rows and single-pick presets of
 * `shared/model-roles.ts`, `sessions` can cross roles without presets, `single` runs one model.
 */
export type RoleSupport = "presets" | "sessions" | "single";

/** What the sign-in card and the Models room say for a subscription. */
export interface SignInCopy {
  /** "your Claude subscription": the thing the user already pays for. */
  readonly product: string;
  readonly card: string;
  readonly account: string;
  readonly install: string;
  /** The vendor's own install page for the CLI. */
  readonly installUrl: string;
  readonly get: string;
  readonly who: string;
}

export interface ProviderInfo {
  /** The engine id (`Engine.id`). */
  readonly id: string;
  /** The provider's name as a person says it. */
  readonly label: string;
  readonly subscription: boolean;
  readonly login: LoginKind;
  readonly roles: RoleSupport;
  /** Subscriptions only. */
  readonly signIn: SignInCopy | null;
}

/** The id of every engine the app knows (`Engine.id`). Persisted in settings and logs: never rename a value. */
export const EngineId = {
  ClaudeCode: "claude-code",
  Codex: "codex",
  Bonsai: "bonsai",
  Ollama: "ollama",
  OpenAICompatible: "openai-compatible",
} as const;
export type EngineId = (typeof EngineId)[keyof typeof EngineId];

/** Every provider, subscriptions first in preference order. */
export const PROVIDERS = [
  {
    id: EngineId.ClaudeCode,
    label: "Claude Code",
    subscription: true,
    login: "terminal",
    roles: "presets",
    signIn: {
      product: "your Claude subscription",
      card: "Use your Claude subscription",
      account: "Claude account",
      install: "Claude Code isn't installed on this Mac.",
      installUrl: "https://code.claude.com",
      get: "Install Claude Code",
      who: "Claude Code handles that part",
    },
  },
  {
    id: EngineId.Codex,
    label: "Codex",
    subscription: true,
    login: "console",
    roles: "presets",
    signIn: {
      product: "your ChatGPT subscription",
      card: "Use your ChatGPT subscription",
      account: "ChatGPT account",
      install: "Codex isn't installed on this Mac.",
      installUrl: "https://developers.openai.com/codex/cli",
      get: "Install Codex",
      who: "Codex handles that part",
    },
  },
  { id: EngineId.Bonsai, label: "Bonsai", subscription: false, login: "none", roles: "sessions", signIn: null },
  { id: EngineId.Ollama, label: "Ollama", subscription: false, login: "none", roles: "single", signIn: null },
  {
    id: EngineId.OpenAICompatible,
    label: "OpenAI-compatible",
    subscription: false,
    login: "none",
    roles: "single",
    signIn: null,
  },
] as const satisfies readonly ProviderInfo[];

type Provider = (typeof PROVIDERS)[number];
export type ProviderId = Provider["id"];
type Subscription = Extract<Provider, { subscription: true }>;
export type SubscriptionId = Subscription["id"];

const isSubscription = (provider: Provider): provider is Subscription => provider.subscription;

/** The subscription engines, in preference order — "your subscription, through their harness". */
export const SUBSCRIPTION_ENGINES: readonly SubscriptionId[] = PROVIDERS.filter(isSubscription).map(
  (provider) => provider.id,
);

/** The table row for an engine id, or undefined for an engine the table does not list. */
export function providerInfo(id: string | null | undefined): ProviderInfo | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

/** How this engine signs in; `none` for a local engine or one the table does not list. */
export function loginKind(id: string | null | undefined): LoginKind {
  return providerInfo(id)?.login ?? "none";
}
