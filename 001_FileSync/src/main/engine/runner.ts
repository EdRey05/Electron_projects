import { existsSync } from "node:fs";
import { walk } from "./walker";
import { diff } from "./differ";
import { openStateDb, loadStateMap } from "./state-db";
import type {
  ConflictPolicy,
  DiffPlan,
  JobFilters,
  SideMeta,
  StateRecord,
  WalkResult,
} from "@shared/types";

export interface DryRunOptions {
  jobId: string;
  sideA: string;
  sideB: string;
  /** Absolute path to the per-job sqlite file. If missing on disk, treated as empty state. */
  stateDbPath: string;
  filters?: JobFilters;
  policy?: ConflictPolicy;
  followSymlinks?: boolean;
  toleranceMs?: number;
}

export interface DryRunResult {
  jobId: string;
  sideA: string;
  sideB: string;
  walkA: { fileCount: number; totalBytes: number; durationMs: number };
  walkB: { fileCount: number; totalBytes: number; durationMs: number };
  stateLoadedRows: number;
  plan: DiffPlan;
  totalDurationMs: number;
}

function entriesToMap(walk: WalkResult): Map<string, SideMeta> {
  const m = new Map<string, SideMeta>();
  for (const e of walk.entries) {
    if (e.isDirectory) continue;
    m.set(e.relPath, { size: e.size, mtimeMs: e.mtimeMs });
  }
  return m;
}

/**
 * Compute a dry-run plan for one job: walk both sides in parallel, load the
 * persisted state, and run the differ. Pure read — never writes the state DB
 * or touches either side. The Apply phase (week 3) consumes the returned plan.
 */
export async function dryRun(opts: DryRunOptions): Promise<DryRunResult> {
  const t0 = Date.now();

  const [walkA, walkB] = await Promise.all([
    walk({ root: opts.sideA, filters: opts.filters, followSymlinks: opts.followSymlinks }),
    walk({ root: opts.sideB, filters: opts.filters, followSymlinks: opts.followSymlinks }),
  ]);

  let state: Map<string, StateRecord> = new Map();
  let stateLoadedRows = 0;
  if (existsSync(opts.stateDbPath)) {
    const db = await openStateDb(opts.stateDbPath);
    try {
      state = loadStateMap(db);
      stateLoadedRows = state.size;
    } finally {
      db.close();
    }
  }

  const plan = diff({
    walkA: entriesToMap(walkA),
    walkB: entriesToMap(walkB),
    state,
    policy: opts.policy ?? "newer-wins",
    toleranceMs: opts.toleranceMs,
  });

  return {
    jobId: opts.jobId,
    sideA: opts.sideA,
    sideB: opts.sideB,
    walkA: {
      fileCount: walkA.fileCount,
      totalBytes: walkA.totalBytes,
      durationMs: walkA.durationMs,
    },
    walkB: {
      fileCount: walkB.fileCount,
      totalBytes: walkB.totalBytes,
      durationMs: walkB.durationMs,
    },
    stateLoadedRows,
    plan,
    totalDurationMs: Date.now() - t0,
  };
}
