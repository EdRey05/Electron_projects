import { mkdir, copyFile, rename, stat, unlink, utimes } from "node:fs/promises";
import { dirname, isAbsolute, sep } from "node:path";
import { randomUUID } from "node:crypto";

export interface CopyOptions {
  src: string;
  dest: string;
  /** If true, set atime+mtime on dest to match src after copy. */
  preserveTimestamps?: boolean;
  /** Initial backoff in ms; doubles each retry. */
  initialBackoffMs?: number;
  maxRetries?: number;
}

export interface CopyResult {
  bytes: number;
  /** True if a retry was needed (e.g. EBUSY on Windows for an open file). */
  retried: boolean;
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
 * Atomically copy src → dest. Writes to dest.tmp.<rand> first, then renames
 * (atomic on the same filesystem). On crash, the temp file is the only
 * artifact and is cleaned up by `cleanupStaleTemps` at the start of the next
 * Apply run.
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

  await mkdir(dirname(dest), { recursive: true });

  let attempt = 0;
  let backoff = initialBackoff;
  let retried = false;

  while (true) {
    const tmp = tmpName(dest);
    try {
      await copyFile(src, tmp);
      if (opts.preserveTimestamps) {
        const st = await stat(src);
        await utimes(tmp, st.atime, st.mtime);
      }
      await rename(tmp, dest);
      const finalStat = await stat(dest);
      return { bytes: finalStat.size, retried };
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
 * The temp-file suffix pattern used by `copyAtomic`. Shared with the trash
 * sweeper so stale temps from interrupted runs get cleaned up.
 */
export const TEMP_SUFFIX_RE = /\.tmp\.\d+\.[0-9a-f]+$/i;

export { sep };
