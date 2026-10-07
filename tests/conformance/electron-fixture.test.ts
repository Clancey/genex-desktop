import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  APP_BUNDLE_ID,
  fixtureElectronArgs,
  fixtureElectronEnv,
  localNetworkElectron,
} from "../../scripts/electron-runtime.mjs";

test("macOS fixture launch requests mock cookie encryption before app arguments", () => {
  assert.deepEqual(fixtureElectronArgs([".", "--studio-selftest"], "darwin"), [
    "--use-mock-keychain",
    ".",
    "--studio-selftest",
  ]);
  assert.deepEqual(fixtureElectronArgs(["."], "linux"), ["."]);
});
test("fixture launch disables Studio OS credentials and live checks regardless of inherited opt-ins", () => {
  const source = {
    PATH: "/fixture",
    STUDIO_ALLOW_LIVE_CREDENTIAL_CHECKS: "1",
    GENEX_TOKEN: "synthetic",
    OPENAI_API_KEY: "synthetic",
    ELECTRON_RUN_AS_NODE: "1",
  };
  const env = fixtureElectronEnv(source);
  assert.equal(env.STUDIO_DISABLE_OS_CREDENTIALS, "1");
  assert.equal(env.STUDIO_ALLOW_LIVE_CREDENTIAL_CHECKS, "0");
  assert.equal(env.GENEX_TOKEN, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.PATH, "/fixture");
  assert.equal(source.GENEX_TOKEN, "synthetic", "caller environment is unchanged");
});

test("macOS normal-profile launch uses a Genex-identified Electron copy that can reach local servers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "genex-dev-electron-"));
  const source = path.join(root, "node_modules/electron/dist/Electron.app");
  fs.mkdirSync(path.join(source, "Contents/MacOS"), { recursive: true });
  fs.writeFileSync(path.join(source, "Contents/Info.plist"), "stock");
  fs.writeFileSync(path.join(source, "Contents/MacOS/Electron"), "binary");
  const calls: string[][] = [];
  const run = (file: string, args: string[]) => {
    calls.push([file, ...args]);
    if (file === "ditto") fs.cpSync(args[0], args[1], { recursive: true });
  };
  const executable = path.join(source, "Contents/MacOS/Electron");
  try {
    const launched = localNetworkElectron(executable, root, { platform: "darwin", run });
    const copy = path.join(root, ".studio-dev/electron/Genex.app");
    assert.equal(launched, path.join(copy, "Contents/MacOS/Electron"));
    const plist = path.join(copy, "Contents/Info.plist");
    assert.ok(
      calls.some((c) => c.join(" ") === `plutil -replace CFBundleIdentifier -string ${APP_BUNDLE_ID} ${plist}`),
    );
    assert.ok(calls.some((c) => c[0] === "plutil" && c[2] === "NSLocalNetworkUsageDescription"));
    assert.deepEqual(calls.at(-1), ["codesign", "--force", "--deep", "--sign", "-", copy]);

    calls.length = 0;
    assert.equal(localNetworkElectron(executable, root, { platform: "darwin", run }), launched);
    assert.deepEqual(calls, [], "an up-to-date copy is reused");

    assert.equal(localNetworkElectron(executable, root, { platform: "linux", run }), executable);
    assert.deepEqual(calls, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
