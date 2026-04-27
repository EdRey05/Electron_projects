import type {
  Action,
  DiffPlan,
  DiffSummary,
  SideMeta,
  SyncDirection,
} from "@shared/types";

const DEFAULT_TOLERANCE_MS = 2000;

export interface OneWayDiffInput {
  walkA: Map<string, SideMeta>;
  walkB: Map<string, SideMeta>;
  /** Must be "a-to-b" or "b-to-a" — pass to the bidirectional differ for "sync". */
  direction: Exclude<SyncDirection, "sync">;
  toleranceMs?: number;
}

/**
 * One-way mirror diff. The source side is authoritative — whichever side is
 * the source always wins on differences, and any file that exists only on the
 * destination is queued for deletion. No state DB needed.
 *
 * For "a-to-b": A is source, B is destination. Plan contains copy-a-to-b and
 * delete-b actions only. For "b-to-a": mirror.
 */
export function oneWayDiff(input: OneWayDiffInput): DiffPlan {
  const tolerance = input.toleranceMs ?? DEFAULT_TOLERANCE_MS;
  const sourceWalk = input.direction === "a-to-b" ? input.walkA : input.walkB;
  const destWalk = input.direction === "a-to-b" ? input.walkB : input.walkA;
  const copyKind = input.direction === "a-to-b" ? "copy-a-to-b" : "copy-b-to-a";
  const deleteKind = input.direction === "a-to-b" ? "delete-b" : "delete-a";
  const sourceLabel = input.direction === "a-to-b" ? "A" : "B";
  const destLabel = input.direction === "a-to-b" ? "B" : "A";

  const summary: DiffSummary = {
    copyAToB: 0,
    copyBToA: 0,
    deleteA: 0,
    deleteB: 0,
    conflicts: 0,
    noops: 0,
    bytesToTransfer: 0,
  };
  const actions: Action[] = [];

  const allPaths = new Set<string>([...sourceWalk.keys(), ...destWalk.keys()]);

  for (const path of [...allPaths].sort()) {
    const src = sourceWalk.get(path);
    const dst = destWalk.get(path);

    if (src && !dst) {
      actions.push({
        kind: copyKind,
        path,
        bytes: src.size,
        reason: `new on ${sourceLabel}`,
      });
      if (copyKind === "copy-a-to-b") summary.copyAToB++;
      else summary.copyBToA++;
      summary.bytesToTransfer += src.size;
      continue;
    }

    if (!src && dst) {
      actions.push({
        kind: deleteKind,
        path,
        bytes: dst.size,
        reason: `not on ${sourceLabel} — mirror deletes from ${destLabel}`,
      });
      if (deleteKind === "delete-a") summary.deleteA++;
      else summary.deleteB++;
      continue;
    }

    if (src && dst) {
      const sameSize = src.size === dst.size;
      const mtimeWithinTolerance = Math.abs(src.mtimeMs - dst.mtimeMs) <= tolerance;
      if (sameSize && mtimeWithinTolerance) {
        actions.push({
          kind: "noop",
          path,
          bytes: 0,
          reason: "in sync (size + mtime match)",
        });
        summary.noops++;
      } else {
        actions.push({
          kind: copyKind,
          path,
          bytes: src.size,
          reason: sameSize
            ? `mtime drift (${formatDelta(src.mtimeMs, dst.mtimeMs)}); ${sourceLabel} wins`
            : `size differs (${dst.size} → ${src.size}); ${sourceLabel} wins`,
        });
        if (copyKind === "copy-a-to-b") summary.copyAToB++;
        else summary.copyBToA++;
        summary.bytesToTransfer += src.size;
      }
    }
  }

  return { actions, summary };
}

function formatDelta(srcMs: number, dstMs: number): string {
  const delta = Math.abs(srcMs - dstMs);
  if (delta < 1000) return `${delta}ms`;
  if (delta < 60_000) return `${(delta / 1000).toFixed(1)}s`;
  if (delta < 3_600_000) return `${(delta / 60_000).toFixed(1)}min`;
  return `${(delta / 3_600_000).toFixed(1)}h`;
}
