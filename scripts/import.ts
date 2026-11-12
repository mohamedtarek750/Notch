/** Resumable private CET351 ingestion. Original PDFs never enter public/ or Git. */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { Unzip, UnzipInflate } from "fflate";
import manifest from "../pilot/source-manifest.json";

const MAX_FILE = 3_500_000;
const MAX_PACK = 20_000_000;
export const expectedFiles = manifest.sources.filter(
  (
    e,
  ): e is typeof e & {
    filename: string;
    sha256: string;
    physical_pages: number;
  } => "filename" in e && typeof e.filename === "string",
);
const expectedNames = new Set(expectedFiles.map((e) => e.filename));
export class PackError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export type ZipEntry = {
  name: string;
  compressed: number;
  expanded: number;
  offset: number;
};

/** Validate central + local metadata BEFORE any inflater is allocated; no ZIP64/multidisk/encryption. */
export function inspectPackZip(bytes: Uint8Array): ZipEntry[] {
  if (bytes.byteLength > MAX_PACK || bytes.byteLength < 22)
    throw new PackError("pack_size");
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let p = b.length - 22; p >= Math.max(0, b.length - 65557); p--) {
    if (
      b.readUInt32LE(p) === 0x06054b50 &&
      p + 22 + b.readUInt16LE(p + 20) === b.length
    ) {
      end = p;
      break;
    }
  }
  if (end < 0) throw new PackError("invalid_zip");
  const count = b.readUInt16LE(end + 10),
    size = b.readUInt32LE(end + 12),
    start = b.readUInt32LE(end + 16);
  if (
    b.readUInt16LE(end + 4) ||
    b.readUInt16LE(end + 6) ||
    b.readUInt16LE(end + 8) !== count ||
    count > 6 ||
    count === 0 ||
    count === 0xffff ||
    start === 0xffffffff ||
    size === 0xffffffff ||
    start + size !== end
  )
    throw new PackError("zip_limits");
  let p = start,
    total = 0;
  const seen = new Set<string>();
  const entries: ZipEntry[] = [];
  const ranges: { start: number; end: number }[] = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || b.readUInt32LE(p) !== 0x02014b50)
      throw new PackError("invalid_zip");
    const flags = b.readUInt16LE(p + 8),
      method = b.readUInt16LE(p + 10),
      compressed = b.readUInt32LE(p + 20),
      expanded = b.readUInt32LE(p + 24);
    const nameLen = b.readUInt16LE(p + 28),
      extraLen = b.readUInt16LE(p + 30),
      commentLen = b.readUInt16LE(p + 32),
      offset = b.readUInt32LE(p + 42);
    if (p + 46 + nameLen + extraLen + commentLen > end)
      throw new PackError("invalid_zip");
    const raw = b.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const name = raw.normalize("NFC");
    if (
      raw.includes("/") ||
      raw.includes("\\") ||
      raw.includes("\0") ||
      !expectedNames.has(name)
    )
      throw new PackError("unexpected_entry");
    if (seen.has(name)) throw new PackError("duplicate_entry");
    seen.add(name);
    total += expanded;
    if (
      flags & 1 ||
      ![0, 8].includes(method) ||
      expanded > MAX_FILE ||
      compressed > MAX_FILE ||
      expanded === 0 ||
      total > MAX_PACK ||
      offset + 30 > start
    )
      throw new PackError("zip_limits");
    // Local names/methods must agree, and data cannot overlap the central directory.
    if (
      b.readUInt32LE(offset) !== 0x04034b50 ||
      b.readUInt16LE(offset + 8) !== method ||
      b.readUInt16LE(offset + 6) !== flags
    )
      throw new PackError("invalid_zip");
    const localNameLen = b.readUInt16LE(offset + 26),
      localExtraLen = b.readUInt16LE(offset + 28);
    const dataStart = offset + 30 + localNameLen + localExtraLen;
    if (
      dataStart + compressed > start ||
      b.subarray(offset + 30, offset + 30 + localNameLen).toString("utf8") !==
        raw
    )
      throw new PackError("invalid_zip");
    if (ranges.some((r) => offset < r.end && dataStart + compressed > r.start))
      throw new PackError("overlapping_entries");
    ranges.push({ start: offset, end: dataStart + compressed });
    entries.push({ name, compressed, expanded, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (p !== end) throw new PackError("invalid_zip");
  return entries;
}

/** Inflate incrementally with a second actual-output bound, independent of claimed ZIP sizes. */
export function extractPackZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const metadata = inspectPackZip(bytes);
  const result = new Map<string, Uint8Array>();
  let total = 0,
    failure: Error | undefined;
  const unzip = new Unzip((file) => {
    const expected = metadata.find(
      (e) => e.name === file.name.normalize("NFC"),
    );
    if (!expected || result.has(expected.name)) {
      failure = new PackError("unexpected_entry");
      file.terminate();
      return;
    }
    let count = 0;
    const chunks: Uint8Array[] = [];
    file.ondata = (error, chunk, final) => {
      if (error) {
        failure = new PackError("invalid_zip");
        file.terminate();
        return;
      }
      count += chunk.length;
      total += chunk.length;
      if (count > expected.expanded || count > MAX_FILE || total > MAX_PACK) {
        failure = new PackError("expanded_limit");
        file.terminate();
        return;
      }
      chunks.push(chunk);
      if (final) {
        if (count !== expected.expanded) {
          failure = new PackError("expanded_size");
          return;
        }
        result.set(expected.name, new Uint8Array(Buffer.concat(chunks)));
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    // Small input slices prevent a hostile deflate stream from allocating an unbounded output batch.
    for (let offset = 0; offset < bytes.length; offset += 128) {
      unzip.push(
        bytes.subarray(offset, offset + 128),
        offset + 128 >= bytes.length,
      );
      if (failure) throw failure;
    }
  } catch (e) {
    throw e instanceof PackError ? e : new PackError("invalid_zip");
  }
  if (result.size !== metadata.length) throw new PackError("incomplete_zip");
  return result;
}
export function verifyOriginal(name: string, bytes: Uint8Array): void {
  const expected = expectedFiles.find((e) => e.filename === name);
  if (!expected) throw new PackError("unexpected_entry");
  if (bytes.length > MAX_FILE) throw new PackError("file_size");
  if (createHash("sha256").update(bytes).digest("hex") !== expected.sha256)
    throw new PackError("hash_mismatch");
}

async function run() {
  const { values } = parseArgs({
    options: {
      directory: { type: "string" },
      zip: { type: "string" },
      tenant: { type: "string" },
      user: { type: "string" },
      register: { type: "boolean", default: false },
    },
  });
  if (
    !values.tenant ||
    !values.user ||
    (!!values.directory && !!values.zip) ||
    (!values.directory && !values.zip && !values.register)
  ) {
    throw new PackError(
      "usage: npm run import:pack -- --tenant TENANT --user INSTRUCTOR_USER [--directory PRIVATE_DIR | --zip PRIVATE_ZIP] [--register]",
    );
  }
  const { authorizeCourse } = await import("../src/server/auth");
  const { importLecture, registerPack } = await import("../src/server/sources");
  const { db } = await import("../src/server/db");
  const ctx = {
    tenantId: values.tenant,
    userId: values.user,
    role: "instructor" as const,
    courseId: "CET351",
    locale: "ar" as const,
  };
  try {
    await authorizeCourse(ctx, "CET351", "write");
    if (values.register) {
      const registered = await registerPack(ctx);
      console.log(JSON.stringify({ action: "register", result: registered }));
    }
    let packed: Map<string, Uint8Array> | undefined;
    if (values.zip) {
      const stat = await fs.stat(values.zip);
      if (stat.size > MAX_PACK) throw new PackError("pack_size");
      packed = extractPackZip(await fs.readFile(values.zip));
    }
    if (!values.directory && !packed) return;
    const statuses: {
      filename: string;
      status: string;
      error?: string;
      result?: unknown;
    }[] = [];
    for (const expected of expectedFiles) {
      try {
        let bytes: Uint8Array;
        if (packed) {
          const value = packed.get(expected.filename);
          if (!value) throw new PackError("missing_file");
          bytes = value;
        } else {
          const filename = path.join(
            path.resolve(values.directory!),
            expected.filename,
          );
          const info = await fs.lstat(filename);
          if (!info.isFile() || info.isSymbolicLink())
            throw new PackError("invalid_file");
          if (info.size > MAX_FILE) throw new PackError("file_size");
          bytes = await fs.readFile(filename);
        }
        verifyOriginal(expected.filename, bytes);
        const result = await importLecture(ctx, expected.filename, bytes);
        statuses.push({
          filename: expected.filename,
          status: "imported",
          result,
        });
      } catch (error) {
        // Safe labels only: never dump database errors or connection strings.
        statuses.push({
          filename: expected.filename,
          status: "failed",
          error:
            error instanceof PackError
              ? error.code
              : (error as { code?: string }).code || "import_failed",
        });
      }
      console.log(JSON.stringify(statuses.at(-1)));
    }
    if (statuses.some((s) => s.status === "failed")) process.exitCode = 1;
  } finally {
    await db.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  run().catch((error: unknown) => {
    console.error(
      error instanceof PackError
        ? error.code
        : "Import failed; check database connectivity and instructor authorization.",
    );
    process.exitCode = 1;
  });
}
