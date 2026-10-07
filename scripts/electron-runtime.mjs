import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const signing = createRequire(import.meta.url)("./package-signing.cjs");
/** The packaged app's bundle id, which the normal-profile development launch also carries. */
export const APP_BUNDLE_ID = signing.APP_BUNDLE_ID;
const DEV_ELECTRON_DIR = path.join(".studio-dev", "electron");

/** One resolver for all development/test launches, including Electron's lazy install. */
export function resolveElectron(checkout = process.cwd()) {
  const require = createRequire(path.join(checkout, "package.json"));
  try {
    const executable = /** @type {unknown} */ (require("electron"));
    if (typeof executable !== "string") throw new Error("Electron resolver returned no executable path");
    fs.accessSync(executable, fs.constants.X_OK);
    return executable;
  } catch (error) {
    throw new Error(
      `Pinned Electron is unavailable. Run node node_modules/electron/install.js with network access, then retry. ${error.message}`,
    );
  }
}

/** Disposable fixture profiles only. Never use mock encryption with real account data. */
export function fixtureElectronArgs(args, platform = process.platform) {
  return [...(platform === "darwin" ? ["--use-mock-keychain"] : []), ...args];
}
/** @param {NodeJS.ProcessEnv} source @returns {NodeJS.ProcessEnv} */
export function fixtureElectronEnv(source = process.env) {
  const env = {
    ...source,
    STUDIO_DISABLE_OS_CREDENTIALS: "1",
    STUDIO_ALLOW_LIVE_CREDENTIAL_CHECKS: "0",
    STUDIO_LIVE_CLAUDE_CLI: "0",
    STUDIO_LIVE_OLLAMA: "0",
  };
  for (const key of FIXTURE_SCRUBBED_ENV) delete env[key];
  return env;
}
/**
 * Provider credentials and login homes a fixture run must not inherit. An agent session that
 * drives `studio:dev` carries its own Claude/Codex login in these, and the engines read them.
 */
export const FIXTURE_SCRUBBED_ENV = Object.freeze([
  "ELECTRON_RUN_AS_NODE",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "CODEX_HOME",
  "GENEX_TOKEN",
]);

/**
 * macOS Local Network privacy blocks stock Electron (`com.github.Electron`) from reaching a model
 * server on the LAN, and never prompts for it. The normal-profile launch therefore runs a copy of
 * the pinned Electron.app that carries Genex's bundle id and usage text, so it shares the
 * permission the user gives Genex. Rebuilt only when the pinned Electron changes.
 * @param {string} executable stock Electron executable from `resolveElectron`
 * @param {string} checkout repository root; the copy lives in its ignored `.studio-dev/electron`
 * @param {{ platform?: NodeJS.Platform, run?: (file: string, args: string[]) => void }} [options]
 */
export function localNetworkElectron(executable, checkout, options = {}) {
  const { platform = process.platform, run = (file, args) => execFileSync(file, args, { stdio: "ignore" }) } = options;
  if (platform !== "darwin") return executable;
  const source = path.resolve(executable, "../../..");
  const root = path.join(checkout, DEV_ELECTRON_DIR);
  const copy = path.join(root, "Genex.app");
  const launched = path.join(copy, path.relative(source, executable));
  const stampFile = path.join(root, "source.json");
  const { mtimeMs, size } = fs.statSync(executable);
  const stamp = JSON.stringify({ source, mtimeMs, size, id: APP_BUNDLE_ID, usage: signing.LOCAL_NETWORK_USAGE });
  if (fs.existsSync(launched) && readText(stampFile) === stamp) return launched;
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  run("ditto", [source, copy]);
  const plist = path.join(copy, "Contents", "Info.plist");
  run("plutil", ["-replace", "CFBundleIdentifier", "-string", APP_BUNDLE_ID, plist]);
  run("plutil", ["-replace", "NSLocalNetworkUsageDescription", "-string", signing.LOCAL_NETWORK_USAGE, plist]);
  run("codesign", ["--force", "--deep", "--sign", "-", copy]);
  fs.writeFileSync(stampFile, stamp);
  return launched;
}

/** @param {string} file */
function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
