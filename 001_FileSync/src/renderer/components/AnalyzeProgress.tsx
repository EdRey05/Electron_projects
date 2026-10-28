import { useEffect, useState } from "react";
import type { AnalysisProgress, WalkProgress } from "@shared/types";
import { formatBytes } from "../lib/format";

const LABELS: Record<AnalysisProgress["stage"], string> = {
  scanning: "Discovering files on both drives",
  "loading-state": "Loading previous synchronization state",
  comparing: "Comparing the two file indexes",
  inventory: "Building the review table",
  complete: "Analysis complete",
  failed: "Analysis stopped with an error",
};

export function elapsedClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor(seconds % 3600 / 60);
  const s = seconds % 60;
  return h ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}

export function AnalyzeProgress({ progress, startedAt, purpose = "analyze" }: {
  progress: AnalysisProgress | null;
  startedAt: number;
  purpose?: "analyze" | "verify";
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const start = progress?.startedAt ?? startedAt;
  const elapsed = Math.max(0, now - start);
  const lastUpdate = Math.max(0, now - (progress?.updatedAt ?? start));
  const files = (progress?.a.fileCount ?? 0) + (progress?.b.fileCount ?? 0);
  const stage = progress?.stage ?? "scanning";
  const active = stage !== "complete" && stage !== "failed";
  const scansComplete = !!progress?.a.complete && !!progress?.b.complete;

  return (
    <section className="mt-4 rounded-xl border border-analysis-border bg-panel p-5 shadow-sm" aria-label="Analyze progress">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-3 text-base font-semibold text-slate-900" role="status">
          {active && <span className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-sky-700 border-t-transparent motion-reduce:animate-none" aria-hidden="true" />}
          {purpose === "verify" && "Checking results · "}{progress ? LABELS[stage] : "Starting analysis…"}
        </h2>
        <span className="text-sm font-semibold tabular-nums text-slate-700">Elapsed {elapsedClock(elapsed)}</span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-sky-200" role="progressbar" aria-label="Folder discovery" aria-valuenow={scansComplete ? 100 : undefined} aria-valuetext={scansComplete ? `Both folders scanned. ${LABELS[stage]}` : LABELS[stage]}>
        <div className={`h-full rounded-full bg-sky-700 ${scansComplete ? "w-full" : "w-1/3"} ${active && !scansComplete ? "analysis-activity" : ""}`} />
      </div>
      {scansComplete && active && <p className="mt-2 text-sm font-medium text-sky-900">Scans complete · preparing results.</p>}
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <FolderProgress label="Folder A" data={progress?.a} now={now} />
        <FolderProgress label="Folder B" data={progress?.b} now={now} />
      </div>
      <div className="mt-3 flex flex-wrap justify-between gap-2 text-sm text-slate-700">
        <span className="tabular-nums">
          {files.toLocaleString()} files found
          {stage === "scanning" && elapsed >= 1000 && ` · ${Math.round(files / (elapsed / 1000)).toLocaleString()} files/s average`}
        </span>
        <span className={lastUpdate >= 10_000 ? "font-medium text-amber-900" : "text-slate-600"}>
          {lastUpdate >= 10_000
            ? `No update: ${elapsedClock(lastUpdate)} · drive may be busy.`
            : progress ? "Engine responding" : "Waiting for the engine…"}
        </span>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-slate-700">
        {purpose === "verify" ? "Size/time check · not a whole-drive checksum check. " : ""}
        Activity only · no ETA. Discovered size ≠ copied data.
      </p>
    </section>
  );
}

function FolderProgress({ label, data, now }: { label: string; data?: WalkProgress; now: number }) {
  const idle = data && !data.complete ? Math.max(0, now - data.lastEntryAt) : 0;
  return (
    <div className="min-w-0 rounded-lg border border-analysis-border bg-analysis p-4">
      <div className="flex items-center justify-between gap-2 text-sm font-semibold text-sky-950">
        <span>{label}</span><span>{data?.complete ? "Scan complete ✓" : "Scanning…"}</span>
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums text-sky-950">{(data?.fileCount ?? 0).toLocaleString()} <span className="text-sm font-normal">files</span></div>
      <div className="mt-1 text-sm tabular-nums text-sky-900">{(data?.dirCount ?? 0).toLocaleString()} folders · {formatBytes(data?.totalBytes ?? 0)} discovered</div>
      <p className="mt-3 truncate font-mono text-xs text-slate-700" title={data?.currentPath}>{data?.currentPath || "Waiting for the first matching entry…"}</p>
      {idle >= 15_000 && <p className="mt-2 text-sm text-amber-900">No new entry: {elapsedClock(idle)} · reading metadata.</p>}
    </div>
  );
}
