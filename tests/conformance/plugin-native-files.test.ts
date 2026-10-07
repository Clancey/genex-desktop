import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PluginNativeServices } from "../../src/substrate/plugins/native.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import type { PluginManifest, PluginNativeResult, PluginNativeStatus } from "../../src/shared/plugins.ts";
import { zipArchive, type ZipEntry } from "../helpers/zip.ts";

const onMac = process.platform === "darwin";
const onAppleSilicon = onMac && process.arch === "arm64";
const RUNTIME_URL = "https://example.invalid/tool.zip";
const TEMPLATES_URL = "https://example.invalid/templates.tpz";
/** Lists every path under the snapshot (bash 3.2: no globstar, and `find` is not a job utility). */
const LIST_SCRIPT = `ROOT="$1"
walk() { local f; for f in "$1"/* "$1"/.*; do
  case "\${f##*/}" in .|..) continue;; esac
  if [ -e "$f" ] || [ -L "$f" ]; then echo "\${f#$ROOT/}"; if [ -d "$f" ] && [ ! -L "$f" ]; then walk "$f"; fi; fi
done; }
walk "$ROOT" | /usr/bin/sort > "$2"
printf 'changed' > "$ROOT/main.gd"
`;

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-files-")),
    game = path.join(root, "game"),
    pkg = path.join(root, "package"),
    storage = path.join(root, "storage");
  for (const dir of [game, pkg, storage]) await mkdir(dir);
  const manifest: PluginManifest = {
    apiVersion: 3,
    id: "native-files",
    version: "1.0.0",
    name: "Native files",
    publisher: "Test",
    description: "Zip runtimes, project snapshots and pinned downloads",
    backend: "backend.mjs",
    capabilities: ["native-runtime", "project.read"],
    tools: [],
    skills: [],
    panels: [],
    settings: [],
    actions: [
      { name: "install", label: "Install", confirmation: "Download pinned runtime" },
      { name: "install-templates", label: "Install templates", confirmation: "Download pinned templates" },
    ],
    nativeRuntimes: [
      {
        id: "shell",
        label: "Shell",
        candidates: ["/bin/bash"],
        version: { args: ["--version"], pattern: "version (\\d+\\.\\d+\\.\\d+)", minimum: "3.0.0" },
      },
    ],
    nativeDownloads: [
      {
        id: "templates",
        label: "Templates",
        action: "install-templates",
        url: TEMPLATES_URL,
        sha256: "0".repeat(64),
        bytes: 1,
        unpackedBytes: 1,
        format: "zip",
        members: ["templates/web.zip", "templates/version.txt"],
      },
    ],
    nativeJobs: [
      {
        id: "list",
        runtime: "shell",
        args: [
          { source: "input", name: "script" },
          { source: "project", name: "." },
          { source: "output", name: "list.txt" },
        ],
        inputs: ["script"],
        values: {},
        outputs: ["list.txt"],
        timeoutMs: 5000,
        maxOutputBytes: 4000,
        maxAssetBytes: 8192,
        project: { maxFiles: 50, maxBytes: 100_000, exclude: ["assets/godot"] },
      },
      {
        id: "read-download",
        runtime: "shell",
        args: [
          "-c",
          '/usr/bin/head -c 100 "$0/templates/version.txt" > "$1"',
          { source: "download", name: "templates" },
          { source: "output", name: "web/version.txt" },
        ],
        inputs: [],
        values: {},
        // Nested: the host creates a declared output's folder; the sandbox has no mkdir.
        outputs: ["web/version.txt"],
        timeoutMs: 5000,
        maxOutputBytes: 4000,
        maxAssetBytes: 8192,
      },
    ],
  };
  const service = new PluginNativeServices(root, []),
    binding = { project: "game", directory: game };
  const call = (method: string, args: any, source = "tool", name = "install") =>
    service.call(
      manifest,
      pkg,
      storage,
      method,
      args,
      binding,
      { method: source, name, signal: new AbortController().signal },
      () => {},
    );
  /** Put a pinned archive where a verified download would leave it, so install needs no network. */
  const seed = async (url: string, entries: ZipEntry[]) => {
    const archive = zipArchive(entries);
    await mkdir(path.join(storage, "runtime-downloads"), { recursive: true });
    await writeFile(path.join(storage, "runtime-downloads", path.basename(new URL(url).pathname)), archive);
    return { sha256: sha256(archive), bytes: archive.length };
  };
  return {
    root,
    game,
    pkg,
    storage,
    manifest,
    service,
    call,
    seed,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("native manifests bound zip installs, project snapshots and pinned downloads", async () => {
  const f = await setup();
  try {
    const canonical = validateManifest(f.manifest);
    assert.deepEqual(canonical.nativeDownloads, f.manifest.nativeDownloads);
    assert.deepEqual(canonical.nativeJobs?.[0]?.project, f.manifest.nativeJobs?.[0]?.project);
    const variant = () => structuredClone(f.manifest);
    const zipRuntime = variant();
    zipRuntime.nativeRuntimes![0]!.install = {
      action: "install",
      url: RUNTIME_URL,
      sha256: "0".repeat(64),
      bytes: 1,
      unpackedBytes: 1,
      format: "zip",
      entry: "tool",
      executable: "tool/run",
      notices: [],
    };
    assert.equal(validateManifest(zipRuntime).nativeRuntimes?.[0]?.install?.format, "zip");
    const refused: [string, (m: PluginManifest) => void, RegExp][] = [
      ["project binding without a snapshot rule", (m) => delete m.nativeJobs![0]!.project, /Undeclared/],
      ["snapshot without project.read", (m) => (m.capabilities = ["native-runtime"]), /project\.read/],
      ["snapshot file cap", (m) => (m.nativeJobs![0]!.project!.maxFiles = 0), /snapshot/],
      ["snapshot byte cap", (m) => (m.nativeJobs![0]!.project!.maxBytes = 2 * 1024 ** 3), /snapshot/],
      ["snapshot exclude escapes", (m) => (m.nativeJobs![0]!.project!.exclude = ["../x"]), /path/],
      ["project binding to a subfolder", (m) => ((m.nativeJobs![0]!.args[1] as any).name = "src"), /Invalid native/],
      ["undeclared download", (m) => ((m.nativeJobs![1]!.args[2] as any).name = "other"), /Undeclared/],
      ["download without consent", (m) => (m.nativeDownloads![0]!.action = "missing"), /download/],
      ["download over http", (m) => (m.nativeDownloads![0]!.url = "http://example.invalid/t.tpz"), /download/],
      ["download format", (m) => ((m.nativeDownloads![0] as any).format = "dmg"), /download/],
      ["download member escapes", (m) => (m.nativeDownloads![0]!.members = ["../x"]), /path/],
      ["download without members", (m) => (m.nativeDownloads![0]!.members = []), /download/],
      ["download id shared with a runtime", (m) => (m.nativeDownloads![0]!.id = "shell"), /download/],
    ];
    for (const [label, change, error] of refused) {
      const m = variant();
      change(m);
      assert.throws(() => validateManifest(m), error, label);
    }
  } finally {
    await f.close();
  }
});

test("a pinned zip runtime installs through its action and keeps its internal links", {
  skip: !onAppleSilicon && "pinned runtime installs are Apple Silicon only",
}, async () => {
  const f = await setup();
  try {
    const pinned = await f.seed(RUNTIME_URL, [
      { name: "Tool.app/" },
      { name: "Tool.app/run", data: "#!/bin/bash\necho 'tool version 2.4.6'\n", mode: 0o755 },
      { name: "Tool.app/alias", link: "run" },
    ]);
    f.manifest.nativeRuntimes![0]!.candidates = [path.join(f.root, "absent")];
    f.manifest.nativeRuntimes![0]!.version = { args: [], pattern: "version (\\d+\\.\\d+\\.\\d+)", minimum: "2.0.0" };
    f.manifest.nativeRuntimes![0]!.install = {
      action: "install",
      url: RUNTIME_URL,
      ...pinned,
      unpackedBytes: 1000,
      format: "zip",
      entry: "Tool.app",
      executable: "Tool.app/run",
      notices: [],
    };
    await assert.rejects(f.call("runtime.install", { runtime: "shell" }), /trusted setup/);
    const status = (await f.call("runtime.install", { runtime: "shell" }, "action")) as PluginNativeStatus;
    assert.equal(status.state, "ready", status.detail);
    assert.equal(status.version, "2.4.6");
    const installed = path.join(f.storage, "runtimes", "shell", "Tool.app");
    assert.equal(
      await readFile(path.join(installed, "alias"), "utf8"),
      await readFile(path.join(installed, "run"), "utf8"),
    );
  } finally {
    await f.close();
  }
});

test("hostile zip runtimes are refused before anything is activated or written outside", {
  skip: !onAppleSilicon && "pinned runtime installs are Apple Silicon only",
}, async () => {
  const hostile: [string, ZipEntry][] = [
    ["parent-relative entry", { name: "../escaped.txt", data: "outside" }],
    ["absolute entry", { name: "/tmp/escaped.txt", data: "outside" }],
    ["link leading outside", { name: "Tool.app/escape", link: "../../../../escaped.txt" }],
    ["absolute link", { name: "Tool.app/escape", link: "/etc/hosts" }],
  ];
  for (const [label, entry] of hostile) {
    const f = await setup();
    try {
      const pinned = await f.seed(RUNTIME_URL, [
        { name: "Tool.app/" },
        { name: "Tool.app/run", data: "#!/bin/bash\necho 'tool version 2.4.6'\n", mode: 0o755 },
        entry,
      ]);
      f.manifest.nativeRuntimes![0]!.candidates = [path.join(f.root, "absent")];
      f.manifest.nativeRuntimes![0]!.install = {
        action: "install",
        url: RUNTIME_URL,
        ...pinned,
        unpackedBytes: 1000,
        format: "zip",
        entry: "Tool.app",
        executable: "Tool.app/run",
        notices: [],
      };
      await assert.rejects(f.call("runtime.install", { runtime: "shell" }, "action"), /Unsafe|outside/, label);
      assert.equal(await exists(path.join(f.storage, "runtimes", "shell")), false, label);
      assert.equal(await exists(path.join(f.storage, "escaped.txt")), false, label);
      assert.equal(await exists(path.join(f.storage, "runtimes", "escaped.txt")), false, label);
      assert.deepEqual(
        (await readdir(path.join(f.storage, "runtimes"))).filter((n) => n.includes("staging")),
        [],
        label,
      );
    } finally {
      await f.close();
    }
  }
});

test("a project snapshot is a writable filtered copy the job cannot deliver back", {
  skip: !onMac && "managed native jobs run under macOS Seatbelt",
}, async () => {
  const f = await setup();
  try {
    await writeFile(path.join(f.game, "list.sh"), LIST_SCRIPT);
    await writeFile(path.join(f.game, "main.gd"), "extends Node");
    await mkdir(path.join(f.game, "scenes"));
    await writeFile(path.join(f.game, "scenes", "level.tscn"), "[gd_scene]");
    await writeFile(path.join(f.game, ".env"), "synthetic-secret");
    await mkdir(path.join(f.game, ".godot"));
    await writeFile(path.join(f.game, ".godot", "cache"), "x");
    await mkdir(path.join(f.game, "node_modules"));
    await writeFile(path.join(f.game, "node_modules", "dep.js"), "x");
    await writeFile(path.join(f.game, "CLAUDE.md"), "agent");
    await writeFile(path.join(f.game, "secrets.json"), "{}");
    await writeFile(path.join(f.game, "signing.pem"), "key");
    await symlink("/etc/hosts", path.join(f.game, "hosts-link"));
    await symlink(path.join(f.game, "scenes"), path.join(f.game, "scenes-link"));
    await mkdir(path.join(f.game, "assets", "godot"), { recursive: true });
    await writeFile(path.join(f.game, "assets", "godot", "previous.wasm"), "old export");
    const result = (await f.call("native.run", {
      job: "list",
      inputs: { script: "list.sh" },
      values: {},
    })) as PluginNativeResult;
    assert.equal(result.state, "completed", result.stderr || result.reason);
    const listed = (await readFile(path.join(result.output, "list.txt"), "utf8")).trim().split("\n");
    assert.deepEqual(listed, ["assets", "list.sh", "main.gd", "scenes", "scenes/level.tscn"]);
    assert.equal(await readFile(path.join(f.game, "main.gd"), "utf8"), "extends Node");
    assert.deepEqual(result.files, ["list.txt"]);
  } finally {
    await f.close();
  }
});

test("a project snapshot past its declared caps is refused before the job starts", {
  skip: !onMac && "managed native jobs run under macOS Seatbelt",
}, async () => {
  const f = await setup();
  try {
    await writeFile(path.join(f.game, "list.sh"), LIST_SCRIPT);
    await writeFile(path.join(f.game, "big.bin"), Buffer.alloc(200_000));
    await assert.rejects(
      f.call("native.run", { job: "list", inputs: { script: "list.sh" }, values: {} }),
      /snapshot.*bytes/,
    );
    await rm(path.join(f.game, "big.bin"));
    for (let i = 0; i < 60; i++) await writeFile(path.join(f.game, `f${i}.txt`), "x");
    await assert.rejects(
      f.call("native.run", { job: "list", inputs: { script: "list.sh" }, values: {} }),
      /snapshot.*files/,
    );
    assert.deepEqual(await readdir(path.join(f.storage, "native-jobs")), []);
  } finally {
    await f.close();
  }
});

test("a pinned download extracts only its members through its action and a job may read it", {
  skip: !onMac && "managed native jobs run under macOS Seatbelt",
}, async () => {
  const f = await setup();
  try {
    const pinned = await f.seed(TEMPLATES_URL, [
      { name: "templates/" },
      { name: "templates/version.txt", data: "4.7.2.stable" },
      { name: "templates/web.zip", data: "web template" },
      { name: "templates/windows.zip", data: "not wanted" },
    ]);
    Object.assign(f.manifest.nativeDownloads![0]!, pinned);
    const missing = (await f.call("runtime.detect", { download: "templates" })) as PluginNativeStatus;
    assert.equal(missing.state, "missing");
    await assert.rejects(
      f.call("native.run", { job: "read-download", inputs: {}, values: {} }),
      /Templates.*plugin setup/,
    );
    await assert.rejects(f.call("runtime.install", { download: "templates" }), /trusted setup/);
    await assert.rejects(f.call("runtime.install", { download: "templates" }, "action", "install"), /trusted setup/);
    const ready = (await f.call(
      "runtime.install",
      { download: "templates" },
      "action",
      "install-templates",
    )) as PluginNativeStatus;
    assert.equal(ready.state, "ready", ready.detail);
    const dir = path.join(f.storage, "downloads", "templates");
    assert.deepEqual((await readdir(path.join(dir, "templates"))).sort(), ["version.txt", "web.zip"]);
    assert.equal(await exists(path.join(f.storage, "runtime-downloads", "templates.tpz")), false);
    const install = (await f.call("runtime.installation", { download: "templates" })) as any;
    assert.equal(install.phase, "ready");
    const result = (await f.call("native.run", {
      job: "read-download",
      inputs: {},
      values: {},
    })) as PluginNativeResult;
    assert.equal(result.state, "completed", result.stderr || result.reason);
    assert.equal(await readFile(path.join(result.output, "web/version.txt"), "utf8"), "4.7.2.stable");
  } finally {
    await f.close();
  }
});

test("a pinned download missing a member or holding a linked member is refused", {
  skip: !onMac && "pinned downloads unpack with macOS unzip",
}, async () => {
  const hostile: [string, ZipEntry[]][] = [
    ["missing member", [{ name: "templates/version.txt", data: "4.7.2" }]],
    [
      "linked member",
      [
        { name: "templates/version.txt", data: "4.7.2" },
        { name: "templates/web.zip", link: "/etc/hosts" },
      ],
    ],
    [
      "parent-relative entry",
      [
        { name: "templates/version.txt", data: "4.7.2" },
        { name: "templates/web.zip", data: "web" },
        { name: "../escaped.txt", data: "outside" },
      ],
    ],
  ];
  for (const [label, entries] of hostile) {
    const f = await setup();
    try {
      Object.assign(f.manifest.nativeDownloads![0]!, await f.seed(TEMPLATES_URL, entries));
      await assert.rejects(
        f.call("runtime.install", { download: "templates" }, "action", "install-templates"),
        /Unsafe|missing|not a regular file/,
        label,
      );
      const status = (await f.call("runtime.detect", { download: "templates" })) as PluginNativeStatus;
      assert.equal(status.state, "missing", label);
      assert.equal(await exists(path.join(f.storage, "escaped.txt")), false, label);
    } finally {
      await f.close();
    }
  }
});
