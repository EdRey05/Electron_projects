import type { Action, DiffPlan } from "./types";

/** Logical copy payload, excluding deletion sizes and checksum/backup I/O. */
export function copyBytes(action: Action): number {
  return ["copy-a-to-b", "copy-b-to-a", "keep-both"].includes(action.kind) ? action.bytes : 0;
}

export function planMetrics(plan: DiffPlan) {
  let copies = 0, deletions = 0, conflicts = 0, bytes = 0;
  for (const action of plan.actions) {
    if (["copy-a-to-b", "copy-b-to-a", "keep-both"].includes(action.kind)) copies++;
    if (action.kind === "delete-a" || action.kind === "delete-b") deletions++;
    if (action.kind === "conflict") conflicts++;
    bytes += copyBytes(action);
  }
  return { copies, deletions, conflicts, bytes };
}
