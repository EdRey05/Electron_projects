import {
  copyFile,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";

export const TRASH_DIR_NAME = ".filesync-trash";

/** Stamp suitable for filesystem path use: 2026-04-26T14-30-00-123Z */
export function trashStamp(d: Date = new Date()): string {
  return d
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\./g, "-");
}

export interface MoveToTrashOptions {
  /** Absolute path of the file currently to be removed. */
  filePath: string;
  /** Absolute path of the side root (sideA or sideB). */
  sideRoot: string;
  /** Job id, used to namespace the trash. */
  jobId: string;
  /** Per-run timestamp for the trash subfolder. */
  runTimestamp: string;
  /** Path of the file relative to sideRoot, preserved inside the trash. */
  relPath: string;
}

export interface MoveToTrashResult {
  trashedTo: string;
  bytes: number;
}

/**
 * Move a file under sideRoot/.filesync-trash/<jobId>/<runTimestamp>/<relPath>.
 * Uses rename() if the trash is on the same volume; falls back to copy+unlink
 * across volumes (rare for local sync but possible if .filesync-trash is on a
 * symlinked path). Returns the bytes freed (size of the trashed file).
 */
export async function moveToTrash(opts: MoveToTrashOptions): Promise<MoveToTrashResult> {
  const target = join(
    opts.sideRoot,
    TRASH_DIR_NAME,
    opts.jobId,
    opts.runTimestamp,
    opts.relPath,
  );
  const st = await stat(opts.filePath);
  await mkdir(dirname(target), { recursive: true });

  try {
    await rename(opts.filePath, target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      // Cross-device rename — fall back to copy + unlink.
      await copyFile(opts.filePath, target);
      await unlink(opts.filePath);
    } else {
      throw err;
    }
  }

  return { trashedTo: target, bytes: st.size };
}

export interface SweepTrashOptions {
  sideRoot: string;
  retainDays: number;
  /** Override "now" for testing. */
  now?: Date;
}

export interface SweepTrashResult {
  removedDirs: number;
  freedBytes: number;
}

async function dirSizeBytes(p: string): Promise<number> {
  let total = 0;
  const stack: string[] = [p];
  while (stack.length) {
    const cur = stack.pop()!;
    const entries = await readdir(cur, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else {
        const st = await stat(full).catch(() => null);
        if (st) total += st.size;
      }
    }
  }
  return total;
}

/**
 * Delete dated trash folders older than `retainDays` for the given side.
 * Looks at <sideRoot>/.filesync-trash/<jobId>/<runTimestamp>/ — if the folder's
 * mtime is older than the cutoff, the entire folder is removed.
 *
 * Empty parent jobId folders are removed as well, so the trash tree stays tidy.
 */
export async function sweepTrash(opts: SweepTrashOptions): Promise<SweepTrashResult> {
  const trashRoot = join(opts.sideRoot, TRASH_DIR_NAME);
  if (!existsSync(trashRoot)) return { removedDirs: 0, freedBytes: 0 };

  const now = (opts.now ?? new Date()).getTime();
  const cutoff = now - opts.retainDays * 24 * 60 * 60 * 1000;

  let removedDirs = 0;
  let freedBytes = 0;

  const jobs = await readdir(trashRoot, { withFileTypes: true });
  for (const jobEntry of jobs) {
    if (!jobEntry.isDirectory()) continue;
    const jobDir = join(trashRoot, jobEntry.name);
    const runs = await readdir(jobDir, { withFileTypes: true });
    for (const runEntry of runs) {
      if (!runEntry.isDirectory()) continue;
      const runDir = join(jobDir, runEntry.name);
      const st = await stat(runDir).catch(() => null);
      if (!st) continue;
      if (st.mtimeMs < cutoff) {
        const sz = await dirSizeBytes(runDir);
        await rm(runDir, { recursive: true, force: true });
        removedDirs++;
        freedBytes += sz;
      }
    }
    // Drop empty jobId folder.
    const remaining = await readdir(jobDir).catch(() => [] as string[]);
    if (remaining.length === 0) {
      await rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return { removedDirs, freedBytes };
}

/**
 * Find and remove any leftover .tmp.<pid>.<rand> files from interrupted Apply
 * runs. Called at the start of every Apply run so each attempt starts clean.
 *
 * The matcher is intentionally narrow: only files whose name contains the
 * literal segment ".tmp." followed by a numeric pid and a hex chunk. We never
 * delete user files that happen to have ".tmp" in the name.
 */
const TEMP_RE = /\.tmp\.\d+\.[0-9a-f]+$/i;

export async function cleanupStaleTemps(root: string): Promise<{ removed: number }> {
  if (!existsSync(root)) return { removed: 0 };
  let removed = 0;
  const stack: string[] = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur.endsWith(`${sep}${TRASH_DIR_NAME}`)) continue; // never recurse into trash
    const entries = await readdir(cur, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = join(cur, e.name);
      if (e.isDirectory()) {
        if (e.name === TRASH_DIR_NAME) continue;
        stack.push(full);
      } else if (TEMP_RE.test(e.name)) {
        // Sanity: only remove if it's a regular file (not a dir).
        const st = statSync(full);
        if (st.isFile()) {
          await unlink(full).catch(() => undefined);
          removed++;
        }
      }
    }
  }
  return { removed };
}
