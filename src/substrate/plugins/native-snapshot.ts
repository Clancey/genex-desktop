import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { PluginNativeProjectSnapshot } from "../../shared/plugins.ts";
import { containedReal } from "../paths.ts";
import { openNoFollow } from "../fsx.ts";

/** Input path segments a job may never be handed: dotfiles, dependencies, agent instructions and key material. */
const PROTECTED_INPUT_SEGMENTS = ["node_modules", "AGENTS.md", "CLAUDE.md"];
const SECRET_NAME = /^(credentials|secrets|id_rsa|id_ed25519)(\.|$)/i;
const KEY_FILE = /\.(pem|key|p12|pfx|keystore)$/i;

const MESSAGE = {
  TooManyFiles: (limit: number) => `The project snapshot has more than ${limit} files; the job's declared limit.`,
  TooLarge: (limit: number) => `The project snapshot is larger than ${limit} bytes; the job's declared limit.`,
  Changed: (file: string) => `${file} changed while the project snapshot was copied`,
} as const;

/** A path segment a native job must never see: a dotfile, dependencies, an agent file or key material. */
export const isProtectedInputSegment = (segment: string) =>
  segment.startsWith(".") ||
  PROTECTED_INPUT_SEGMENTS.includes(segment) ||
  SECRET_NAME.test(segment) ||
  KEY_FILE.test(segment);

/** What a snapshot copy has taken so far, checked against the job's caps after every file. */
interface SnapshotWalk {
  game: string;
  destination: string;
  rule: PluginNativeProjectSnapshot;
  files: number;
  bytes: number;
}

const isExcluded = (rule: PluginNativeProjectSnapshot, relative: string) =>
  (rule.exclude ?? []).some((e) => relative === e || relative.startsWith(`${e}/`));

/** Copy one regular file without following a link; it must still be the file that was listed. */
async function copySnapshotFile(walk: SnapshotWalk, relative: string, listed: { dev: number; ino: number }) {
  const handle = await openNoFollow(path.join(walk.game, relative), constants.O_RDONLY);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== listed.dev || opened.ino !== listed.ino)
      throw new Error(MESSAGE.Changed(relative));
    const destination = await open(path.join(walk.destination, relative), "wx", 0o600);
    try {
      for await (const chunk of handle.createReadStream({ autoClose: false })) await destination.writeFile(chunk);
    } finally {
      await destination.close();
    }
  } finally {
    await handle.close();
  }
}

async function copySnapshotEntry(walk: SnapshotWalk, relative: string): Promise<void> {
  const info = await lstat(path.join(walk.game, relative));
  if (info.isDirectory()) {
    // A folder swapped for a link after listing resolves elsewhere; refuse rather than follow it.
    if ((await containedReal(walk.game, relative)) !== path.join(walk.game, relative))
      throw new Error(MESSAGE.Changed(relative));
    await mkdir(path.join(walk.destination, relative));
    await copySnapshotFolder(walk, relative);
    return;
  }
  if (!info.isFile()) return;
  walk.files += 1;
  walk.bytes += info.size;
  if (walk.files > walk.rule.maxFiles) throw new Error(MESSAGE.TooManyFiles(walk.rule.maxFiles));
  if (walk.bytes > walk.rule.maxBytes) throw new Error(MESSAGE.TooLarge(walk.rule.maxBytes));
  await copySnapshotFile(walk, relative, info);
}

async function copySnapshotFolder(walk: SnapshotWalk, folder: string): Promise<void> {
  const entries = await readdir(path.join(walk.game, folder));
  for (const name of entries.sort()) {
    const relative = folder ? `${folder}/${name}` : name;
    if (isProtectedInputSegment(name) || isExcluded(walk.rule, relative)) continue;
    await copySnapshotEntry(walk, relative);
  }
}

/**
 * Copy the game into `destination` for a job that needs the whole project (an engine importing and
 * exporting it). Dotfiles, dependencies, agent files, key material, links and excluded paths are
 * left out; a game past the declared file or byte cap is refused. The copy is the job's to change
 * and is never delivered back.
 */
export async function copyProjectSnapshot(
  game: string,
  destination: string,
  rule: PluginNativeProjectSnapshot,
): Promise<{ files: number; bytes: number }> {
  const walk: SnapshotWalk = { game: await realpath(game), destination, rule, files: 0, bytes: 0 };
  await mkdir(destination, { recursive: true });
  await copySnapshotFolder(walk, "");
  return { files: walk.files, bytes: walk.bytes };
}
