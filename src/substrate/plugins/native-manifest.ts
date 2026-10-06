import {
  PluginCapability,
  type PluginManifest,
  type PluginNativeArg,
  type PluginNativeDownload,
  type PluginNativeJob,
  type PluginNativeRuntime,
} from "../../shared/plugins.ts";
import { assertRelativePath } from "../paths.ts";
import { PLUGIN_ID } from "../../shared/plugin-id.ts";
/** Runtime, job and value names follow the plugin id rule. */
const name = PLUGIN_ID;
const SEMVER = /^\d+\.\d+\.\d+$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const CANDIDATE_ALIAS = /^(home|studio|storage):(.+)$/;
const ARCHIVE_FORMATS = ["dmg", "tar.gz", "zip"];
const DOWNLOAD_FORMATS = ["zip"];
const ARG_SOURCES = ["package", "input", "output", "value", "project", "download"];
/** The only name a project binding takes: the snapshot's root. */
const PROJECT_ROOT = ".";
/** Archive member names `unzip` reads literally: no wildcard or bracket characters. */
const MEMBER_NAME = /^[A-Za-z0-9._/-]+$/;
/** An OS temp file name: starts with a letter or digit, so never hidden, `..` or a path. */
const OS_TEMP_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** OS temp files one job may name. */
const MAX_OS_TEMP_FILES = 4;
/** The largest each native declaration may be. */
const NATIVE_MANIFEST_LIMITS = {
  runtimes: 4,
  jobs: 8,
  labelChars: 120,
  candidates: 16,
  versionArgs: 16,
  versionPatternChars: 200,
  urlChars: 2048,
  notices: 16,
  args: 64,
  argChars: 2048,
  inputs: 16,
  values: 16,
  outputs: 32,
  valuePatternChars: 160,
  valueMaxLength: 1024,
  minTimeoutMs: 1000,
  maxTimeoutMs: 300000,
  maxOutputBytes: 256000,
  maxAssetBytes: 100 * 1024 ** 2,
  downloads: 4,
  members: 16,
  snapshotFiles: 20000,
  snapshotBytes: 512 * 1024 ** 2,
  snapshotExcludes: 16,
} as const;
const L = NATIVE_MANIFEST_LIMITS;

/** What a publisher reads when a native runtime or job declaration is refused. */
const MESSAGE = {
  CandidatePath: "Runtime candidates must use absolute, home:, studio: or storage: paths",
  InvalidInstall: "Invalid pinned native installation or missing trusted install action",
  InvalidRuntime: "Invalid native runtime",
  InvalidVersionPattern: "Invalid runtime version pattern",
  TimeoutRange: (label: string) => `${label}: timeoutMs must be an integer from 1000 to 300000 milliseconds`,
  OutputLimit: (label: string) =>
    `${label}: maxOutputBytes is the retained process log limit and must be 1 to 256000 bytes; use maxAssetBytes for generated files`,
  AssetLimit: (label: string) => `${label}: maxAssetBytes must be 1 to 104857600 bytes across generated files`,
  InvalidJobValue: "Invalid job value",
  InvalidJobValuePattern: "Invalid job value pattern",
  InvalidArgument: "Invalid native argument",
  InvalidBinding: "Invalid native argument binding",
  UndeclaredBinding: "Undeclared native argument binding",
  InvalidGpu: "Invalid native job GPU declaration",
  InvalidOsTempFiles: `Invalid native job OS temp files: at most ${MAX_OS_TEMP_FILES} plain file names`,
  InvalidRecipe: "Invalid native job recipe",
  InvalidDeclarations: "Invalid native runtime/job declarations",
  InvalidDownload: "Invalid pinned native download or missing trusted install action",
  InvalidSnapshot: (label: string) =>
    `${label}: project snapshot needs maxFiles 1 to 20000, maxBytes 1 to 536870912 and at most 16 excludes`,
  SnapshotNeedsRead: (label: string) => `${label}: a project snapshot requires the project.read capability`,
  JobLabel: (id: string | undefined) => `Native job ${id ?? "(unnamed)"}`,
} as const;

const text = (v: unknown, max = 1000): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max && !v.includes("\0");
const paths = (values: unknown, max = 32): values is string[] =>
  Array.isArray(values) && values.length <= max && values.every((v) => text(v));
