import { stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname } from "node:path";
import { copyAtomic } from "./copier";
import {
  backupToTrash,
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
import type { Action, ActionKind, DiffPlan } from "@shared/types";
import { copyBytes } from "@shared/plan-metrics";
import { fileInRoot, overlaps, validateRoots } from "./paths";

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
  currentAction?: ActionKind;
  stage?: "actions" | "trash-cleanup" | "complete";
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
  return plan.actions.reduce((acc, a) => acc + copyBytes(a), 0);
}

/**
 * Execute a DiffPlan against the two sides, updating the state DB as each
 * action succeeds. Per-action errors are recorded but do not abort the run —
 * status will be "partial" if any action failed.
 *
 * Atomicity: each copy goes through copier.copyAtomic (.tmp + rename); each
 * delete uses trash when enabled (otherwise permanent unlink). State DB
 * is updated only after verified copies and flushed after each action.
 * This is not a transaction across the filesystem and DB; re-analyze after
 * interruptions rather than assuming the whole folder completed atomically.
 */
const activeRoots = new Set<string>();

export async function apply(opts: ApplyOptions): Promise<ApplyResult> {
  const roots = await validateRoots(opts.sideA, opts.sideB);
  if (roots.some(root => [...activeRoots].some(active => overlaps(root, active)))) {
    throw new Error("A transfer is already using one of these folders; wait for it to finish");
  }
  for (const root of roots) activeRoots.add(root);
  try { return await applyUnlocked(opts); }
  finally { for (const root of roots) activeRoots.delete(root); }
}

async function applyUnlocked(opts: ApplyOptions): Promise<ApplyResult> {
  const startedAt = Date.now();
  const stamp = trashStamp(new Date(startedAt));
  const totalActions = opts.plan.actions.length;
  const bytesTotal = plannedBytes(opts.plan);

  // Do not sweep arbitrary user files matching a temp suffix, or another
  // process's active copy. Each copy cleans up only its own temp on failure.

  const db = await openStateDb(opts.stateDbPath);
  const runId = insertRunLog(db, startedAt);
  db.flush();

  let filesCopied = 0;
  let filesDeleted = 0;
  let conflicts = 0;
  let bytesTransferred = 0;
  const errors: ApplyError[] = [];

  let doneActions = 0;
  function emit(currentPath: string, currentAction?: ActionKind, stage: ApplyProgress["stage"] = "actions"): void {
    opts.onProgress?.({
      currentAction,
      stage,
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
    emit(action.path, action.kind);
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
        case "keep-both":
          filesCopied++;
          bytesTransferred += action.bytes;
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ path: action.path, action: action.kind, message });
      insertRunAction(db, runId, action.path, action.kind, action.bytes, false, message);
    }
    doneActions++;
    db.flush();
    emit(action.path, action.kind);
  }

  let trashSweep: { removedDirs: number; freedBytes: number } | null = null;
  if (opts.trash.enabled) {
    emit("", undefined, "trash-cleanup");
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
  emit("", undefined, "complete");

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
  fileInRoot(opts.sideA, action.path);
  fileInRoot(opts.sideB, action.path);
  if (!["noop", "drop-from-state", "conflict"].includes(action.kind)) {
    // Analyzed plans carry per-side metadata. Do not apply an old decision
    // over edits made while the user was reviewing it. No mtime tolerance:
    // this is a freshness guard, not the differ's equivalence heuristic.
    for (const side of ["a", "b"] as const) {
      const expected = side === "a" ? action.aExists : action.bExists;
      if (expected === undefined) continue; // legacy/programmatic plans
      const path = join(side === "a" ? opts.sideA : opts.sideB, action.path);
      const current = await stat(path).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return null;
        throw err;
      });
      const size = side === "a" ? action.aSize : action.bSize;
      const mtime = side === "a" ? action.aMtime : action.bMtime;
      if (expected !== !!current || (current && (current.size !== size || current.mtimeMs !== mtime))) {
        throw new Error(`Side ${side.toUpperCase()} changed since Analyze; analyze again before retrying`);
      }
    }
  }
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
      const copied = await copyAtomic({ src, dest, preserveTimestamps: opts.preserveTimestamps,
        beforeCommit: opts.trash.enabled && existsSync(dest) ? () => backupToTrash({
          filePath: dest,
          sideRoot: opts.sideB,
          jobId: opts.jobId,
          runTimestamp: stamp,
          relPath: action.path,
        }) : undefined,
      });
      upsertBothSides(
        db,
        action.path,
        copied.bytes,
        copied.sourceMtimeMs,
        copied.bytes,
        copied.destMtimeMs,
        Date.now(),
      );
      insertRunAction(db, runId, action.path, action.kind, action.bytes, true);
      return;
    }

    case "copy-b-to-a": {
      const src = join(opts.sideB, action.path);
      const dest = join(opts.sideA, action.path);
      const copied = await copyAtomic({ src, dest, preserveTimestamps: opts.preserveTimestamps,
        beforeCommit: opts.trash.enabled && existsSync(dest) ? () => backupToTrash({
          filePath: dest,
          sideRoot: opts.sideA,
          jobId: opts.jobId,
          runTimestamp: stamp,
          relPath: action.path,
        }) : undefined,
      });
      upsertBothSides(
        db,
        action.path,
        copied.bytes,
        copied.destMtimeMs,
        copied.bytes,
        copied.sourceMtimeMs,
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

    case "keep-both": {
      // Both versions survive side by side. The losing side is renamed with
      // an .A./.B. suffix instead of being overwritten or trashed.
      const src = join(opts.sideA, action.path);
      const dest = join(opts.sideB, action.path);
      const ext = extname(action.path);
      const stem = action.path.slice(0, action.path.length - ext.length);
      const stampShort = stamp.replace(/[^0-9]/g, "").slice(0, 14);

      // A is preserved under .A.<stamp>, B is copied over the original.
      const aKept = join(opts.sideA, `${stem}.A${stampShort}${ext}`);
      if (existsSync(src)) {
        await copyAtomic({ src, dest: aKept, preserveTimestamps: opts.preserveTimestamps });
      }
      // B is preserved under .B.<stamp> and also copied over the original.
      if (existsSync(dest)) {
        const bKept = join(opts.sideB, `${stem}.B${stampShort}${ext}`);
        await copyAtomic({ src: dest, dest: bKept, preserveTimestamps: opts.preserveTimestamps });
      }
      // Now A's content wins the original name on B.
      if (existsSync(src)) {
        const copied = await copyAtomic({ src, dest, preserveTimestamps: opts.preserveTimestamps });
        upsertBothSides(
          db,
          action.path,
          copied.bytes,
          copied.sourceMtimeMs,
          copied.bytes,
          copied.destMtimeMs,
          Date.now(),
        );
      }
      insertRunAction(
        db,
        runId,
        action.path,
        action.kind,
        action.bytes,
        true,
        `kept both versions (${stem}.A${stampShort}${ext} / ${stem}.B${stampShort}${ext})`,
      );
      return;
    }
  }
}
