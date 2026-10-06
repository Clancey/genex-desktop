/** Local Godot through the public plugin API, with a fake Godot and pre-installed web templates. */
import assert from "node:assert/strict";
import { chmod, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { startRig, type Rig } from "../helpers/studio-rig.ts";
import { tmpDir } from "../helpers/tmp.ts";

const rigs: Rig[] = [];
after(async () => {
  await Promise.all(rigs.map((rig) => rig.stop().catch(() => {})));
});

const TEMPLATE_MEMBERS = [
  "templates/version.txt",
  "templates/web_nothreads_release.zip",
  "templates/web_nothreads_debug.zip",
];
const WEB_FILES = ["index.html", "index.js", "index.wasm", "index.pck"];

/**
 * A fake Godot: answers `--version`; for a job it checks the snapshot it was given (project.godot
 * present, `.godot/` and secrets absent) and, for `export`, the templates folder, then writes what
 * the wrapper would and prints its result line. `BROKEN` makes the check report a parse error.
 */
async function fakeGodot(app: string): Promise<string> {
  const binary = path.join(app, "Contents", "MacOS", "Godot");
  await mkdir(path.dirname(binary), { recursive: true });
  const script = [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo "4.7.2.stable.official.ed1daf0bf"; exit 0; fi',
    "# argv: --headless --path <project> --script <wrapper.gd> -- <mode> ...",
    'PROJ=$3; WRAPPER=$5; while [ "$1" != "--" ]; do shift; done; shift',
    "MODE=$1",
    '[ -f "$PROJ/project.godot" ] || { echo "no project.godot in snapshot" >&2; exit 3; }',
    '[ -e "$PROJ/.godot" ] && { echo ".godot was copied" >&2; exit 3; }',
    '[ -e "$PROJ/.env" ] && { echo ".env was copied" >&2; exit 3; }',
    '[ -f "$WRAPPER" ] || { echo "no wrapper" >&2; exit 3; }',
    'if [ "$MODE" = "check" ]; then',
    '  if [ -f "$PROJ/BROKEN" ]; then',
    `    R='{"ok":false,"mode":"check","mainScene":"res://main.tscn","steps":[{"step":"scripts","exitCode":1,"issues":["SCRIPT ERROR: Parse Error: Unexpected identifier (res://player.gd:3)"]}]}'`,
    "  else",
    `    R='{"ok":true,"mode":"check","mainScene":"res://main.tscn","steps":[{"step":"import","exitCode":0,"issues":[]}]}'`,
    "  fi",
    '  printf "%s" "$R" > "$2"; echo "STUDIO_GODOT_RESULT $R"; exit 0',
    "fi",
    "HTML=$2; T=$3",
    '[ -f "$T/templates/web_nothreads_release.zip" ] || { echo \'STUDIO_GODOT_RESULT {"ok":false,"mode":"export","error":"no templates"}\'; exit 1; }',
    'echo "[preset.0]" > "$PROJ/export_presets.cfg"',
    "D=${HTML%/*}",
    `for f in ${WEB_FILES.join(" ")}; do echo "$f" > "$D/$f"; done`,
    'echo "stray" > "$D/undeclared.txt"',
    `echo 'STUDIO_GODOT_RESULT {"ok":true,"mode":"export","preset":"Web","steps":[{"step":"export","exitCode":0,"issues":[]}]}'`,
    "",
  ].join("\n");
  await writeFile(binary, script);
  await chmod(binary, 0o755);
  return binary;
}

/** A tool call's JSON record, or its error as `{ ok: false, error }`. */
async function call(rig: Rig, tool: string, args: Record<string, unknown>, directory: string) {
  try {
    const value = await rig.core.plugins.tool(`godot__${tool}`, args, { project: "godotworld", directory });
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

describe("Local Godot through the public plugin API", () => {
  it("ships disabled and offers no tools until enabled", async () => {
    const rig = await startRig();
    rigs.push(rig);
    assert.equal(rig.core.plugins.enabled("godot"), false);
    assert.ok(!rig.core.plugins.tools().some((t) => t.name.startsWith("godot__")));
    assert.ok(!rig.core.plugins.guidance().includes("Local Godot"));
    await rig.core.plugins.setEnabled("godot", true);
    assert.ok(rig.core.plugins.tools().some((t) => t.name === "godot__export"));
  });

  it("checks and exports a snapshot of the project and delivers only the web build", async () => {
    const rig = await startRig();
    rigs.push(rig);
    const source = path.join(await tmpDir("godot-plugin-"), "package");
    await cp(path.join(rig.core.options.paths.resources, "plugins", "godot"), source, { recursive: true });
    const binary = await fakeGodot(path.join(await tmpDir("godot-runtime-"), "Godot.app"));
    const manifest = JSON.parse(await readFile(path.join(source, "plugin.json"), "utf8"));
    manifest.nativeRuntimes[0].candidates = [binary];
    await writeFile(path.join(source, "plugin.json"), JSON.stringify(manifest));
    await rig.core.plugins.installLocal(source, "bundled", manifest.capabilities);
    await rig.core.plugins.setEnabled("godot", true);

    const game = path.join(await tmpDir("godot-game-"), "godotworld");
    await mkdir(path.join(game, ".godot"), { recursive: true });
    await writeFile(path.join(game, "project.godot"), "config_version=5\n");
    await writeFile(path.join(game, ".env"), "SECRET=1\n");
    await writeFile(path.join(game, "BROKEN"), "");

    const broken = await call(rig, "check", {}, game);
    assert.equal(broken.ok, false, JSON.stringify(broken));
    assert.match(broken.steps[0].issues[0], /res:\/\/player\.gd:3/);
    assert.match(broken.guidance, /godot__check/);
    await rm(path.join(game, "BROKEN"));
    const fine = await call(rig, "check", {}, game);
    assert.equal(fine.ok, true, JSON.stringify(fine));

    const noTemplates = await call(rig, "export", {}, game);
    assert.equal(noTemplates.ok, false);
    assert.match(noTemplates.error, /templates/i);

    const templates = path.join(rig.core.pluginServices.root("godot"), "downloads", "web-templates");
    for (const member of TEMPLATE_MEMBERS) {
      await mkdir(path.dirname(path.join(templates, member)), { recursive: true });
      await writeFile(path.join(templates, member), "template");
    }
    const status = await call(rig, "status", {}, game);
    assert.equal(status.runtime.state, "ready");
    assert.equal(status.templates.state, "ready");

    assert.equal((await call(rig, "export", { preset: "../x" }, game)).ok, false, "a preset is a plain name");
    const exported = await call(rig, "export", {}, game);
    assert.equal(exported.ok, true, JSON.stringify(exported));
    assert.equal(exported.runtimeVersion, "4.7.2");
    assert.match(exported.entry, /^assets\/godot\/[^/]+\/web\/index\.html$/);
    assert.deepEqual(exported.files.map((f: string) => path.basename(f)).sort(), [...WEB_FILES].sort());
    for (const file of exported.files) assert.ok((await stat(path.join(game, file))).size > 0);
    await assert.rejects(stat(path.join(game, "export_presets.cfg")), "the snapshot's changes stay in the job");
    const retrieved = await call(rig, "retrieve", { id: exported.jobId }, game);
    assert.deepEqual(retrieved.delivery.files, exported.files);
  });
});
