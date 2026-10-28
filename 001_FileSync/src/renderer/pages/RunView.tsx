import { useEffect, useMemo, useRef, useState } from "react";
import type { Action, ItemAction, Job } from "@shared/types";
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

type Tab = "tree" | "a-to-b" | "b-to-a" | "deletes" | "conflicts" | "noops";

const TABS: { key: Exclude<Tab, "tree">; label: string; pred(a: Action): boolean }[] = [
  { key: "a-to-b", label: "Copy A→B", pred: (a) => a.kind === "copy-a-to-b" },
  { key: "b-to-a", label: "Copy B→A", pred: (a) => a.kind === "copy-b-to-a" },
  {
    key: "deletes",
    label: "Delete",
    pred: (a) => a.kind === "delete-a" || a.kind === "delete-b",
  },
  { key: "conflicts", label: "Conflicts", pred: (a) => a.kind === "conflict" },
  {
    key: "noops",
    label: "No-op / drop",
    pred: (a) => a.kind === "noop" || a.kind === "drop-from-state",
  },
];

type Phase =
  | "idle"
  | "scanning"
  | "verifying"
  | "ready"
  | "applying"
  | "applied"
  | "error";

export function RunView({ job, onBack }: { job: Job; onBack(): void }) {
  const { analyze: analyzeFolders, progress: analysisProgress, startedAt: analysisStartedAt } = useAnalysis();
  const [phase, setPhase] = useState<Phase>("idle");
  const [dryRun, setDryRun] = useState<DryRunResponse | null>(null);
  const [applyResult, setApplyResult] = useState<ApplyResponse | null>(null);
  const [progress, setProgress] = useState<ApplyProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("tree");
  const [overrides, setOverrides] = useState<Record<string, ItemAction>>({});
  const [showOnlyChanges, setShowOnlyChanges] = useState(true);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  async function scan(preserveResult = false) {
    setPhase(preserveResult ? "verifying" : "scanning");
    setError(null);
    if (!preserveResult) { setApplyResult(null); setProgress(null); setDryRun(null); }
    try {
      const r = await analyzeFolders({
        jobId: job.id,
        sideA: job.sideA,
        sideB: job.sideB,
        direction: job.direction,
        filters: job.filters,
        policy: job.onConflict,
        followSymlinks: job.followSymlinks,
        deleteExtraneous: job.deleteExtraneous,
        overrides: job.overrides,
      });
      setDryRun(r);
      setPhase(preserveResult ? "applied" : "ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  async function applyPlan() {
    if (!dryRun || !effectivePlan) return;
    const executionPlan = { ...effectivePlan, actions: effectivePlan.actions.filter(a => !["noop", "drop-from-state", "conflict"].includes(a.kind)) };
    setPhase("applying");
    setError(null);
    setProgress({
      jobId: job.id,
      doneActions: 0,
      totalActions: executionPlan.actions.length,
      bytesTransferred: 0,
      bytesTotal: effectivePlan.summary.bytesToTransfer,
      currentPath: "",
      errors: 0,
    });
    unsubRef.current = window.api.engine.onApplyProgress((p) => {
      if (p.jobId !== job.id) return;
      setProgress(p);
    });
    try {
      const result = await window.api.engine.apply({
        jobId: job.id,
        sideA: job.sideA,
        sideB: job.sideB,
        plan: executionPlan,
        trash: job.trash,
        preserveTimestamps: job.preserveTimestamps,
      });
      setApplyResult(result);
      setPhase("applied");
      // Re-scan to show the post-apply state (should be all noops). The
      // user's per-item decisions survive, so a second Apply honours them.
      await scan(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    } finally {
      unsubRef.current?.();
      unsubRef.current = null;
    }
  }

  useEffect(() => {
    scan();
    return () => {
      unsubRef.current?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.id]);

  // The runnable plan: the differ's plan with the per-item choices applied.
  const effectivePlan = useMemo(() => {
    if (!dryRun) return null;
    if (Object.keys(overrides).length === 0) return dryRun.plan;
    return applyOverrides(dryRun.plan, overrides);
  }, [dryRun, overrides]);

  const filtered = effectivePlan?.actions.filter(
    TABS.find((t) => t.key === tab)?.pred ?? (() => true),
  );

  const actionable = effectivePlan
    ? effectivePlan.actions.filter(
        (a) => a.kind !== "noop" && a.kind !== "drop-from-state" && a.kind !== "conflict",
      ).length > 0
    : false;

  function setAction(path: string, action: ItemAction) {
    setOverrides((prev) => {
      const next = { ...prev };
      if (action === "auto") delete next[path];
      else next[path] = action;
      return next;
    });
  }

  function applyToSubtree(path: string, action: ItemAction) {
    setOverrides((prev) => {
      const next: Record<string, ItemAction> = {};
      for (const [key, value] of Object.entries(prev)) {
        if (key === path || key.startsWith(`${path}/`)) continue;
        next[key] = value;
      }
      if (action !== "auto") next[path] = action;
      return next;
    });
  }

  function applyToAll(action: ItemAction) {
    setOverrides((prev) => {
      const next = { ...prev };
      if (action === "auto") delete next[""];
      else next[""] = action;
      return next;
    });
  }

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <header className="flex items-center justify-between mb-4">
        <div>
          <button onClick={onBack} disabled={["scanning", "verifying", "applying"].includes(phase)} className="text-xs text-slate-700 hover:text-slate-900 disabled:opacity-60">
            ← Back to jobs
          </button>
          <h1 className="text-2xl font-semibold mt-1">{job.name}</h1>
          <p className="text-xs text-slate-700 font-mono mt-0.5">
            {job.sideA} ↔ {job.sideB}
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => scan()} disabled={phase === "scanning" || phase === "verifying" || phase === "applying"}>
            {phase === "scanning" ? "Scanning…" : "Re-scan"}
          </Button>
          <Button
            variant="primary"
            disabled={!["ready", "applied"].includes(phase) || !actionable}
            onClick={applyPlan}
            title={
              !actionable
                ? "Nothing to do — both sides are already in sync."
                : "Execute the plan: copy, delete, and trash as previewed below."
            }
          >
            Apply
          </Button>
        </div>
      </header>

      {(phase === "scanning" || phase === "verifying") && (
        <AnalyzeProgress progress={analysisProgress} startedAt={analysisStartedAt} purpose={phase === "verifying" ? "verify" : "analyze"} />
      )}

      {phase === "applying" && progress && (
        <TransferProgress progress={progress} trashEnabled={job.trash.enabled} />
      )}

      {applyResult && (
        <ApplySummary result={applyResult} trash={job.trash} />
      )}

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900 mt-3">
          {error}
        </div>
      )}

      {dryRun && effectivePlan && <PlanOverview plan={effectivePlan} direction={job.direction} walkA={dryRun.walkA} walkB={dryRun.walkB} durationMs={dryRun.totalDurationMs} validated={phase === "applied" && applyResult?.status === "ok" && dryRun.plan.actions.every(a => a.kind === "noop" || a.kind === "drop-from-state")} />}
      {phase === "verifying" && <p className="mt-3 text-sm text-slate-700">Checking results · previous totals shown.</p>}
      {phase === "applied" && <p className="mt-3 text-sm font-medium text-sky-900">Check complete · remaining differences below.</p>}
      {(phase === "ready" || phase === "applied") && dryRun && effectivePlan && (
        <>


          <div className="mt-6 border-b border-outline flex gap-1 overflow-x-auto">
            <button
              onClick={() => setTab("tree")}
              className={`px-3 py-2 text-sm border-b-2 -mb-px whitespace-nowrap ${
                tab === "tree"
                  ? "border-emerald-500 text-emerald-800"
                  : "border-transparent text-slate-700 hover:text-slate-900"
              }`}
            >
              Sync table
            </button>
            {TABS.map((c) => (
              <button
                key={c.key}
                onClick={() => setTab(c.key)}
                className={`px-3 py-2 text-sm border-b-2 -mb-px whitespace-nowrap ${
                  tab === c.key
                    ? "border-emerald-500 text-emerald-800"
                    : "border-transparent text-slate-700 hover:text-slate-900"
                }`}
              >
                {c.label}{" "}
                <span className="text-xs text-slate-600 tabular-nums">
                  ({effectivePlan.actions.filter(c.pred).length})
                </span>
              </button>
            ))}
          </div>

          {tab === "tree" ? (
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
          ) : (
            <ActionTable actions={filtered ?? []} />
          )}
        </>
      )}
    </div>
  );
}

