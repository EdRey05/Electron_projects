import type {
  Action,
  ConflictDetail,
  ConflictType,
  DiffInput,
  DiffPlan,
  DiffSummary,
  SideMeta,
  StateRecord,
} from "@shared/types";

const DEFAULT_TOLERANCE_MS = 2000;

type Presence = "present" | "absent";
type Change = "unchanged" | "changed";

interface SideClass {
  presence: Presence;
  /** Only meaningful when presence === "present" AND there's a recorded state. */
  change: Change;
}

function classify(
  meta: SideMeta | undefined,
  recordedSize: number | undefined,
  recordedMtime: number | undefined,
  tolerance: number,
): SideClass {
  if (!meta) return { presence: "absent", change: "unchanged" };
  if (recordedSize === undefined || recordedMtime === undefined) {
    return { presence: "present", change: "changed" };
  }
  const sizeDiffers = meta.size !== recordedSize;
  const mtimeDiffers = Math.abs(meta.mtimeMs - recordedMtime) > tolerance;
  return {
    presence: "present",
    change: sizeDiffers || mtimeDiffers ? "changed" : "unchanged",
  };
}

function suggestConflictResolution(
  policy: DiffInput["policy"],
  a: SideMeta | undefined,
  b: SideMeta | undefined,
): "keep-a" | "keep-b" | "rename-both" {
  if (policy === "rename-both") return "rename-both";
  // newer-wins (default) and ask both fall back to mtime comparison as the suggestion.
  if (a && !b) return "keep-a";
  if (b && !a) return "keep-b";
  if (a && b) return a.mtimeMs >= b.mtimeMs ? "keep-a" : "keep-b";
  return "keep-a";
}

function fmtSize(n: number | undefined): string {
  if (n === undefined) return "?";
  return `${n}b`;
}

function fmtTime(ms: number | undefined): string {
  if (ms === undefined) return "?";
  return new Date(ms).toISOString();
}

function pushAction(actions: Action[], summary: DiffSummary, action: Action): void {
  actions.push(action);
  switch (action.kind) {
    case "copy-a-to-b":
      summary.copyAToB++;
      summary.bytesToTransfer += action.bytes;
      break;
    case "copy-b-to-a":
      summary.copyBToA++;
      summary.bytesToTransfer += action.bytes;
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
    case "noop":
    case "drop-from-state":
      summary.noops++;
      break;
  }
}

function buildConflict(
  type: ConflictType,
  a: SideMeta | undefined,
  b: SideMeta | undefined,
  policy: DiffInput["policy"],
): ConflictDetail {
  return {
    type,
    aSize: a?.size,
    aMtime: a?.mtimeMs,
    bSize: b?.size,
    bMtime: b?.mtimeMs,
    suggested: suggestConflictResolution(policy, a, b),
  };
}

function emitConflict(
  actions: Action[],
  summary: DiffSummary,
  path: string,
  type: ConflictType,
  a: SideMeta | undefined,
  b: SideMeta | undefined,
  policy: DiffInput["policy"],
): void {
  const conflict = buildConflict(type, a, b, policy);

  if (policy === "newer-wins") {
    // Auto-resolve into a concrete copy/delete pair using the suggested side.
    if (conflict.suggested === "keep-a") {
      if (a) {
        pushAction(actions, summary, {
          kind: "copy-a-to-b",
          path,
          bytes: a.size,
          reason: `conflict (${type}) → newer-wins kept A (${fmtTime(a.mtimeMs)} vs ${fmtTime(b?.mtimeMs)})`,
          conflict,
        });
      } else {
        pushAction(actions, summary, {
          kind: "delete-b",
          path,
          bytes: b?.size ?? 0,
          reason: `conflict (${type}) → newer-wins kept A (deleted) over B`,
          conflict,
        });
      }
    } else if (conflict.suggested === "keep-b") {
      if (b) {
        pushAction(actions, summary, {
          kind: "copy-b-to-a",
          path,
          bytes: b.size,
          reason: `conflict (${type}) → newer-wins kept B (${fmtTime(b.mtimeMs)} vs ${fmtTime(a?.mtimeMs)})`,
          conflict,
        });
      } else {
        pushAction(actions, summary, {
          kind: "delete-a",
          path,
          bytes: a?.size ?? 0,
          reason: `conflict (${type}) → newer-wins kept B (deleted) over A`,
          conflict,
        });
      }
    }
    return;
  }

  // rename-both and ask: emit raw conflict; resolution happens in UI / copier.
  pushAction(actions, summary, {
    kind: "conflict",
    path,
    bytes: 0,
    reason: `conflict (${type}) — ${policy === "ask" ? "awaiting decision" : "rename both sides"}`,
    conflict,
  });
}

/**
 * Compute the diff plan from two walks and the last-known state.
 *
 * Pure: no I/O, no clock reads beyond what's already in the inputs.
 * The 11-case truth table from PLAN.md §7 is implemented here.
 */
