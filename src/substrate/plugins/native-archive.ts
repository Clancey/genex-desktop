import { lstat, readdir, readlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { isInside } from "../paths.ts";

const exec = promisify(execFile);
const ZIP_LIST_TIMEOUT_MS = 30 * SECOND_MS;
const ZIP_LIST_MAX_BUFFER = 4 * 1024 ** 2;
const ZIP_EXTRACT_TIMEOUT_MS = 5 * MINUTE_MS;

const MESSAGE = {
  UnsafeArchive: "Unsafe runtime archive",
  LinkOutside: (link: string) => `Runtime link ${link} leads outside the runtime`,
  MemberMissing: (member: string) => `Pinned download is missing ${member}`,
  MemberNotFile: (member: string) => `Pinned download member ${member} is not a regular file`,
} as const;

/** An archive entry that would land outside the folder it is unpacked into. */
export const isUnsafeArchiveEntry = (name: string) =>
  name.startsWith("/") || name.includes("\\") || name.split("/").includes("..");

/** Every link under `root` stays inside it and is relative; anything else is refused. */
export async function assertLinksInside(root: string): Promise<void> {
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await readlink(full);
        if (path.isAbsolute(target) || !isInside(root, path.resolve(dir, target)))
          throw new Error(MESSAGE.LinkOutside(path.relative(root, full)));
      } else if (entry.isDirectory()) await walk(full);
    }
  };
  if ((await lstat(root)).isDirectory()) await walk(root);
}

/** The entry names of a zip archive, refused when any would land outside the extraction folder. */
async function safeZipListing(archive: string, signal: AbortSignal): Promise<string[]> {
  const listing = await exec("/usr/bin/zipinfo", ["-1", archive], {
    signal,
    timeout: ZIP_LIST_TIMEOUT_MS,
    maxBuffer: ZIP_LIST_MAX_BUFFER,
  });
  const names = listing.stdout.split("\n").filter(Boolean);
  if (names.some(isUnsafeArchiveEntry)) throw new Error(MESSAGE.UnsafeArchive);
  return names;
}

/** Unpack a pinned zip runtime with `ditto`, keeping links only when they stay inside the stage. */
export async function extractZip(archive: string, stage: string, signal: AbortSignal): Promise<void> {
  await safeZipListing(archive, signal);
  await exec("/usr/bin/ditto", ["-x", "-k", archive, stage], { signal, timeout: ZIP_EXTRACT_TIMEOUT_MS });
  await assertLinksInside(stage);
}

/**
 * Unpack only `members` of a pinned zip (engine templates inside a much larger archive). Member
 * names are plain paths the manifest checked, so `unzip` reads them literally; each must arrive as
 * a regular file.
 */
export async function extractZipMembers(
  archive: string,
  stage: string,
  members: string[],
  signal: AbortSignal,
): Promise<void> {
  const names = new Set(await safeZipListing(archive, signal));
  const missing = members.find((m) => !names.has(m));
  if (missing) throw new Error(MESSAGE.MemberMissing(missing));
  await exec("/usr/bin/unzip", ["-qq", "-o", archive, ...members, "-d", stage], {
    signal,
    timeout: ZIP_EXTRACT_TIMEOUT_MS,
  });
  for (const member of members) {
    const info = await lstat(path.join(stage, member));
    if (!info.isFile()) throw new Error(MESSAGE.MemberNotFile(member));
  }
}
