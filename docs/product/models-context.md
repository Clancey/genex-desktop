# Models and context

## Selecting a model

The model button opens Main agent, Workers and Reviewers, grouped by provider. Add more models
opens setup. Blocked plans retain the request and offer model settings or retry. Fast mode is hidden.

Claude Code and Codex discover models without generating. The list names each family's newest
model of the newest generation; older ones are switched on in Settings, and a model
in use stays listed. An unset pick shows and runs the provider's named default, else a default row.
Aliases follow the CLI; explicit versions stay pinned.

Settings shows CLI versions; connected rows list picker models; Account rechecks
(refreshing models) or updates the CLI after provider work. Failed refreshes offer Try again,
keeping names stale. Unavailable picks block sends; without models, Connect AI model replaces the
model pill. New models may need a CLI update; listing does not prove access.

Each chat keeps its model, effort and Loop; fresh games inherit the last picks. One effort
serves every role: the slider offers the main agent's levels and others use their closest level.
Workers and Reviewers run only in Loop. A new main-agent model keeps worker/reviewer picks.

Local Models manages Bonsai/Ollama downloads and an
[OpenAI-compatible server](../local-models.md#a-server-on-another-computer).

## What the model knows

The context ring shows reported orchestrator usage and capacity; unknown stays unknown. Its panel
offers Compact now, also typed as `/compact` (Claude Code and Codex use
[their own](../connections-and-context.md#compact-now); others hand over); every provider, workers
included, also compacts automatically at its own point. Then plan limits ([details](../connections-and-context.md#plan-limits)).

Ollama uses a loaded model's reported runtime context, not its theoretical maximum. An unloaded
model's planning budget is an estimate marked unknown. Tools and images require reported
capability; unsupported requests fail before inference.

Game files, instructions, reference images and enabled tools contribute through their
channels ([tool setup](assets-plugins.md)). Enabling a plugin never signs in or authorizes paid
generation. Credentials stay in protected storage, never in messages, logs or documentation.

Studio's assistant keeps its own model, effort and context; its composer has images, models,
effort and Send/Stop only.

## Permissions

Every chat's pill after Mode picks **Auto** (Recommended; stops only dangerous actions),
**Manual**, **Accept edits**, **Plan** or **Bypass permissions** (confirmed first; Rewind restores
only the game folder); modes the engine cannot honour are greyed with why (Codex: Auto, Plan,
Bypass; Bonsai: no Bypass; Ollama: Auto). A chat keeps its mode; new chats take the last Auto,
Manual or Accept edits. Claude's chat and build lead work anywhere on your Mac with your access;
unattended builds keep their sandbox ([details](../tool-permissions.md)).

Adopted folders do not supply Claude settings/hooks until explicitly trusted in Open Game.
Read deny rules also cover sensitive system/account locations. Codex read restrictions are
advisory, not whole-disk isolation.

## Where to work

Start at [ModelsSection](../../src/renderer/panels/ModelsSection.tsx) and
[PromptBar](../../src/renderer/ui/PromptBar.tsx). See [Local models](../local-models.md),
[Connections and context](../connections-and-context.md), [continuation](../conversation-coordinator.md)
and [composer design](../agent/design.md#prompt-composer).
The [judge evaluation procedure](../judge-evaluation.md) separates protocol checks from human
quality acceptance.
