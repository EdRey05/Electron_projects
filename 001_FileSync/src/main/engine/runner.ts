import { existsSync } from "node:fs";
import { walk } from "./walker";
import { diff } from "./differ";
import { oneWayDiff } from "./oneway-diff";
import { openStateDb, loadStateMap } from "./state-db";
import { buildInventory, type SyncItem } from "@shared/inventory";
import { applyOverrides } from "@shared/overrides";
import type {
  ConflictPolicy,
  DiffPlan,
  JobFilters,
  OverrideMap,
  SideMeta,
  StateRecord,
  SyncDirection,
  WalkResult,
} from "@shared/types";

export interface DryRunOptions {
  jobId: string;
  sideA: string;
  sideB: string;
  /** Absolute path to the per-job sqlite file. Only used for `direction: "sync"`. */
  stateDbPath: string;
  /** Defaults to "sync" (bidirectional three-way merge). Mirror modes skip the state DB. */
  direction?: SyncDirection;
  filters?: JobFilters;
  policy?: ConflictPolicy;
  followSymlinks?: boolean;
  toleranceMs?: number;
  /** Mirror modes only: delete destination-only files. Defaults to true. */
  deleteExtraneous?: boolean;
  /** Per-path user action overrides from the sync table. */
  overrides?: OverrideMap;
}

export interface DryRunResult {
  jobId: string;
  sideA: string;
  sideB: string;
  direction: SyncDirection;
  walkA: { fileCount: number; totalBytes: number; durationMs: number };
  walkB: { fileCount: number; totalBytes: number; durationMs: number };
  stateLoadedRows: number;
  plan: DiffPlan;
  /**
   * The full sync table: one row per file AND per folder across both sides,
   * with the per-side metadata the table renders. Includes rows that need no
   * action, because AllwaySync shows the whole tree, not just the diff.
   */
  inventory: SyncItem[];
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
 * or touches either side. The Apply phase consumes the returned plan.
 */
export async function dryRun(opts: DryRunOptions): Promise<DryRunResult> {
  const t0 = Date.now();
  const direction: SyncDirection = opts.direction ?? "sync";

  const [walkA, walkB] = await Promise.all([
    walk({
      root: opts.sideA,
      filters: opts.filters,
      followSymlinks: opts.followSymlinks,
      sideExcludes: opts.filters?.excludeA,
    }),
    walk({
      root: opts.sideB,
      filters: opts.filters,
      followSymlinks: opts.followSymlinks,
      sideExcludes: opts.filters?.excludeB,
    }),
  ]);

  let plan: DiffPlan;
  let stateLoadedRows = 0;

  if (direction === "sync") {
    let state: Map<string, StateRecord> = new Map();
    if (existsSync(opts.stateDbPath)) {
      const db = await openStateDb(opts.stateDbPath);
      try {
        state = loadStateMap(db);
        stateLoadedRows = state.size;
      } finally {
        db.close();
      }
    }
    plan = diff({
      walkA: entriesToMap(walkA),
      walkB: entriesToMap(walkB),
      state,
      policy: opts.policy ?? "newer-wins",
      toleranceMs: opts.toleranceMs,
    });
  } else {
    // Mirror mode — pure stateless diff between current snapshots.
    plan = oneWayDiff({
      walkA: entriesToMap(walkA),
      walkB: entriesToMap(walkB),
      direction,
      toleranceMs: opts.toleranceMs,
      deleteExtraneous: opts.deleteExtraneous,
    });
  }

  // Build the full sync table, then fold the user's per-item overrides into
  // the runnable plan so the table, the counters and the Run button agree.
  const inventory = buildInventory(walkA, walkB, plan.actions);
  const overrides = opts.overrides ?? {};
  if (Object.keys(overrides).length > 0) {
    plan = applyOverrides(plan, overrides);
  }

  return {
    jobId: opts.jobId,
    sideA: opts.sideA,
    sideB: opts.sideB,
    direction,
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
    inventory,
    totalDurationMs: Date.now() - t0,
  };
}
