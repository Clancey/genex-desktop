import { crc32 } from "node:zlib";

/** One stored zip entry: a file (`mode` 0o644 or 0o755), a directory (name ends in "/") or a link. */
export interface ZipEntry {
  name: string;
  data?: string | Buffer;
  mode?: number;
  /** The link target; makes the entry a Unix symbolic link. */
  link?: string;
}

const UNIX_HOST = 3 << 8;
const VERSION = 20;
const FILE_TYPE = 0o100000;
const DIR_TYPE = 0o040000;
const LINK_TYPE = 0o120000;
/** 1980-01-01, the first date a zip header can hold. */
const DOS_DATE = (1 << 5) | 1;

function entryMode(e: ZipEntry): number {
  if (e.link !== undefined) return LINK_TYPE | 0o777;
  if (e.name.endsWith("/")) return DIR_TYPE | 0o755;
  return FILE_TYPE | (e.mode ?? 0o644);
}

/**
 * A stored (uncompressed) zip archive written verbatim, so tests can build archives no archiver
 * would: parent-relative and absolute names, and links that leave the extraction folder.
 */
export function zipArchive(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const data = Buffer.from(e.link ?? e.data ?? "");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(UNIX_HOST | VERSION, 4);
    central.writeUInt16LE(VERSION, 6);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((entryMode(e) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
