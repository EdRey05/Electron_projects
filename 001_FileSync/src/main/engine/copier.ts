import { mkdir, copyFile, rename, stat, unlink, utimes, open } from "node:fs/promises";
import { createReadStream, constants, type Stats } from "node:fs";
import { dirname, isAbsolute, sep, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";

export interface CopyOptions {
  src: string;
  dest: string;
  /** If true, set atime+mtime on dest to match src after copy. */
  preserveTimestamps?: boolean;
  /** Initial backoff in ms; doubles each retry. */
  initialBackoffMs?: number;
  maxRetries?: number;
  /** Called only once the replacement is verified, before it replaces dest.
   * The callback must leave the current destination in place (e.g. back it up).
   */
  beforeCommit?(): Promise<void>;
}

export interface CopyResult {
  bytes: number;
  /** True if a retry was needed (e.g. EBUSY on Windows for an open file). */
  retried: boolean;
  /** SHA-256 of the source and independently read temporary copy. */
  sha256: string;
  /** Metadata of the verified bytes, not a later observation of a live file. */
  sourceMtimeMs: number;
  destMtimeMs: number;
}

const RETRY_CODES = new Set(["EBUSY", "EPERM", "EACCES", "EMFILE", "ENFILE"]);

/**
 * Windows extended-length path prefix.
 *
 * Win32 APIs without the `\\?\` prefix fail past MAX_PATH (260 chars) unless
 * the process opts into long-path support. The prefix bypasses that limit
 * entirely. `path.relative` does NOT understand the prefix, so it is applied
 * only at the syscall boundary — never to paths used for relative() or join().
 *
 * UNC paths (`\\server\share`) need the prefix as `\\?\UNC\server\share`.
 */
export function toLongPath(p: string): string {
  if (!isAbsolute(p)) return p;
  if (p.startsWith("\\\\?\\")) return p;
  if (p.startsWith("\\\\")) {
    return `\\\\?\\UNC\\${p.slice(2)}`;
  }
  return `\\\\?\\${p}`;
}

/**
 * Resolve a path for a syscall, using the long-path form on Windows.
 * Non-Windows platforms get the path unchanged.
 */
export function syscallPath(p: string): string {
  if (process.platform !== "win32") return p;
  return toLongPath(p);
}

function tmpName(dest: string): string {
  return `${dest}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
}

export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(syscallPath(path))) hash.update(chunk);
  return hash.digest("hex");
}

function unchanged(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

async function statOrMissing(path: string): Promise<Stats | null> {
  try { return await stat(path); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function assertUnchanged(path: string, before: Stats | null, label: string): Promise<void> {
  const after = await statOrMissing(path);
  if (before === null ? after !== null : after === null || !unchanged(before, after)) {
    throw new Error(`${label} changed during transfer; analyze again before retrying`);
  }
}

function isRetryable(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code: string }).code === "string" &&
    RETRY_CODES.has((err as { code: string }).code)
  );
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Copy to a sibling temp, independently verify its SHA-256 and flush it,
 * then rename into place. The old destination survives pre-commit failures.
 * Refuse detected source/destination changes instead of overwriting newer data.
 * This is per-file replacement, not a snapshot or a power-loss guarantee.
 *
 * Retries transient EBUSY/EPERM/EACCES/EMFILE/ENFILE with exponential backoff.
 * Other errors propagate to the applier, which records them in run_action.
 *
 * All paths are resolved through `syscallPath`, so files deeper than 260
 * characters copy correctly on Windows.
 */
export async function copyAtomic(opts: CopyOptions): Promise<CopyResult> {
  const initialBackoff = opts.initialBackoffMs ?? 50;
  const maxRetries = opts.maxRetries ?? 5;

  const src = syscallPath(opts.src);
  const dest = syscallPath(opts.dest);

  if (resolve(opts.src) === resolve(opts.dest)) throw new Error("Source and destination are the same file");

  await mkdir(dirname(dest), { recursive: true });

  let attempt = 0;
  let backoff = initialBackoff;
  let retried = false;

  while (true) {
    const tmp = tmpName(dest);
    try {
      const sourceBefore = await stat(src);
      const destBefore = await statOrMissing(dest);
      if (!sourceBefore.isFile()) throw new Error("Source must be a regular file");
      if (destBefore && sourceBefore.dev === destBefore.dev && sourceBefore.ino === destBefore.ino) {
        throw new Error("Source and destination are the same file");
      }
      const sha256 = await hashFile(src);
      await assertUnchanged(src, sourceBefore, "Source");
      await copyFile(src, tmp, constants.COPYFILE_EXCL);
      if ((await stat(tmp)).size !== sourceBefore.size || await hashFile(tmp) !== sha256) {
        throw new Error("Copy verification failed (SHA-256/size mismatch); destination was not replaced");
      }
      if (opts.preserveTimestamps) {
        await utimes(tmp, sourceBefore.atime, sourceBefore.mtime);
      }
      const handle = await open(tmp, "r+");
      try { await handle.sync(); } finally { await handle.close(); }
      await assertUnchanged(src, sourceBefore, "Source");
      await assertUnchanged(dest, destBefore, "Destination");
      await opts.beforeCommit?.();
      await assertUnchanged(src, sourceBefore, "Source");
      await assertUnchanged(dest, destBefore, "Destination");
      const stagedStat = await stat(tmp);
      await rename(tmp, dest);
      return { bytes: sourceBefore.size, retried, sha256,
        sourceMtimeMs: sourceBefore.mtimeMs, destMtimeMs: stagedStat.mtimeMs };
    } catch (err) {
      // Best-effort cleanup of the temp file we may have created.
      await unlink(tmp).catch(() => undefined);
      if (attempt < maxRetries && isRetryable(err)) {
        retried = true;
        await sleep(backoff);
        backoff *= 2;
        attempt++;
        continue;
      }
      throw err;
    }
  }
}

/**
 * Reserved transfer suffix. The walker ignores interrupted copies; apply
 * never deletes arbitrary files just because they match this pattern.
 */
export const TEMP_SUFFIX_RE = /\.tmp\.\d+\.[0-9a-f]+$/i;

export { sep };
