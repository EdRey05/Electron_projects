import { stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { copyAtomic } from "./copier";
import {
  cleanupStaleTemps,
  moveToTrash,
  sweepTrash,
  trashStamp,
} from "./trash";
import {
  insertRunAction,
  insertRunLog,
  openStateDb,
  removeStatePath,
  updateRunLog,
  upsertBothSides,
} from "./state-db";
import type { Action, DiffPlan } from "@shared/types";

export interface ApplyOptions {
  jobId: string;
  sideA: string;
  sideB: string;
  /** Absolute path to the per-job state DB (will be created if missing). */
  stateDbPath: string;
  plan: DiffPlan;
  trash: { enabled: boolean; retainDays: number };
  preserveTimestamps?: boolean;
  onProgress?(p: ApplyProgress): void;
}

export interface ApplyProgress {
  doneActions: number;
  totalActions: number;
  bytesTransferred: number;
  bytesTotal: number;
  currentPath: string;
  errors: number;
}

export interface ApplyError {
  path: string;
  action: string;
  message: string;
}

export interface ApplyResult {
  runId: number;
  jobId: string;
  startedAt: number;
  endedAt: number;
  status: "ok" | "partial" | "error";
  filesCopied: number;
  filesDeleted: number;
  conflicts: number;
  bytesTransferred: number;
  errors: ApplyError[];
  trashSweep: { removedDirs: number; freedBytes: number } | null;
}

function plannedBytes(plan: DiffPlan): number {
  return plan.actions.reduce((acc, a) => acc + (a.bytes || 0), 0);
}

/**
 * Execute a DiffPlan against the two sides, updating the state DB as each
 * action succeeds. Per-action errors are recorded but do not abort the run —
 * status will be "partial" if any action failed.
 *
 * Atomicity: each copy goes through copier.copyAtomic (.tmp + rename); each
 * delete is moveToTrash (rename into .filesync-trash/, never unlink). State DB
 * is flushed after every action so a crash mid-run leaves the DB consistent
 * with the work already done — the next run resumes naturally.
 */
export async function apply(opts: ApplyOptions): Promise<ApplyResult> {
  const startedAt = Date.now();
  const stamp = trashStamp(new Date(startedAt));
  const totalActions = opts.plan.actions.length;
  const bytesTotal = plannedBytes(opts.plan);

  // Cleanup any leftover .tmp.<pid>.<rand> files from prior interrupted runs.
  await cleanupStaleTemps(opts.sideA);
  await cleanupStaleTemps(opts.sideB);

  const db = await openStateDb(opts.stateDbPath);
  const runId = insertRunLog(db, startedAt);
  db.flush();

  let filesCopied = 0;
  let filesDeleted = 0;
  let conflicts = 0;
  let bytesTransferred = 0;
  const errors: ApplyError[] = [];

  let doneActions = 0;
  function emit(currentPath: string): void {
    opts.onProgress?.({
      doneActions,
      totalActions,
      bytesTransferred,
      bytesTotal,
      currentPath,
      errors: errors.length,
    });
  }

  emit("");

  for (const action of opts.plan.actions) {
    try {
      await runAction(action, opts, stamp, db, runId);
      switch (action.kind) {
        case "copy-a-to-b":
        case "copy-b-to-a":
          filesCopied++;
          bytesTransferred += action.bytes;
          break;
        case "delete-a":
        case "delete-b":
          filesDeleted++;
          break;
        case "conflict":
          conflicts++;
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ path: action.path, action: action.kind, message });
      insertRunAction(db, runId, action.path, action.kind, action.bytes, false, message);
    }
    doneActions++;
    db.flush();
    emit(action.path);
  }

  let trashSweep: { removedDirs: number; freedBytes: number } | null = null;
  if (opts.trash.enabled) {
    const a = await sweepTrash({
      sideRoot: opts.sideA,
      retainDays: opts.trash.retainDays,
    });
    const b = await sweepTrash({
      sideRoot: opts.sideB,
      retainDays: opts.trash.retainDays,
    });
    trashSweep = {
      removedDirs: a.removedDirs + b.removedDirs,
      freedBytes: a.freedBytes + b.freedBytes,
    };
  }

  const status: "ok" | "partial" | "error" =
    errors.length === 0 ? "ok" : errors.length === totalActions ? "error" : "partial";
  const endedAt = Date.now();
  updateRunLog(db, runId, {
    endedAt,
    filesCopied,
    filesDeleted,
    conflicts,
    bytesTransferred,
    status,
    error: errors.length > 0 ? `${errors.length} action(s) failed` : null,
  });
  db.flush();
  db.close();

  return {
    runId,
    jobId: opts.jobId,
    startedAt,
    endedAt,
    status,
    filesCopied,
    filesDeleted,
    conflicts,
    bytesTransferred,
    errors,
    trashSweep,
  };
}

