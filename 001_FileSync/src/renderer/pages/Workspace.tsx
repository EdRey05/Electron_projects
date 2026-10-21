import { useCallback, useMemo, useRef, useState } from "react";
import type { DiffPlan, ItemAction, OverrideMap, SyncDirection } from "@shared/types";
import type { SyncItem } from "@shared/inventory";
import type {
  ApplyProgressEvent,
  ApplyResponse,
  DryRunResponse,
} from "@shared/api";
import { applyOverrides, resolveOverride } from "@shared/overrides";
import { Button } from "../components/Button";
import { SyncTable } from "../components/SyncTable";
import { formatBytes, formatDuration, formatTime } from "../lib/format";

const DIRECTIONS: {
  value: SyncDirection;
  label: string;
  help: string;
  glyph: string;
}[] = [
  {
    value: "a-to-b",
    label: "Mirror →",
    help:
      "Make B match A. New / changed files copy A→B. Files only on B are deleted (unless you turn that off below).",
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

type Phase = "idle" | "scanning" | "ready" | "applying" | "applied" | "error";

const DEFAULT_EXCLUDES = [".filesync-trash/", "node_modules/", ".git/"];

const DEFAULT_FILTERS = {
  include: [] as string[],
  exclude: DEFAULT_EXCLUDES,
  excludeA: [] as string[],
  excludeB: [] as string[],
};

export function Workspace({ onOpenJobs }: { onOpenJobs(): void }) {
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
        setError("Side A and Side B must be different folders.");
        setPhase("error");
        return;
      }
      setPhase("scanning");
      setError(null);
      setApplyResult(null);
      setProgress(null);
      setDryRun(null);
      if (!preserveOverrides) {
        setOverrides({});
        setSelected(null);
      }
      try {
        const r = await window.api.engine.dryRun({
          sideA,
          sideB,
          direction,
          deleteExtraneous,
          filters: DEFAULT_FILTERS,
        });
        setDryRun(r);
        setPhase("ready");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    },
    [sideA, sideB, direction, deleteExtraneous],
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
    !!sideA && !!sideB && phase !== "scanning" && phase !== "applying";
  const canRun = phase === "ready" && actionable.length > 0;
  const overrideCount = Object.keys(overrides).length;

  const selectedItem = useMemo(
    () => dryRun?.inventory.find((i) => i.path === selected) ?? null,
    [dryRun, selected],
  );

  return (
    <div className="min-h-full p-6 max-w-[1400px] mx-auto">
      <header className="flex items-start justify-between mb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">FileSync</h1>
          <p className="text-slate-400 text-xs mt-0.5">
            Pick two folders, choose a direction, click Analyze, review the table, pick per-item
            actions, click Run.
          </p>
        </div>
        <Button onClick={onOpenJobs} variant="ghost">
          Saved jobs →
        </Button>
      </header>

      <section className="rounded-md border border-slate-800 bg-slate-900/40 p-4 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-3 items-end">
          <FolderField
            label="Side A"
            value={sideA}
            onPick={() => pickFolder("a")}
            onChange={setSideA}
          />
          <DirectionPicker value={direction} onChange={setDirection} />
          <FolderField
            label="Side B"
            value={sideB}
            onPick={() => pickFolder("b")}
            onChange={setSideB}
          />
        </div>

        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-4 flex-wrap">
            <span className="text-xs text-slate-500 max-w-xl">
              {DIRECTIONS.find((d) => d.value === direction)?.help}
            </span>
            {direction !== "sync" && (
              <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={deleteExtraneous}
                  onChange={(e) => setDeleteExtraneous(e.target.checked)}
                />
                Delete files only on the destination
              </label>
            )}
          </div>
          <div className="flex gap-2">
            <Button onClick={() => analyze(false)} disabled={!canAnalyze}>
              {phase === "scanning" ? "Analyzing…" : "Analyze"}
            </Button>
            <Button variant="primary" onClick={run} disabled={!canRun}>
              {phase === "applying"
                ? "Running…"
                : `Run${actionable.length > 0 ? ` (${actionable.length})` : ""}`}
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

      {(phase === "ready" || phase === "applied") && dryRun && effectivePlan && (
        <>
          <SummaryStats
            plan={effectivePlan}
            totalDurationMs={dryRun.totalDurationMs}
            walkA={dryRun.walkA}
            walkB={dryRun.walkB}
          />

          {conflictCount > 0 && (
            <div className="mt-3 rounded-md border border-amber-700/50 bg-amber-900/20 p-3 text-xs text-amber-200">
              {conflictCount} conflict{conflictCount === 1 ? "" : "s"} need a decision. Pick
              <strong> Keep A </strong> or <strong> Keep B </strong> in the Action column of the
              conflicting row (or set the folder's action to apply to all of them).
            </div>
          )}

          <div className="mt-3 flex items-center justify-between gap-3 flex-wrap">
            <div className="text-xs text-slate-500">
              {overrideCount > 0 ? (
                <>
                  <span className="text-emerald-400">{overrideCount}</span> custom action
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

          <div className="grid grid-cols-1 xl:grid-cols-[1fr_18rem] gap-4 items-start">
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
            <DetailPane
              item={selectedItem}
              effective={
                selectedItem ? resolveOverride(selectedItem.path, overrides) : "auto"
              }
            />
          </div>
        </>
      )}
    </div>
  );
}

function DetailPane({
  item,
  effective,
}: {
  item: SyncItem | null;
  effective: ItemAction;
}) {
  if (!item) {
    return (
      <div className="mt-4 rounded-md border border-slate-800 bg-slate-900/30 p-3 text-xs text-slate-500">
        Select a row to see both sides side by side.
      </div>
    );
  }
  return (
    <div className="mt-4 rounded-md border border-slate-800 bg-slate-900/30 p-3 text-xs space-y-2">
      <div className="text-slate-200 font-medium break-all">{item.path}</div>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded border border-slate-800 p-2">
          <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">
            Side A
          </div>
          {item.aExists ? (
            <>
              <div className="text-slate-300">{formatBytes(item.aSize ?? 0)}</div>
              <div className="text-slate-500 text-[10px]">
                {formatTime(item.aMtime ?? 0)}
              </div>
            </>
          ) : (
            <div className="text-slate-600">missing</div>
          )}
        </div>
        <div className="rounded border border-slate-800 p-2">
          <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">
            Side B
          </div>
          {item.bExists ? (
            <>
              <div className="text-slate-300">{formatBytes(item.bSize ?? 0)}</div>
              <div className="text-slate-500 text-[10px]">
                {formatTime(item.bMtime ?? 0)}
              </div>
            </>
          ) : (
            <div className="text-slate-600">missing</div>
          )}
        </div>
      </div>
      <div className="text-slate-500 text-[10px] leading-relaxed">{item.reason}</div>
      <div className="text-slate-400 text-[10px]">
        Effective action: <span className="text-emerald-400">{effective}</span>
      </div>
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
        <div
          className="h-full bg-emerald-500 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-2 text-xs text-slate-400 flex justify-between">
        <span className="font-mono truncate max-w-[60%]">
          {progress.currentPath || "—"}
        </span>
        <span className="tabular-nums">
          {formatBytes(progress.bytesTransferred)} /{" "}
          {formatBytes(progress.bytesTotal)}
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
            {" "}
            Trash sweep freed {formatBytes(result.trashSweep.freedBytes)} from{" "}
            {result.trashSweep.removedDirs} old run folder(s).
          </>
        )}
      </div>
    </div>
  );
}

function SummaryStats({
  plan,
  totalDurationMs,
  walkA,
  walkB,
}: {
  plan: DiffPlan;
  totalDurationMs: number;
  walkA: { fileCount: number; totalBytes: number };
  walkB: { fileCount: number; totalBytes: number };
}) {
  const s = plan.summary;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2 mt-4">
      <Stat label="A→B" value={s.copyAToB.toLocaleString()} />
      <Stat label="B→A" value={s.copyBToA.toLocaleString()} />
      <Stat label="Delete A" value={s.deleteA.toLocaleString()} />
      <Stat label="Delete B" value={s.deleteB.toLocaleString()} />
      <Stat label="Conflicts" value={s.conflicts.toLocaleString()} />
      <Stat label="To transfer" value={formatBytes(s.bytesToTransfer)} />
      <Stat label="A / B files" value={`${walkA.fileCount} / ${walkB.fileCount}`} />
      <Stat label="Scan time" value={formatDuration(totalDurationMs)} />
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