export function diff(input: DiffInput): DiffPlan {
  const tolerance = input.toleranceMs ?? DEFAULT_TOLERANCE_MS;
  const actions: Action[] = [];
  const summary: DiffSummary = {
    copyAToB: 0,
    copyBToA: 0,
    deleteA: 0,
    deleteB: 0,
    conflicts: 0,
    noops: 0,
    bytesToTransfer: 0,
  };

  const allPaths = new Set<string>();
  for (const k of input.walkA.keys()) allPaths.add(k);
  for (const k of input.walkB.keys()) allPaths.add(k);
  for (const k of input.state.keys()) allPaths.add(k);

  const sortedPaths = [...allPaths].sort();

  for (const path of sortedPaths) {
    const a = input.walkA.get(path);
    const b = input.walkB.get(path);
    const s: StateRecord | undefined = input.state.get(path);

    const aClass = classify(a, s?.aSize, s?.aMtime, tolerance);
    const bClass = classify(b, s?.bSize, s?.bMtime, tolerance);

    // ----- s absent (no prior state) -----
    if (!s) {
      if (a && b) {
        // First-sync seed: pick newer; tie → noop (both already match).
        const sameSize = a.size === b.size;
        const sameMtime = Math.abs(a.mtimeMs - b.mtimeMs) <= tolerance;
        if (sameSize && sameMtime) {
          pushAction(actions, summary, {
            kind: "noop",
            path,
            bytes: 0,
            reason: "first-sync: A and B already identical (size + mtime)",
          });
        } else if (a.mtimeMs >= b.mtimeMs) {
          pushAction(actions, summary, {
            kind: "copy-a-to-b",
            path,
            bytes: a.size,
            reason: `first-sync: A newer (${fmtTime(a.mtimeMs)} vs ${fmtTime(b.mtimeMs)})`,
          });
        } else {
          pushAction(actions, summary, {
            kind: "copy-b-to-a",
            path,
            bytes: b.size,
            reason: `first-sync: B newer (${fmtTime(b.mtimeMs)} vs ${fmtTime(a.mtimeMs)})`,
          });
        }
        continue;
      }
      if (a && !b) {
        pushAction(actions, summary, {
          kind: "copy-a-to-b",
          path,
          bytes: a.size,
          reason: "new on A",
        });
        continue;
      }
      if (b && !a) {
        pushAction(actions, summary, {
          kind: "copy-b-to-a",
          path,
          bytes: b.size,
          reason: "new on B",
        });
        continue;
      }
      // (!a && !b && !s) is impossible — path wouldn't be in allPaths.
      continue;
    }

    // ----- s present -----
    const aP = aClass.presence;
    const bP = bClass.presence;
    const aC = aClass.change;
    const bC = bClass.change;

    if (aP === "present" && bP === "present") {
      if (aC === "unchanged" && bC === "unchanged") {
        pushAction(actions, summary, {
          kind: "noop",
          path,
          bytes: 0,
          reason: "in sync (both unchanged since last run)",
        });
      } else if (aC === "changed" && bC === "unchanged") {
        pushAction(actions, summary, {
          kind: "copy-a-to-b",
          path,
          bytes: a!.size,
          reason: `A changed since last run (size ${fmtSize(s.aSize)} → ${fmtSize(a!.size)})`,
        });
      } else if (aC === "unchanged" && bC === "changed") {
        pushAction(actions, summary, {
          kind: "copy-b-to-a",
          path,
          bytes: b!.size,
          reason: `B changed since last run (size ${fmtSize(s.bSize)} → ${fmtSize(b!.size)})`,
        });
      } else {
        // both changed
        emitConflict(actions, summary, path, "edit-edit", a, b, input.policy);
      }
    } else if (aP === "absent" && bP === "present") {
      if (bC === "unchanged") {
        // A deleted since last sync, B unchanged → propagate delete.
        pushAction(actions, summary, {
          kind: "delete-b",
          path,
          bytes: b!.size,
          reason: "deleted on A since last run",
        });
      } else {
        // A deleted, B edited → conflict (delete vs edit).
        emitConflict(actions, summary, path, "delete-edit", a, b, input.policy);
      }
    } else if (aP === "present" && bP === "absent") {
      if (aC === "unchanged") {
        pushAction(actions, summary, {
          kind: "delete-a",
          path,
          bytes: a!.size,
          reason: "deleted on B since last run",
        });
      } else {
        // A edited, B deleted → conflict (edit vs delete).
        emitConflict(actions, summary, path, "edit-delete", a, b, input.policy);
      }
    } else {
      // both absent, but state still records it → both deleted.
      pushAction(actions, summary, {
        kind: "drop-from-state",
        path,
        bytes: 0,
        reason: "deleted on both sides; clearing state",
      });
    }
  }

  return { actions, summary };
}