const inRange = (v: number, min: number, max: number) => v >= min && v <= max;
const isValidPattern = (pattern: string) => {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
};
const isPositiveSafeInteger = (v: number) => Number.isSafeInteger(v) && v > 0;
const isTimeout = (v: number) => Number.isInteger(v) && inRange(v, L.minTimeoutMs, L.maxTimeoutMs);
const isOutputLimit = (v: number) => Number.isSafeInteger(v) && inRange(v, 1, L.maxOutputBytes);
const isAssetLimit = (v: number) => Number.isSafeInteger(v) && inRange(v, 1, L.maxAssetBytes);
const isPlainObject = (v: unknown) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** A runtime's name, label, candidates and version probe are well formed and its id is new. */
function isValidRuntime(r: PluginNativeRuntime, ids: Set<string>): boolean {
  if (!r || !name.test(r.id) || ids.has(r.id) || !text(r.label, L.labelChars)) return false;
  if (!paths(r.candidates, L.candidates) || !r.candidates.length) return false;
  return (
    paths(r.version?.args, L.versionArgs) &&
    text(r.version.pattern, L.versionPatternChars) &&
    SEMVER.test(r.version.minimum)
  );
}

/** A candidate is absolute, or a `home:`, `studio:` or `storage:` path that stays inside its root. */
function validateCandidate(candidate: string): void {
  if (candidate.startsWith("/")) return;
  const alias = CANDIDATE_ALIAS.exec(candidate);
  if (!alias) throw new Error(MESSAGE.CandidatePath);
  assertRelativePath(alias[2]);
}

type RuntimeInstall = NonNullable<PluginNativeRuntime["install"]>;