function ApplySummary({ result, trash }: { result: ApplyResponse; trash: Job["trash"] }) {
  const ok = result.status === "ok";
  return (
    <div
      className={`rounded-md border p-4 mt-3 text-sm ${
        ok
          ? "border-emerald-300 bg-emerald-50 text-emerald-900"
          : "border-amber-300 bg-amber-50 text-amber-900"
      }`}
    >
      <div className="font-medium">
        {ok ? "Apply complete." : `Apply finished with status: ${result.status}.`}
      </div>
      <div className="text-xs mt-1 text-slate-700">
        {result.filesCopied} copied, {result.filesDeleted} {trash.enabled ? "moved to trash" : "permanently deleted"},{" "}
        {formatBytes(result.bytesTransferred)} transferred in{" "}
        {formatDuration(result.endedAt - result.startedAt)}.
        {result.errors.length > 0 && ` ${result.errors.length} error(s) — see history.`}
        {trash.enabled && <> Trash: {trash.retainDays} days · cleaned on later runs.</>}
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

function ActionTable({ actions }: { actions: Action[] }) {
  if (actions.length === 0) {
    return (
      <div className="mt-4 text-sm text-slate-600 italic px-2 py-6">
        Nothing in this category.
      </div>
    );
  }
  return (
    <div className="mt-4 rounded-md border border-outline overflow-hidden">
      <table className="w-full text-xs">
        <thead className="bg-panel-muted text-slate-700 uppercase tracking-wide">
          <tr>
            <th className="text-left px-3 py-2 font-medium">Path</th>
            <th className="text-left px-3 py-2 font-medium">Action</th>
            <th className="text-right px-3 py-2 font-medium">Size</th>
            <th className="text-left px-3 py-2 font-medium">Reason</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {actions.slice(0, 1000).map((a, i) => (
            <tr key={`${a.path}-${i}`} className="border-t border-outline hover:bg-panel">
              <td className="px-3 py-1 text-slate-900 truncate max-w-md">{a.path}</td>
              <td className="px-3 py-1 text-slate-700">{a.kind}</td>
              <td className="px-3 py-1 text-right text-slate-700 tabular-nums">
                {a.bytes ? formatBytes(a.bytes) : "—"}
              </td>
              <td className="px-3 py-1 text-slate-700 break-all">{a.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {actions.length > 1000 && (
        <div className="px-3 py-2 text-xs text-slate-600 border-t border-outline">
          …and {actions.length - 1000} more (truncated for display).
        </div>
      )}
    </div>
  );
}
