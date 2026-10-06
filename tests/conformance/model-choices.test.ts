import assert from "node:assert/strict";
import { test } from "node:test";
import {
  toChoices,
  resolveChoice,
  effectiveEffort,
  withRoleEfforts,
  nearestEffort,
  effortScale,
  unifiedEffort,
} from "../../src/renderer/model-choices.ts";
import type { EngineDescriptor } from "../../src/renderer/types.ts";
const model = (id: string, label = id, efforts = ["low", "medium", "high"], defaultEffort = "medium") => ({
  id,
  label,
  efforts,
  defaultEffort,
  contextWindow: 200000,
  supportsTools: true,
  supportsVision: true,
});
const engines: EngineDescriptor[] = [
  {
    id: "bonsai",
    label: "Bonsai",
    kind: "direct",
    status: { code: "ready", detail: "Fixture ready" },
    supportsSessions: true,
    defaultModel: null,
    models: [model("bonsai-pq", "Bonsai 2 27B · PQ2_0", ["low", "medium", "high", "max"], "low")],
  },
  {
    id: "ollama",
    label: "Local model (Ollama)",
    kind: "direct",
    status: { code: "not_running", detail: "Fixture unavailable" },
    defaultModel: null,
    models: [],
  },
  {
    id: "claude-code",
    label: "Claude Code",
    kind: "delegated",
    status: { code: "ready", detail: "Fixture ready" },
    defaultModel: null,
    models: [
      model("default"),
      model("claude-fable-5-1", "Fable 5.1"),
      model("opus", "Opus 5"),
      model("sonnet", "Sonnet 5"),
    ],
  },
  {
    id: "codex",
    label: "Codex",
    kind: "delegated",
    status: { code: "ready", detail: "Fixture ready" },
    defaultModel: null,
    models: [model("default"), model("gpt-6-astra", "GPT-6-Astra"), model("gpt-5.6-sol", "GPT-5.6-Sol")],
  },
];
test("picker offers provider defaults, concrete models and installed locals", () => {
  const choices = toChoices(engines);
  assert.deepEqual(
    choices.map((c) => c.name),
    ["Bonsai 2 27B · PQ2_0", "default", "Fable 5.1", "Opus 5", "Sonnet 5", "default", "GPT-6-Astra", "GPT-5.6-Sol"],
  );
  assert.equal(toChoices([{ ...engines[1]!, status: { code: "ready", detail: "Fixture ready" } }]).length, 0);
  assert.equal(choices[0]!.defaultEffort, "low");
  assert.ok(choices.slice(1).every((c) => c.defaultEffort === "medium"));
});
test("saved provider defaults resolve within that provider and explicit picks remain selected", () => {
  const choices = toChoices(engines);
  assert.equal(resolveChoice(choices, "claude-code::")?.key, "claude-code::default");
  assert.equal(resolveChoice(choices, "codex::default")?.key, "codex::default");
  assert.equal(resolveChoice(choices, "claude-code::sonnet")?.key, "claude-code::sonnet");
});
test("aliases and pinned versions remain separate in the picker and run", () => {
  const claude = {
    ...engines[2]!,
    models: [
      model("claude-opus-5-5", "Opus 5.5"),
      { ...model("opus", "Opus"), aliasOf: "claude-opus-5-5" },
      model("sonnet", "Sonnet 5"),
    ],
  };
  const choices = toChoices([claude]);
  assert.deepEqual(
    choices.map((c) => c.name),
    ["Claude Code default", "Opus 5.5", "Opus", "Sonnet 5"],
  );
  assert.equal(resolveChoice(choices, "claude-code::opus")?.key, "claude-code::opus");
  const roles = withRoleEfforts(
    { planner: "sonnet", builder: "opus", judge: "claude-opus-5-5" },
    choices,
    "claude-code",
    "high",
  );
  assert.equal(roles.builder, "opus");
  assert.equal(roles.judge, "claude-opus-5-5");
  // Without the model it names, an alias is listed on its own.
  assert.deepEqual(
    toChoices([{ ...claude, models: [{ ...model("opus", "Opus"), aliasOf: "claude-opus-5-5" }] }]).map((c) => c.name),
    ["Claude Code default", "Opus"],
  );
});
test("picker groups models by who makes them", () => {
  assert.deepEqual(
    [...new Set(toChoices(engines).map((c) => c.group))],
    ["Local models", "Claude models", "ChatGPT models"],
  );
});
test("an OpenAI-compatible endpoint's models sit under their own header, tagged as a server's", () => {
  const endpoint: EngineDescriptor = {
    id: "openai-compatible",
    label: "OpenAI-compatible endpoint",
    kind: "direct",
    status: { code: "ready", detail: "2 model(s) at http://gpu-box:1234/v1" },
    defaultModel: null,
    models: [model("qwen3-coder-30b"), { ...model("chat-only"), supportsTools: false }],
  };
  const choices = toChoices([engines[0]!, endpoint]);
  assert.deepEqual(
    choices.map((c) => [c.key, c.group, c.tag, c.disabled]),
    [
      ["bonsai::bonsai-pq", "Local models", "local", false],
      ["openai-compatible::qwen3-coder-30b", "Server models", "server", false],
      ["openai-compatible::chat-only", "Server models", "no tools", true],
    ],
  );
  assert.equal(toChoices([{ ...endpoint, status: { code: "not_running", detail: "no answer" } }]).length, 0);
});
test("one effort serves every role at the closest level each model accepts", () => {
  const choices = toChoices(engines),
    selected = resolveChoice(choices, "codex::gpt-6-astra");
  assert.equal(effectiveEffort(selected, null), "medium");
  assert.equal(effectiveEffort(selected, "low"), "low");
  // Saved per-role efforts from earlier builds no longer override the one choice.
  const roles = withRoleEfforts(
    {
      planner: "gpt-6-astra",
      builder: "opus",
      judge: "gpt-5.6-sol",
      engines: { builder: "claude-code" },
      efforts: { judge: "low" },
    },
    choices,
    "codex",
    null,
  );
  assert.deepEqual(roles.efforts, { planner: "medium", builder: "medium", judge: "medium" });
  const migrated = withRoleEfforts(
    { planner: "claude-fable-5-1", builder: "default", judge: "default" },
    choices,
    "claude-code",
    "medium",
  );
  assert.equal(migrated.builder, undefined);
  assert.equal(migrated.judge, undefined);
  assert.deepEqual(migrated.efforts, { planner: "medium", builder: "medium", judge: "medium" });
  const mixed = withRoleEfforts(
    { planner: "bonsai-pq", builder: "bonsai-pq", judge: "bonsai-pq" },
    choices,
    "bonsai",
    "medium",
  );
  assert.equal(mixed.efforts?.planner, "medium");
});
test("an effort a model lacks becomes its nearest level, the faster one on a tie", () => {
  assert.equal(nearestEffort("ultra", ["low", "medium", "high", "max"]), "max");
  assert.equal(nearestEffort("xhigh", ["low", "medium", "high", "max"]), "high");
  assert.equal(nearestEffort("max", ["minimal", "low", "medium", "high", "xhigh"]), "xhigh");
  assert.equal(nearestEffort("minimal", ["low", "medium", "high"]), "low");
  assert.equal(nearestEffort("high", []), undefined);
  assert.equal(nearestEffort(null, ["low"]), undefined);
});
test("the effort scale is the orchestrator's own, and falls back to the roles only without one", () => {
  const astra = {
    key: "codex::a",
    name: "A",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultEffort: "high",
  };
  const opus = { key: "claude-code::o", name: "O", efforts: ["low", "medium", "high", "max"], defaultEffort: "high" };
  const local = { key: "ollama::l", name: "L" };
  assert.deepEqual(effortScale(astra, [opus]), astra.efforts);
  assert.deepEqual(effortScale(local, [opus, astra]), ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.deepEqual(effortScale(local, []), []);
  assert.equal(unifiedEffort(astra.efforts, "ultra", astra), "ultra");
  assert.equal(unifiedEffort(opus.efforts, "ultra", opus), "high");
  assert.equal(unifiedEffort(["low", "medium"], null, { key: "x", name: "x", efforts: ["low", "medium"] }), undefined);
  assert.equal(unifiedEffort([], "high", local), undefined);
});

test("explicit role models survive missing catalogs and authentication transitions", () => {
  const requested = { planner: "gpt-6-sol", builder: "gpt-6-sol", judge: "gpt-6-sol" };
  const provider = engines.find((engine) => engine.id === "codex");
  assert.ok(provider);
  for (const code of ["ready", "needs_login"] as const) {
    const choices = toChoices([{ ...provider, status: { code, detail: "fixture" } }]);
    const actual = withRoleEfforts(requested, choices, provider.id, "high");
    assert.equal(actual.planner, requested.planner);
    assert.equal(actual.builder, requested.builder);
    assert.equal(actual.judge, requested.judge);
    assert.equal(resolveChoice(choices, "codex::gpt-6-sol")?.key, "codex::gpt-6-sol");
    assert.equal(resolveChoice(choices, "codex::gpt-6-sol")?.disabled, true);
  }
});

test("a sign-in failure preserves known model names", () => {
  const provider = engines.find((engine) => engine.id === "codex");
  assert.ok(provider);
  const choices = toChoices([{ ...provider, status: { code: "needs_login", detail: "Sign in" } }]);
  assert.deepEqual(
    choices.map((row) => row.name),
    ["default", "GPT-6-Astra", "GPT-5.6-Sol"],
  );
  assert.ok(choices.every((row) => row.disabled));
});

import { composerSendOptions, resolveComposerModel } from "../../src/renderer/chat/use-composer-model.ts";

/** A subscription whose catalog names its default model, as Claude Code and Codex now do. */
const catalogued: EngineDescriptor[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    kind: "delegated",
    status: { code: "ready", detail: "Fixture ready" },
    catalog: { state: "ready", revision: 1, refreshing: false },
    defaultModel: null,
    models: [
      { ...model("default", "Claude Code default"), resolvedModel: "claude-opus-5-5" },
      {
        ...model("opus", "Opus 5.5", ["low", "high"], "high"),
        resolvedModel: "claude-opus-5-5",
        providerDefault: true,
      },
      { ...model("claude-fable-5-1", "Fable 5.1"), resolvedModel: "claude-fable-5-1" },
      { ...model("haiku", "Haiku"), resolvedModel: "claude-haiku-4-5-20251001" },
      { ...model("claude-opus-5", "Opus 5"), resolvedModel: "claude-opus-5" },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    kind: "delegated",
    status: { code: "ready", detail: "Fixture ready" },
    catalog: { state: "ready", revision: 1, refreshing: false },
    defaultModel: null,
    models: [
      model("default", "Codex default"),
      { ...model("gpt-6.1-sol", "GPT-6.1-Sol"), providerDefault: true },
      model("gpt-6-luna", "GPT-6-Luna"),
      model("gpt-5.6-terra", "GPT-5.6-Terra"),
    ],
  },
];

test("a catalog that names its default lists that model instead of a default row", () => {
  const choices = toChoices(catalogued);
  assert.deepEqual(
    choices.map((c) => c.name),
    ["Opus 5.5", "Fable 5.1", "Haiku 4.5", "Opus 5", "GPT-6.1-Sol", "GPT-6-Luna", "GPT-5.6-Terra"],
  );
  assert.ok(choices.every((c) => c.detail === undefined));
  assert.deepEqual(
    choices.filter((c) => c.hidden).map((c) => c.key),
    ["claude-code::haiku", "claude-code::claude-opus-5", "codex::gpt-5.6-terra"],
  );
  // A saved default or an unset pick is the model the provider names.
  assert.equal(resolveChoice(choices, "claude-code::default")?.key, "claude-code::opus");
  assert.equal(resolveChoice(choices, "claude-code::")?.key, "claude-code::opus");
  assert.equal(resolveChoice(choices, "codex::default")?.key, "codex::gpt-6.1-sol");
  // A hidden model stays a working pick.
  assert.equal(resolveChoice(choices, "claude-code::haiku")?.disabled, false);
});

test("Settings choices show or hide subscription models", () => {
  const choices = toChoices(catalogued, { "claude-code": { haiku: true, "claude-fable-5-1": false } });
  const hidden = (key: string) => choices.find((c) => c.key === key)?.hidden === true;
  assert.equal(hidden("claude-code::haiku"), false);
  assert.equal(hidden("claude-code::claude-fable-5-1"), true);
  assert.equal(hidden("codex::gpt-5.6-terra"), true);
});

test("an unset pick shows the provider's default and runs it; roles name it too", () => {
  const view = resolveComposerModel({
    studio: false,
    engines: catalogued,
    modelKey: "claude-code::default",
    effort: null,
    roles: { builder: "default", judge: "default" },
  });
  assert.equal(view.selected, "claude-code::opus");
  assert.equal(view.effort, "high");
  assert.equal(view.roles?.planner, "opus");
  assert.equal(view.roles?.builder, "opus");
  const sent = composerSendOptions({ ...view, preferences: {} }, view.selected, { autopilot: false });
  assert.equal(sent.model, "opus");
});

test("while the catalog is loading the provider default row stays, saying so", () => {
  const loading: EngineDescriptor = {
    ...catalogued[0]!,
    catalog: { state: "loading", revision: 0, refreshing: true },
    models: [model("default", "Claude Code default")],
  };
  const choices = toChoices([loading]);
  assert.deepEqual(
    choices.map((c) => [c.key, c.detail]),
    [["claude-code::default", "Loading models…"]],
  );
});

test("a saved model the CLI now lists under another id of the same model still resolves", () => {
  // A warm Claude cache lists Fable as `claude-fable-5-1`; a cold one as `claude-fable-5-1[1m]`.
  const warm = toChoices(catalogued);
  const fromCold = resolveChoice(warm, "claude-code::claude-fable-5-1[1m]");
  assert.equal(fromCold?.key, "claude-code::claude-fable-5-1");
  assert.equal(fromCold?.disabled, false);
  const roles = withRoleEfforts({ planner: "claude-fable-5-1[1m]" }, warm, "claude-code", null);
  assert.equal(roles.planner, "claude-fable-5-1", "the send names the id the CLI lists now");
  const cold = toChoices([
    {
      ...catalogued[0]!,
      models: [
        { ...model("default", "Claude Code default"), resolvedModel: "claude-opus-5-5" },
        { ...model("opus", "Opus"), resolvedModel: "claude-opus-5-5", providerDefault: true },
        { ...model("claude-fable-5-1[1m]", "Fable"), resolvedModel: "claude-fable-5-1" },
      ],
    },
  ]);
  assert.equal(resolveChoice(cold, "claude-code::claude-fable-5-1")?.key, "claude-code::claude-fable-5-1[1m]");
  // A pinned version the CLI resolves an alias to is that alias's model.
  assert.equal(resolveChoice(cold, "claude-code::claude-opus-5-5")?.key, "claude-code::opus");
  // A model the CLI no longer lists stays unavailable, and another provider's row never stands in.
  assert.equal(resolveChoice(cold, "claude-code::claude-opus-4-1")?.disabled, true);
  assert.equal(resolveChoice(warm, "codex::claude-fable-5-1")?.disabled, true);
});