async function runAction(
  action: Action,
  opts: ApplyOptions,
  stamp: string,
  db: Awaited<ReturnType<typeof openStateDb>>,
  runId: number,
): Promise<void> {
  switch (action.kind) {
    case "noop":
      return; // nothing to do; don't even log

    case "drop-from-state": {
      removeStatePath(db, action.path);
      insertRunAction(db, runId, action.path, action.kind, 0, true, "removed stale state row");
      return;
    }

    case "copy-a-to-b": {
      const src = join(opts.sideA, action.path);
      const dest = join(opts.sideB, action.path);
      // If dest existed and trash is enabled, move the old version to trash first.
      if (opts.trash.enabled && existsSync(dest)) {
        await moveToTrash({
          filePath: dest,
          sideRoot: opts.sideB,
          jobId: opts.jobId,
          runTimestamp: stamp,
          relPath: action.path,
        });
      }
      await copyAtomic({ src, dest, preserveTimestamps: opts.preserveTimestamps });
      const aStat = await stat(src);
      const bStat = await stat(dest);
      upsertBothSides(
        db,
        action.path,
        aStat.size,
        aStat.mtimeMs,
        bStat.size,
        bStat.mtimeMs,
        Date.now(),
      );
      insertRunAction(db, runId, action.path, action.kind, action.bytes, true);
      return;
    }

    case "copy-b-to-a": {
      const src = join(opts.sideB, action.path);
      const dest = join(opts.sideA, action.path);
      if (opts.trash.enabled && existsSync(dest)) {
        await moveToTrash({
          filePath: dest,
          sideRoot: opts.sideA,
          jobId: opts.jobId,
          runTimestamp: stamp,
          relPath: action.path,
        });
      }
      await copyAtomic({ src, dest, preserveTimestamps: opts.preserveTimestamps });
      const bStat = await stat(src);
      const aStat = await stat(dest);
      upsertBothSides(
        db,
        action.path,
        aStat.size,
        aStat.mtimeMs,
        bStat.size,
        bStat.mtimeMs,
        Date.now(),
      );
      insertRunAction(db, runId, action.path, action.kind, action.bytes, true);
      return;
    }

    case "delete-a": {
      const target = join(opts.sideA, action.path);
      if (existsSync(target)) {
        if (opts.trash.enabled) {
          await moveToTrash({
            filePath: target,
            sideRoot: opts.sideA,
            jobId: opts.jobId,
            runTimestamp: stamp,
            relPath: action.path,
          });
        } else {
          const { unlink } = await import("node:fs/promises");
          await unlink(target);
        }
      }
      removeStatePath(db, action.path);
      insertRunAction(db, runId, action.path, action.kind, action.bytes, true);
      return;
    }

    case "delete-b": {
      const target = join(opts.sideB, action.path);
      if (existsSync(target)) {
        if (opts.trash.enabled) {
          await moveToTrash({
            filePath: target,
            sideRoot: opts.sideB,
            jobId: opts.jobId,
            runTimestamp: stamp,
            relPath: action.path,
          });
        } else {
          const { unlink } = await import("node:fs/promises");
          await unlink(target);
        }
      }
      removeStatePath(db, action.path);
      insertRunAction(db, runId, action.path, action.kind, action.bytes, true);
      return;
    }

    case "conflict": {
      // Differ already auto-resolves under newer-wins. If we're still seeing a
      // conflict here, the policy was rename-both or ask — neither is wired
      // into apply for v1. Record and skip; user can resolve and re-run.
      insertRunAction(
        db,
        runId,
        action.path,
        action.kind,
        0,
        false,
        `conflict skipped (policy=${action.conflict?.suggested}); apply does not yet auto-resolve rename-both/ask`,
      );
      return;
    }
  }
}
