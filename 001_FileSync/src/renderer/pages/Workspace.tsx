import { useCallback, useMemo, useRef, useState } from "react";
import type { DiffPlan, ItemAction, OverrideMap, SyncDirection } from "@shared/types";
import type {
  ApplyProgressEvent,
  ApplyResponse,
  DryRunResponse,
} from "@shared/api";
import { applyOverrides } from "@shared/overrides";
import { Button } from "../components/Button";
import { PlanOverview } from "../components/PlanOverview";
import { TransferProgress } from "../components/TransferProgress";
import { AnalyzeProgress } from "../components/AnalyzeProgress";
import { useAnalysis } from "../lib/useAnalysis";
import { SyncTable } from "../components/SyncTable";
import { formatBytes, formatDuration } from "../lib/format";

const DIRECTIONS: {
  value: SyncDirection;
  label: string;
  help: string;
  glyph: string;
  colors: { idle: string; selected: string };
}[] = [
  {
    value: "a-to-b",
    label: "Mirror",
    help: "Copy Folder A into B. Files only in B are removed only when deletion is enabled.",
    glyph: "→",
    colors: {
      idle: "border-blue-300 bg-blue-100 text-blue-900 hover:bg-blue-200",
      selected: "border-blue-800 bg-blue-700 text-white ring-2 ring-blue-200",
    },
  },
  {
    value: "sync",
    label: "Sync",
    help: "Update both folders using the last sync. If both copies changed, the newer version wins.",
    glyph: "↔",
    colors: {
      idle: "border-violet-300 bg-violet-100 text-violet-900 hover:bg-violet-200",
      selected: "border-violet-800 bg-violet-700 text-white ring-2 ring-violet-200",
    },
  },
  {
    value: "b-to-a",
    label: "Mirror",
    help: "Copy Folder B into A. Files only in A are removed only when deletion is enabled.",
    glyph: "←",
    colors: {
      idle: "border-amber-300 bg-amber-100 text-amber-900 hover:bg-amber-200",
      selected: "border-amber-800 bg-amber-700 text-white ring-2 ring-amber-200",
    },
  },
];

type Phase = "idle" | "scanning" | "verifying" | "ready" | "applying" | "applied" | "error";

const DEFAULT_EXCLUDES = [".filesync-trash/", "node_modules/", ".git/"];

const DEFAULT_FILTERS = {
  include: [] as string[],
  exclude: DEFAULT_EXCLUDES,
  excludeA: [] as string[],
  excludeB: [] as string[],
};

