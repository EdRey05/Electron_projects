import { mkdir, copyFile, rename, stat, unlink, utimes } from "node:fs/promises";
import { dirname } from "node:path";
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
 */
export async function copyAtomic(opts: CopyOptions): Promise<CopyResult> {
  const initialBackoff = opts.initialBackoffMs ?? 50;
  const maxRetries = opts.maxRetries ?? 5;

  await mkdir(dirname(opts.dest), { recursive: true });

  let attempt = 0;
  let backoff = initialBackoff;
  let retried = false;

  while (true) {
    const tmp = tmpName(opts.dest);
    try {
      await copyFile(opts.src, tmp);
      if (opts.preserveTimestamps) {
        const st = await stat(opts.src);
        await utimes(tmp, st.atime, st.mtime);
      }
      await rename(tmp, opts.dest);
      const finalStat = await stat(opts.dest);
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
