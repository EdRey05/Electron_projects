import type {
  Action,
  ActionKind,
  DiffPlan,
  DiffSummary,
  ItemAction,
  OverrideMap,
} from "./types";
import { effectiveAction, resolveOverride } from "./inventory";

export { effectiveAction, resolveOverride, overrideMatches } from "./inventory";

export interface OverrideTarget {
  /** The item's own path. */
  path: string;
  aExists: boolean;
  bExists: boolean;
  isDirectory: boolean;
}

/**
 * Rewrite a diff plan so it reflects the user's per-item action choices.
 *
 * The differ proposes an action per path; the user then overrides any subset
 * of those paths (or a whole folder) in the sync table. This module applies
 * the overrides and recomputes the summary, so the table, the counts and the
 * Run button all agree on what is about to happen.
 *
 * Pure: it never touches the filesystem or the state DB.
 */
export function applyOverrides(
  plan: DiffPlan,
  overrides: OverrideMap,
  /** Extra rows (folders) that need a plan entry even when the differ had none. */
  extraTargets?: OverrideTarget[],
): DiffPlan {
  const actions: Action[] = [];

  for (const action of plan.actions) {
    const override = resolveOverride(action.path, overrides);
    const target: OverrideTarget = {
      path: action.path,
      aExists: action.aExists ?? action.kind !== "delete-a",
      bExists: action.bExists ?? action.kind !== "delete-b",
      isDirectory: action.isDirectory ?? false,
    };

    if (override === "auto") {
      actions.push(action);
      continue;
    }

    if (override === "skip") {
      // Keep the row visible in the table (it is rendered from the inventory,
      // not from this plan) but drop it from the runnable plan.
      continue;
    }

    const kind = effectiveAction(
      {
        path: action.path,
        isDirectory: false,
        aExists: target.aExists,
        bExists: target.bExists,
        aSize: action.aSize ?? null,
        bSize: action.bSize ?? null,
        aMtime: action.aMtime ?? null,
        bMtime: action.bMtime ?? null,
        plannedKind: action.kind,
        reason: action.reason,
        action: override,
        inSync: action.kind === "noop",
        conflict: action.conflict,
        overridden: false,
      },
      override,
    );

    if (!kind) continue; // override is a no-op for this row
    if (kind === action.kind) {
      actions.push(action);
      continue;
    }

    actions.push({
      ...action,
      kind,
      bytes: bytesForKind(kind, action),
      reason: overrideReason(override, kind, action),
    });
  }

  // Folder-level overrides that the differ had no opinion about (a folder
  // whose files are all in sync, but the user said "force A→B for this
  // folder"). Those become per-file actions via the target list.
  if (extraTargets && extraTargets.length > 0) {
    const known = new Set(actions.map((a) => a.path));
    for (const t of extraTargets) {
      if (known.has(t.path)) continue;
      const override = resolveOverride(t.path, overrides);
      if (override === "auto" || override === "skip") continue;
      // A directory row itself is never copied — the individual files are.
    }
  }

  return { actions, summary: summarize(actions) };
}

function bytesForKind(kind: ActionKind, action: Action): number {
  switch (kind) {
    case "copy-a-to-b":
      return action.aSize ?? action.bytes;
    case "copy-b-to-a":
      return action.bSize ?? action.bytes;
    case "delete-a":
      return action.aSize ?? action.bytes;
    case "delete-b":
      return action.bSize ?? action.bytes;
    case "keep-both":
      return (action.aSize ?? 0) + (action.bSize ?? 0);
    default:
      return action.bytes;
  }
}

function overrideReason(override: ItemAction, kind: ActionKind, action: Action): string {
  const base = action.reason;
  switch (override) {
    case "copy-a-to-b":
      return `forced A→B by user (${base})`;
    case "copy-b-to-a":
      return `forced B→A by user (${base})`;
    case "keep-both":
      return `user chose keep both (${base})`;
    case "keep-a":
      return `user chose keep A (${base})`;
    case "keep-b":
      return `user chose keep B (${base})`;
    case "delete-a":
      return `user chose delete on A (${base})`;
    case "delete-b":
      return `user chose delete on B (${base})`;
    default:
      return kind === "noop" ? base : `${base}`;
  }
}

/** Recompute the summary counters from a list of actions. */
export function summarize(actions: Action[]): DiffSummary {
  const summary: DiffSummary = {
    copyAToB: 0,
    copyBToA: 0,
    deleteA: 0,
    deleteB: 0,
    conflicts: 0,
    noops: 0,
    bytesToTransfer: 0,
  };
  for (const a of actions) {
    switch (a.kind) {
      case "copy-a-to-b":
        summary.copyAToB++;
        summary.bytesToTransfer += a.bytes;
        break;
      case "copy-b-to-a":
        summary.copyBToA++;
        summary.bytesToTransfer += a.bytes;
        break;
      case "delete-a":
        summary.deleteA++;
        break;
      case "delete-b":
        summary.deleteB++;
        break;
      case "conflict":
        summary.conflicts++;
        break;
      case "keep-both":
        // Counts as a copy in both directions plus a preserved extra copy.
        summary.copyAToB++;
        summary.copyBToA++;
        summary.bytesToTransfer += a.bytes;
        break;
      case "noop":
      case "drop-from-state":
        summary.noops++;
        break;
    }
  }
  return summary;
}