export function Workspace({ onOpenJobs }: { onOpenJobs(): void }) {
  const { analyze: analyzeFolders, progress: analysisProgress, startedAt: analysisStartedAt } = useAnalysis();
  const [sideA, setSideA] = useState("");
  const [sideB, setSideB] = useState("");
  const [direction, setDirection] = useState<SyncDirection>("a-to-b");
  const [deleteExtraneous, setDeleteExtraneous] = useState(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const [dryRun, setDryRun] = useState<DryRunResponse | null>(null);
  const [overrides, setOverrides] = useState<OverrideMap>({});
  const [progress, setProgress] = useState<ApplyProgressEvent | null>(null);
  const [applyResult, setApplyResult] = useState<ApplyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showOnlyChanges, setShowOnlyChanges] = useState(true);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  function invalidateAnalysis() {
    setDryRun(null); setApplyResult(null); setOverrides({}); setSelected(null);
    setError(null); setPhase("idle");
  }

  async function pickFolder(side: "a" | "b") {
    const picked = await window.api.dialog.openDirectory();
    if (picked) {
      if (side === "a") setSideA(picked);
      else setSideB(picked);
      setDryRun(null);
      setApplyResult(null);
      setOverrides({});
      setSelected(null);
      setPhase("idle");
    }
  }

  /**
   * Scan both sides and build the sync table.
   *
   * `preserveOverrides` is used by the post-Run re-analyze: the user's
   * explicit per-item decisions (e.g. "skip this folder") must survive, or a
   * second Run would silently do what the user just excluded. A fresh
   * Analyze (or changing the folders) starts from a clean slate.
   */
  const analyze = useCallback(
    async (preserveOverrides = false) => {
      if (!sideA || !sideB) return;
      if (sideA.toLowerCase() === sideB.toLowerCase()) {
        setError("Folder A and Folder B must be different folders.");
        setPhase("error");
        return;
      }
      setPhase(preserveOverrides ? "verifying" : "scanning");
      setError(null);
      if (!preserveOverrides) { setApplyResult(null); setProgress(null); setDryRun(null); }
      if (!preserveOverrides) {
        setOverrides({});
        setSelected(null);
      }
      try {
        const r = await analyzeFolders({
          sideA,
          sideB,
          direction,
          deleteExtraneous,
          filters: DEFAULT_FILTERS,
        });
        setDryRun(r);
        setPhase(preserveOverrides ? "applied" : "ready");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    },
    [sideA, sideB, direction, deleteExtraneous, analyzeFolders],
  );

  // The runnable plan: the differ's plan with the user's per-item choices
  // folded in. Recomputed locally so the table, the counters and the Run
  // button always agree without a round-trip to the main process.
  const effectivePlan: DiffPlan | null = useMemo(() => {
    if (!dryRun) return null;
    if (Object.keys(overrides).length === 0) return dryRun.plan;
    return applyOverrides(dryRun.plan, overrides);
  }, [dryRun, overrides]);

  const actionable = useMemo(() => {
    if (!effectivePlan) return [];
    return effectivePlan.actions.filter(
      (a) =>
        a.kind !== "noop" &&
        a.kind !== "drop-from-state" &&
        a.kind !== "conflict",
    );
  }, [effectivePlan]);

  const conflictCount = useMemo(
    () => effectivePlan?.actions.filter((a) => a.kind === "conflict").length ?? 0,
    [effectivePlan],
  );

  async function run() {
    if (!dryRun || !effectivePlan) return;
    const filteredActions = actionable;
    if (filteredActions.length === 0) {
      setError("Every action is excluded — nothing to do.");
      return;
    }

    setPhase("applying");
    setError(null);
    setProgress({
      jobId: "",
      doneActions: 0,
      totalActions: filteredActions.length,
      bytesTransferred: 0,
      bytesTotal: effectivePlan.summary.bytesToTransfer,
      currentPath: "",
      errors: 0,
    });
    unsubRef.current = window.api.engine.onApplyProgress((p) => setProgress(p));
    try {
      const result = await window.api.engine.apply({
        sideA,
        sideB,
        plan: { actions: filteredActions, summary: effectivePlan.summary },
        trash: { enabled: true, retainDays: 30 },
        preserveTimestamps: true,
      });
      setApplyResult(result);
      setPhase("applied");
      // Re-analyze to confirm the post-state, keeping the user's per-item
      // decisions so a second Run honours them too.
      await analyze(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    } finally {
      unsubRef.current?.();
      unsubRef.current = null;
    }
  }

  /**
   * Set the action for a single path. The override map is keyed by path; a
   * folder's action is stored on the folder path and inherited by everything
   * beneath it, which is exactly how the folder dropdown behaves.
   */
  function setAction(path: string, action: ItemAction) {
    setOverrides((prev) => {
      const next = { ...prev };
      if (action === "auto") delete next[path];
      else next[path] = action;
      return next;
    });
  }

  /**
   * Apply an action to a folder and everything under it.
   *
   * The override resolver already treats a folder key as covering its whole
   * subtree, so setting the folder key is enough. We also clear any deeper,
   * more specific overrides so the folder choice actually wins.
   */
  function applyToSubtree(path: string, action: ItemAction) {
    setOverrides((prev) => {
      const next: OverrideMap = {};
      for (const [key, value] of Object.entries(prev)) {
        // Drop overrides that live inside this folder — the folder choice
        // supersedes them.
        if (key === path || key.startsWith(`${path}/`)) continue;
        next[key] = value;
      }
      if (action !== "auto") next[path] = action;
      return next;
    });
  }

  /** Reset every override back to "auto". */
  function resetOverrides() {
    setOverrides({});
  }

  /**
   * Apply an action to EVERYTHING. This writes the root key ("") into the
   * override map, which every path inherits — but any per-item override the
   * user already set stays in place, because the resolver picks the most
   * specific match.
   */
  function applyToAll(action: ItemAction) {
    setOverrides((prev) => {
      const next = { ...prev };
      if (action === "auto") delete next[""];
      else next[""] = action;
      return next;
    });
  }

  const canAnalyze =
    !!sideA && !!sideB && phase !== "scanning" && phase !== "verifying" && phase !== "applying";
  const canRun = (phase === "ready" || phase === "applied") && actionable.length > 0;
  const busy = ["scanning", "verifying", "applying"].includes(phase);
  const overrideCount = Object.keys(overrides).length;

  return (
    <div className="min-h-full p-6 max-w-[1400px] mx-auto">
      <header className="flex items-start justify-between mb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">FileSync</h1>
          <p className="text-slate-700 text-xs mt-0.5">
            Pick two folders, choose a direction, click Analyze, review the table, pick per-item
            actions, click Run.
          </p>
        </div>
        <Button onClick={onOpenJobs} variant="ghost" disabled={busy}>
          Saved jobs →
        </Button>
      </header>

      <section className="rounded-md border border-outline bg-panel p-4 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-x-5 gap-y-4 items-end">
          <FolderField
            label="Folder A"
            value={sideA}
            onPick={() => pickFolder("a")}
            onChange={value => { setSideA(value); invalidateAnalysis(); }}
            disabled={busy}
          />
          <DirectionPicker value={direction} onChange={value => { setDirection(value); invalidateAnalysis(); }} disabled={busy} />
          <FolderField
            label="Folder B"
            value={sideB}
            onPick={() => pickFolder("b")}
            onChange={value => { setSideB(value); invalidateAnalysis(); }}
            disabled={busy}
          />
          <div className="flex justify-center gap-3 md:col-start-2">
            <Button className="min-w-28" onClick={() => analyze(false)} disabled={!canAnalyze}>
              {phase === "verifying" ? "Checking…" : phase === "scanning" ? "Analyzing…" : "Analyze"}
            </Button>
            <Button className="min-w-28" variant="primary" onClick={run} disabled={!canRun}>
              {phase === "applying" ? "Running…" : "Run"}
            </Button>
          </div>
        </div>
        {direction !== "sync" && (
          <label className="flex justify-center items-center gap-2 text-sm text-slate-700 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={deleteExtraneous}
              disabled={busy}
              onChange={(e) => { setDeleteExtraneous(e.target.checked); invalidateAnalysis(); }}
            />
            Delete files only on the destination
          </label>
        )}
      </section>

      {(phase === "scanning" || phase === "verifying") && (
        <AnalyzeProgress progress={analysisProgress} startedAt={analysisStartedAt} purpose={phase === "verifying" ? "verify" : "analyze"} />
      )}

      {phase === "applying" && progress && <TransferProgress progress={progress} />}

      {applyResult && <ApplySummary result={applyResult} />}

      {error && (
        <div className="mt-3 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          {error}
        </div>
      )}

      {dryRun && effectivePlan && <>
        {phase === "verifying" && <p className="mt-3 text-sm text-slate-700">Checking results · previous totals shown.</p>}
        <PlanOverview plan={effectivePlan} direction={direction} walkA={dryRun.walkA} walkB={dryRun.walkB} durationMs={dryRun.totalDurationMs} validated={phase === "applied" && applyResult?.status === "ok" && dryRun.plan.actions.every(a => a.kind === "noop" || a.kind === "drop-from-state")} />
      </>}
      {phase === "applied" && <p className="mt-3 text-sm font-medium text-sky-900">Check complete · remaining differences below.</p>}
      {(phase === "ready" || phase === "applied") && dryRun && effectivePlan && (
        <>
          {conflictCount > 0 && (
            <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
              {conflictCount} conflict{conflictCount === 1 ? "" : "s"} need a decision. Pick
              <strong> Keep A </strong> or <strong> Keep B </strong> in the Action column of the
              conflicting row (or set the folder's action to apply to all of them).
            </div>
          )}

          <div className="mt-3 flex items-center justify-between gap-3 flex-wrap">
            <div className="text-xs text-slate-600">
              {overrideCount > 0 ? (
                <>
                  <span className="text-emerald-800">{overrideCount}</span> custom action
                  {overrideCount === 1 ? "" : "s"} set
                </>
              ) : (
                "Every row uses the action the diff proposed."
              )}
            </div>
            {overrideCount > 0 && (
              <Button onClick={resetOverrides} variant="ghost">
                Reset all actions
              </Button>
            )}
          </div>

          <div className="w-full">
            <SyncTable
              items={dryRun.inventory}
              overrides={overrides}
              onSetAction={setAction}
              onApplyToSubtree={applyToSubtree}
              onApplyToAll={applyToAll}
              showOnlyChanges={showOnlyChanges}
              onToggleShowOnlyChanges={setShowOnlyChanges}
              filter={filter}
              onChangeFilter={setFilter}
              selected={selected}
              onSelect={setSelected}
            />

          </div>
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
  disabled,
}: {
  label: string;
  value: string;
  onPick(): void;
  onChange(v: string): void;
  disabled?: boolean;
}) {
  return (
    <div>
      <label className="block text-xs uppercase tracking-wide text-slate-700 mb-1">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          type="text"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Choose a folder…"
          className="min-w-0 flex-1 bg-panel border border-slate-400 rounded-md px-3 py-1.5 text-sm font-mono text-slate-900 focus:outline-none focus:border-emerald-500"
        />
        <Button onClick={onPick} disabled={disabled}>Browse</Button>
      </div>
    </div>
  );
}

function DirectionPicker({
  value,
  onChange,
  disabled,
}: {
  value: SyncDirection;
  onChange(v: SyncDirection): void;
  disabled?: boolean;
}) {
  const [info, setInfo] = useState<SyncDirection | null>(null);
  return (
    <div className="relative flex flex-col items-center">
      <span className="block text-xs uppercase tracking-wide text-slate-700 mb-1">
        Direction
      </span>
      <div className="flex justify-center gap-2" role="group" aria-label="Synchronization direction">
        {DIRECTIONS.map((d) => (
          <div key={d.value} onMouseEnter={() => setInfo(d.value)} onMouseLeave={() => setInfo(null)}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange(d.value)}
              onFocus={() => setInfo(d.value)}
              onBlur={() => setInfo(null)}
              onKeyDown={e => { if (e.key === "Escape") setInfo(null); }}
              aria-label={d.value === "sync" ? "Sync both folders" : d.value === "a-to-b" ? "Mirror Folder A to Folder B" : "Mirror Folder B to Folder A"}
              aria-pressed={value === d.value}
              aria-describedby={info === d.value ? `direction-info-${d.value}` : undefined}
              className={`flex min-w-24 flex-col items-center rounded-lg border-2 px-4 py-2 font-semibold transition-colors ${value === d.value ? d.colors.selected : d.colors.idle}`}
            >
              <span className="text-sm">{d.label}</span>
              <span className="text-2xl leading-7" aria-hidden="true">{d.glyph}</span>
            </button>
            {info === d.value && (
              <div id={`direction-info-${d.value}`} role="tooltip" className="absolute left-1/2 top-full z-30 mt-3 w-72 max-w-[calc(100vw-4rem)] -translate-x-1/2 rounded-xl border border-outline bg-panel p-4 text-left text-base leading-relaxed text-slate-900 shadow-lg">
                {d.help}
              </div>
            )}
          </div>
        ))}
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
          ? "border-emerald-300 bg-emerald-50 text-emerald-900"
          : "border-amber-300 bg-amber-50 text-amber-900"
      }`}
    >
      <div className="font-medium">
        {ok ? "Run complete." : `Run finished with status: ${result.status}.`}
      </div>
      <div className="text-xs mt-0.5 text-slate-700">
        {result.filesCopied} copied, {result.filesDeleted} deleted (to trash),{" "}
        {formatBytes(result.bytesTransferred)} in{" "}
        {formatDuration(result.endedAt - result.startedAt)}.
        {result.errors.length > 0 && ` ${result.errors.length} error(s).`}
        {" "}Trash: 30 days · cleaned on later runs.
        {result.trashSweep && result.trashSweep.removedDirs > 0 && (
          <>
            {" "}
            Trash sweep freed {formatBytes(result.trashSweep.freedBytes)} from{" "}
            {result.trashSweep.removedDirs} old run folder(s).
          </>
        )}
      </div>
    </div>
  );
}
