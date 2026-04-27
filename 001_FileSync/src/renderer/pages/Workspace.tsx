import { useRef, useState } from "react";
import type { SyncDirection } from "@shared/types";
import type {
  ApplyProgressEvent,
  ApplyResponse,
  DryRunResponse,
} from "@shared/api";
import { Button } from "../components/Button";
import { PlanTree } from "../components/PlanTree";
import { formatBytes, formatDuration } from "../lib/format";

const DIRECTIONS: { value: SyncDirection; label: string; help: string; glyph: string }[] = [
  {
    value: "a-to-b",
    label: "Mirror →",
    help: "Make B match A. New / changed files copy A→B; files only on B are deleted.",
    glyph: "→",
  },
  {
    value: "b-to-a",
    label: "Mirror ←",
    help: "Make A match B. Inverse of mirror right.",
    glyph: "←",
  },
  {
    value: "sync",
    label: "Sync ↔",
    help:
      "Bidirectional. Uses a saved state file to detect deletes vs new files; conflicts resolved by newer-wins.",
    glyph: "↔",
  },
];

type Phase =
  | "idle"
  | "scanning"
  | "ready"
  | "applying"
  | "applied"
  | "error";

const DEFAULT_EXCLUDES = [".filesync-trash/", "node_modules/", ".git/"];

