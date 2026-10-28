import type { DiffPlan, SyncDirection } from "@shared/types";
import { planMetrics } from "@shared/plan-metrics";
import { AnalysisCard } from "./AnalysisCard";
import { formatBytes, formatDuration } from "../lib/format";

export function PlanOverview({ plan, direction, walkA, walkB, durationMs, validated = false }: {
  plan: DiffPlan; direction: SyncDirection;
  walkA: { fileCount: number; totalBytes: number };
  walkB: { fileCount: number; totalBytes: number };
  durationMs: number;
  validated?: boolean;
}) {
  const m = planMetrics(plan);
  const source = direction === "a-to-b" ? walkA : direction === "b-to-a" ? walkB : {
    fileCount: walkA.fileCount + walkB.fileCount, totalBytes: walkA.totalBytes + walkB.totalBytes,
  };
  const sourceLabel = direction === "sync" ? "A + B" : direction === "a-to-b" ? "A" : "B";
  return (
    <section className="mt-4 grid grid-cols-4 gap-3" aria-label="Folder totals and planned changes">
      <AnalysisCard validated={validated} label="Folder A · total" value={`${walkA.fileCount.toLocaleString()} files`} detail={`${formatBytes(walkA.totalBytes)} · filtered`} />
      <AnalysisCard validated={validated} label="Folder B · total" value={`${walkB.fileCount.toLocaleString()} files`} detail={`${formatBytes(walkB.totalBytes)} · filtered`} />
      <AnalysisCard validated={validated} label="Copy / update" value={`${m.copies.toLocaleString()} of ${source.fileCount.toLocaleString()} files`} detail={`${formatBytes(m.bytes)} of ${formatBytes(source.totalBytes)} · ${sourceLabel}`} />
      <AnalysisCard validated={validated} label="Remove / review" value={`${m.deletions.toLocaleString()} removals`} detail={`${m.conflicts.toLocaleString()} conflicts · ${formatDuration(durationMs)}`} />
    </section>
  );
}
