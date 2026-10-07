import { EngineId } from "../../shared/providers.ts";
import { parseModelKey } from "../model-key.ts";

/** Compact now in the context panel: whether it is offered, and whether it can be pressed. */
export interface CompactControl {
  shown: boolean;
  disabled: boolean;
}

/**
 * Compact now for the chat's model: offered when its chat can be compacted — an Ollama or
 * OpenAI-compatible endpoint chat (its log is summarised) or an engine that keeps a session (the
 * session writes its handover and the next turn starts fresh). Disabled while it runs and while a turn or a build is under way.
 */
export function compactControl({
  engine,
  supportsSessions,
  compacting,
  busy,
}: {
  engine: string | null | undefined;
  supportsSessions: boolean | undefined;
  compacting: boolean;
  busy: boolean;
}): CompactControl {
  return { shown: isStudioCompacted(engine) || supportsSessions === true, disabled: compacting || busy };
}

/** Engines whose chat log the studio summarises itself rather than a provider session. */
function isStudioCompacted(engine: string | null | undefined): boolean {
  return engine === EngineId.Ollama || engine === EngineId.OpenAICompatible;
}

/** Compact now for the composer's selected model, as its context panel and its /compact read it. */
export function selectedCompact(
  models: readonly { key: string; supportsSessions?: boolean }[],
  modelKey: string | null,
  { compacting, busy }: { compacting: boolean; busy: boolean },
): CompactControl {
  const supportsSessions = models.find((model) => model.key === modelKey)?.supportsSessions;
  return compactControl({ engine: parseModelKey(modelKey).engine || null, supportsSessions, compacting, busy });
}