/** A pinned download behind a confirmed setup action: https, a digest, sizes, a known format. */
function isValidInstall(i: RuntimeInstall, m: PluginManifest): boolean {
  if (!m.actions.some((a) => a.name === i.action && a.confirmation)) return false;
  if (!/^https:\/\//.test(i.url) || !text(i.url, L.urlChars) || !SHA256_HEX.test(i.sha256)) return false;
  return (
    isPositiveSafeInteger(i.bytes) &&
    isPositiveSafeInteger(i.unpackedBytes) &&
    ARCHIVE_FORMATS.includes(i.format) &&
    paths(i.notices, L.notices)
  );
}

function validateInstall(i: RuntimeInstall, m: PluginManifest): RuntimeInstall {
  if (!isValidInstall(i, m)) throw new Error(MESSAGE.InvalidInstall);
  assertRelativePath(i.entry);
  assertRelativePath(i.executable);
  for (const n of i.notices) assertRelativePath(n);
  return { ...i, notices: [...i.notices] };
}

function validateRuntime(r: PluginNativeRuntime, m: PluginManifest, ids: Set<string>): PluginNativeRuntime {
  if (!isValidRuntime(r, ids)) throw new Error(MESSAGE.InvalidRuntime);
  for (const c of r.candidates) validateCandidate(c);
  if (!isValidPattern(r.version.pattern)) throw new Error(MESSAGE.InvalidVersionPattern);
  ids.add(r.id);
  const runtime: PluginNativeRuntime = {
    id: r.id,
    label: r.label,
    candidates: [...r.candidates],
    version: { ...r.version, args: [...r.version.args] },
  };
  if (r.install) runtime.install = validateInstall(r.install, m);
  return runtime;
}

/** The limit-specific errors, so a publisher learns which limit a recipe broke. */
function validateJobLimits(j: PluginNativeJob | undefined): void {
  if (!j) return;
  const label = MESSAGE.JobLabel(j.id);
  if (!isTimeout(j.timeoutMs)) throw new Error(MESSAGE.TimeoutRange(label));
  if (!isOutputLimit(j.maxOutputBytes)) throw new Error(MESSAGE.OutputLimit(label));
  if (!isAssetLimit(j.maxAssetBytes)) throw new Error(MESSAGE.AssetLimit(label));
}

/** A recipe's id, runtime, argument count, inputs, values and outputs are declared and bounded. */
function isValidRecipe(j: PluginNativeJob, ids: Set<string>, runtimes: PluginNativeRuntime[]): boolean {
  if (!j || !name.test(j.id) || ids.has(j.id) || !runtimes.some((r) => r.id === j.runtime)) return false;
  if (!Array.isArray(j.args) || j.args.length > L.args) return false;
  if (!paths(j.inputs, L.inputs) || j.inputs.some((k) => !name.test(k))) return false;
  if (!isPlainObject(j.values) || Object.keys(j.values).length > L.values) return false;
  if (!paths(j.outputs, L.outputs) || !j.outputs.length) return false;
  return isTimeout(j.timeoutMs) && isOutputLimit(j.maxOutputBytes) && isAssetLimit(j.maxAssetBytes);
}

function validateJobValues(j: PluginNativeJob): void {
  for (const [key, v] of Object.entries(j.values)) {
    const valid =
      name.test(key) &&
      v &&
      text(v.pattern, L.valuePatternChars) &&
      Number.isInteger(v.maxLength) &&
      inRange(v.maxLength, 1, L.valueMaxLength);
    if (!valid) throw new Error(MESSAGE.InvalidJobValue);
    if (!isValidPattern(v.pattern)) throw new Error(MESSAGE.InvalidJobValuePattern);
  }
}

/** An argument binding names something the recipe declares. */
function isDeclaredBinding(j: PluginNativeJob, arg: Exclude<PluginNativeArg, string>, downloads: Set<string>): boolean {
  if (arg.source === "input") return j.inputs.includes(arg.name);
  if (arg.source === "value") return Object.hasOwn(j.values, arg.name);
  if (arg.source === "output") return j.outputs.includes(arg.name);
  if (arg.source === "project") return j.project !== undefined;
  if (arg.source === "download") return downloads.has(arg.name);
  return true;
}

function validateJobArg(j: PluginNativeJob, arg: PluginNativeArg, downloads: Set<string>): void {
  if (typeof arg === "string") {
    if (!text(arg, L.argChars)) throw new Error(MESSAGE.InvalidArgument);
    return;
  }
  if (!arg || !text(arg.name) || !ARG_SOURCES.includes(arg.source)) throw new Error(MESSAGE.InvalidBinding);
  if (arg.source === "package") assertRelativePath(arg.name);
  if (arg.source === "project" && arg.name !== PROJECT_ROOT) throw new Error(MESSAGE.InvalidBinding);
  if (!isDeclaredBinding(j, arg, downloads)) throw new Error(MESSAGE.UndeclaredBinding);
}

/** A snapshot rule's caps are bounded, its excludes stay inside the game, and the plugin may read the game. */
function validateSnapshot(j: PluginNativeJob, m: PluginManifest): PluginNativeJob["project"] {
  const rule = j.project;
  if (rule === undefined) return undefined;
  const label = MESSAGE.JobLabel(j.id);
  const exclude = rule?.exclude ?? [];
  const bounded =
    isPlainObject(rule) &&
    Number.isSafeInteger(rule.maxFiles) &&
    inRange(rule.maxFiles, 1, L.snapshotFiles) &&
    Number.isSafeInteger(rule.maxBytes) &&
    inRange(rule.maxBytes, 1, L.snapshotBytes) &&
    paths(exclude, L.snapshotExcludes);
  if (!bounded) throw new Error(MESSAGE.InvalidSnapshot(label));
  for (const e of exclude) assertRelativePath(e);
  if (!hasProjectRead(m)) throw new Error(MESSAGE.SnapshotNeedsRead(label));
  return { maxFiles: rule.maxFiles, maxBytes: rule.maxBytes, ...(rule.exclude ? { exclude: [...exclude] } : {}) };
}

const hasProjectRead = (m: PluginManifest) =>
  Array.isArray(m.capabilities) && m.capabilities.includes(PluginCapability.ProjectRead);

function validateJob(
  j: PluginNativeJob,
  m: PluginManifest,
  ids: Set<string>,
  runtimes: PluginNativeRuntime[],
  downloads: Set<string>,
): PluginNativeJob {
  validateJobLimits(j);
  if (j?.gpu !== undefined && typeof j.gpu !== "boolean") throw new Error(MESSAGE.InvalidGpu);
  validateOsTempFiles(j);
  if (!isValidRecipe(j, ids, runtimes)) throw new Error(MESSAGE.InvalidRecipe);
  validateJobValues(j);
  for (const file of j.outputs) assertRelativePath(file);
  for (const arg of j.args) validateJobArg(j, arg, downloads);
  const project = validateSnapshot(j, m);
  ids.add(j.id);
  return {
    ...j,
    ...(project ? { project } : {}),
    args: j.args.map((a) => (typeof a === "string" ? a : { ...a })),
    inputs: [...j.inputs],
    values: { ...j.values },
    outputs: [...j.outputs],
    ...(j.osTempFiles ? { osTempFiles: [...j.osTempFiles] } : {}),
  };
}
/** Each OS temp file is one plain name: no folder, no hidden file, nothing that climbs out. */
function validateOsTempFiles(j: PluginNativeJob): void {
  const names: unknown = j.osTempFiles;
  if (names === undefined) return;
  const valid =
    Array.isArray(names) &&
    names.length <= MAX_OS_TEMP_FILES &&
    names.every((name) => typeof name === "string" && OS_TEMP_FILE.test(name));
  if (!valid) throw new Error(MESSAGE.InvalidOsTempFiles);
}

/** A pinned download is https with a digest and sizes, a zip, behind a confirmed setup action. */
function isValidDownload(d: PluginNativeDownload, m: PluginManifest, ids: Set<string>): boolean {
  if (!d || !name.test(d.id) || ids.has(d.id) || !text(d.label, L.labelChars)) return false;
  if (!m.actions.some((a) => a.name === d.action && a.confirmation)) return false;
  if (!/^https:\/\//.test(d.url) || !text(d.url, L.urlChars) || !SHA256_HEX.test(d.sha256)) return false;
  return (
    isPositiveSafeInteger(d.bytes) &&
    isPositiveSafeInteger(d.unpackedBytes) &&
    DOWNLOAD_FORMATS.includes(d.format) &&
    paths(d.members, L.members) &&
    d.members.length > 0
  );
}

function validateDownload(d: PluginNativeDownload, m: PluginManifest, ids: Set<string>): PluginNativeDownload {
  if (!isValidDownload(d, m, ids)) throw new Error(MESSAGE.InvalidDownload);
  for (const member of d.members) assertRelativePath(member);
  if (!d.members.every((member) => MEMBER_NAME.test(member))) throw new Error(MESSAGE.InvalidDownload);
  ids.add(d.id);
  return {
    id: d.id,
    label: d.label,
    action: d.action,
    url: d.url,
    sha256: d.sha256,
    bytes: d.bytes,
    unpackedBytes: d.unpackedBytes,
    format: d.format,
    members: [...d.members],
  };
}

/** Every pinned download, with ids distinct from each other and from the runtimes'. */
function validateDownloads(m: PluginManifest, runtimeIds: Set<string>): PluginNativeDownload[] | undefined {
  if (m.nativeDownloads === undefined) return undefined;
  if (!Array.isArray(m.nativeDownloads) || m.nativeDownloads.length > L.downloads)
    throw new Error(MESSAGE.InvalidDownload);
  const ids = new Set(runtimeIds);
  return m.nativeDownloads.map((d) => validateDownload(d, m, ids));
}

export function validateNativeDeclarations(m: PluginManifest): {
  nativeRuntimes: PluginNativeRuntime[];
  nativeJobs: PluginNativeJob[];
  nativeDownloads?: PluginNativeDownload[];
} {
  const declared =
    Array.isArray(m.nativeRuntimes) &&
    m.nativeRuntimes.length <= L.runtimes &&
    Array.isArray(m.nativeJobs) &&
    m.nativeJobs.length <= L.jobs;
  if (!declared || !m.nativeRuntimes || !m.nativeJobs) throw new Error(MESSAGE.InvalidDeclarations);
  const runtimeIds = new Set<string>();
  const runtimes = m.nativeRuntimes.map((r) => validateRuntime(r, m, runtimeIds));
  const downloads = validateDownloads(m, runtimeIds);
  const downloadIds = new Set(downloads?.map((d) => d.id));
  const jobIds = new Set<string>();
  const jobs = m.nativeJobs.map((j) => validateJob(j, m, jobIds, runtimes, downloadIds));
  return { nativeRuntimes: runtimes, nativeJobs: jobs, ...(downloads ? { nativeDownloads: downloads } : {}) };
}