export function Workspace({ onOpenJobs }: { onOpenJobs(): void }) {
  const [sideA, setSideA] = useState("");
  const [sideB, setSideB] = useState("");
  const [direction, setDirection] = useState<SyncDirection>("a-to-b");
  const [phase, setPhase] = useState<Phase>("idle");
  const [dryRun, setDryRun] = useState<DryRunResponse | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<ApplyProgressEvent | null>(null);
  const [applyResult, setApplyResult] = useState<ApplyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  async function pickFolder(side: "a" | "b") {
    const picked = await window.api.dialog.openDirectory();
    if (picked) {
      if (side === "a") setSideA(picked);
      else setSideB(picked);
      setDryRun(null);
      setApplyResult(null);
      setExcluded(new Set());
      setPhase("idle");
    }
  }

  async function analyze() {
    if (!sideA || !sideB) return;
    if (sideA.toLowerCase() === sideB.toLowerCase()) {
      setError("Side A and Side B must be different folders.");
      setPhase("error");
      return;
    }
    setPhase("scanning");
    setError(null);
    setApplyResult(null);
    setProgress(null);
    setDryRun(null);
    setExcluded(new Set());
    try {
      const r = await window.api.engine.dryRun({
        sideA,
        sideB,
        direction,
        filters: { include: [], exclude: DEFAULT_EXCLUDES },
      });
      setDryRun(r);
      setPhase("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  async function run() {
    if (!dryRun) return;
    const filteredActions = dryRun.plan.actions.filter((a) => !excluded.has(a.path));
    if (filteredActions.length === 0) {
      setError("Every action is excluded — nothing to do.");
      return;
    }

    // Recompute summary on the filtered set.
    const summary = {
      copyAToB: 0,
      copyBToA: 0,
      deleteA: 0,
      deleteB: 0,
      conflicts: 0,
      noops: 0,
      bytesToTransfer: 0,
    };
    for (const a of filteredActions) {
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
        case "noop":
        case "drop-from-state":
          summary.noops++;
          break;
      }
    }

    setPhase("applying");
    setError(null);
    setProgress({
      jobId: "",
      doneActions: 0,
      totalActions: filteredActions.length,
      bytesTransferred: 0,
      bytesTotal: summary.bytesToTransfer,
      currentPath: "",
      errors: 0,
    });
    unsubRef.current = window.api.engine.onApplyProgress((p) => setProgress(p));
    try {
      const result = await window.api.engine.apply({
        sideA,
        sideB,
        plan: { actions: filteredActions, summary },
        trash: { enabled: true, retainDays: 30 },
        preserveTimestamps: true,
      });
      setApplyResult(result);
      setPhase("applied");
      // Re-analyze to confirm the post-run state.
      await analyze();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    } finally {
      unsubRef.current?.();
      unsubRef.current = null;
    }
  }

  function toggleExclude(path: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleSubtree(paths: string[], makeExcluded: boolean) {
    setExcluded((prev) => {
      const next = new Set(prev);
      for (const p of paths) {
        if (makeExcluded) next.add(p);
        else next.delete(p);
      }
      return next;
    });
  }

  const canAnalyze = !!sideA && !!sideB && phase !== "scanning" && phase !== "applying";
  const includedCount = dryRun
    ? dryRun.plan.actions.filter(
        (a) =>
          a.kind !== "noop" &&
          a.kind !== "drop-from-state" &&
          !excluded.has(a.path),
      ).length
    : 0;
  const canRun = phase === "ready" && includedCount > 0;

  return (
    <div className="min-h-full p-6 max-w-6xl mx-auto">
      <header className="flex items-start justify-between mb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">FileSync</h1>
          <p className="text-slate-400 text-xs mt-0.5">
            Pick two folders, choose a direction, click Analyze, review the plan, click Run.
          </p>
        </div>
        <Button onClick={onOpenJobs} variant="ghost">
          Saved jobs →
        </Button>
      </header>

      <section className="rounded-md border border-slate-800 bg-slate-900/40 p-4 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-3 items-end">
          <FolderField label="Side A" value={sideA} onPick={() => pickFolder("a")} onChange={setSideA} />
          <DirectionPicker value={direction} onChange={setDirection} />
          <FolderField label="Side B" value={sideB} onPick={() => pickFolder("b")} onChange={setSideB} />
        </div>

        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-500">
            {DIRECTIONS.find((d) => d.value === direction)?.help}
          </span>
          <div className="flex gap-2">
            <Button onClick={analyze} disabled={!canAnalyze}>
              {phase === "scanning" ? "Analyzing…" : "Analyze"}
            </Button>
            <Button variant="primary" onClick={run} disabled={!canRun}>
              {phase === "applying" ? "Running…" : `Run${includedCount > 0 ? ` (${includedCount})` : ""}`}
            </Button>
          </div>
        </div>
      </section>

      {phase === "scanning" && (
        <div className="mt-3 rounded-md border border-slate-800 bg-slate-900/50 p-3 text-sm text-slate-300">
          Walking both sides and computing diff…
        </div>
      )}

      {phase === "applying" && progress && <ApplyProgressBar progress={progress} />}

      {phase === "applied" && applyResult && <ApplySummary result={applyResult} />}

      {error && (
        <div className="mt-3 rounded-md border border-red-700/60 bg-red-900/30 p-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {(phase === "ready" || phase === "applied") && dryRun && (
        <>
          <SummaryStats result={dryRun} />
          <PlanTree
            actions={dryRun.plan.actions}
            excluded={excluded}
            onToggleExclude={toggleExclude}
            onToggleSubtree={toggleSubtree}
          />
        </>
      )}
    </div>
  );
}

function FolderField({
  label,
  value,
  onPick,
  onChange,
}: {
  label: string;
  value: string;
  onPick(): void;
  onChange(v: string): void;
}) {
  return (
    <div>
      <label className="block text-xs uppercase tracking-wide text-slate-400 mb-1">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Choose a folder…"
          className="w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-1.5 text-sm font-mono text-slate-100 focus:outline-none focus:border-emerald-500"
        />
        <Button onClick={onPick}>Browse</Button>
      </div>
    </div>
  );
}

function DirectionPicker({
  value,
  onChange,
}: {
  value: SyncDirection;
  onChange(v: SyncDirection): void;
}) {
  return (
    <div className="flex flex-col items-center">
      <span className="block text-xs uppercase tracking-wide text-slate-400 mb-1">
        Direction
      </span>
      <div className="inline-flex rounded-md border border-slate-700 overflow-hidden">
        {DIRECTIONS.map((d) => (
          <button
            key={d.value}
            onClick={() => onChange(d.value)}
            title={d.help}
            className={`px-3 py-1.5 text-sm border-r border-slate-700 last:border-r-0 transition-colors ${
              value === d.value
                ? "bg-emerald-600 text-white"
                : "bg-slate-900 text-slate-300 hover:bg-slate-800"
            }`}
          >
            <span className="text-base mr-1">{d.glyph}</span>
            <span className="text-xs">{d.label.replace(/[→←↔]/g, "").trim()}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ApplyProgressBar({ progress }: { progress: ApplyProgressEvent }) {
  const pct = progress.totalActions
    ? Math.round((progress.doneActions / progress.totalActions) * 100)
    : 0;
  return (
    <div className="mt-3 rounded-md border border-emerald-700/40 bg-emerald-900/10 p-4">
      <div className="text-sm text-emerald-200 mb-2">
        Running… {progress.doneActions} / {progress.totalActions} actions
        {progress.errors > 0 && (
          <span className="text-red-300 ml-2">
            ({progress.errors} error{progress.errors > 1 ? "s" : ""})
          </span>
        )}
      </div>
      <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
        <div className="h-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-2 text-xs text-slate-400 flex justify-between">
        <span className="font-mono truncate max-w-[60%]">{progress.currentPath || "—"}</span>
        <span className="tabular-nums">
          {formatBytes(progress.bytesTransferred)} / {formatBytes(progress.bytesTotal)}
        </span>
      </div>
    </div>
  );
}

function ApplySummary({ result }: { result: ApplyResponse }) {
  const ok = result.status === "ok";
  return (
    <div
      className={`mt-3 rounded-md border p-3 text-sm ${
        ok
          ? "border-emerald-700/40 bg-emerald-900/20 text-emerald-200"
          : "border-amber-700/40 bg-amber-900/20 text-amber-200"
      }`}
    >
      <div className="font-medium">
        {ok ? "Run complete." : `Run finished with status: ${result.status}.`}
      </div>
      <div className="text-xs mt-0.5 text-slate-300">
        {result.filesCopied} copied, {result.filesDeleted} deleted (to trash),{" "}
        {formatBytes(result.bytesTransferred)} in{" "}
        {formatDuration(result.endedAt - result.startedAt)}.
        {result.errors.length > 0 && ` ${result.errors.length} error(s).`}
        {result.trashSweep && result.trashSweep.removedDirs > 0 && (
          <>
            {" "}Trash sweep freed {formatBytes(result.trashSweep.freedBytes)} from{" "}
            {result.trashSweep.removedDirs} old run folder(s).
          </>
        )}
      </div>
    </div>
  );
}

function SummaryStats({ result }: { result: DryRunResponse }) {
  const s = result.plan.summary;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2 mt-4">
      <Stat label="A→B" value={s.copyAToB.toLocaleString()} />
      <Stat label="B→A" value={s.copyBToA.toLocaleString()} />
      <Stat label="Delete A" value={s.deleteA.toLocaleString()} />
      <Stat label="Delete B" value={s.deleteB.toLocaleString()} />
      <Stat label="Conflicts" value={s.conflicts.toLocaleString()} />
      <Stat label="To transfer" value={formatBytes(s.bytesToTransfer)} />
      <Stat label="Scan time" value={formatDuration(result.totalDurationMs)} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded bg-slate-950/40 border border-slate-800 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-base font-medium tabular-nums truncate">{value}</div>
    </div>
  );
}
