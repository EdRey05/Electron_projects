import { useEffect, useState } from "react";
import type { Action, Job } from "@shared/types";
import type { DryRunResponse } from "@shared/api";
import { Button } from "../components/Button";
import { formatBytes, formatDuration } from "../lib/format";

type Tab = "a-to-b" | "b-to-a" | "deletes" | "conflicts" | "noops";

const TABS: { key: Tab; label: string; pred(a: Action): boolean }[] = [
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

export function RunView({ job, onBack }: { job: Job; onBack(): void }) {
  const [phase, setPhase] = useState<"idle" | "running" | "done" | "error">("idle");
  const [result, setResult] = useState<DryRunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("a-to-b");

  async function run() {
    setPhase("running");
    setError(null);
    setResult(null);
    try {
      const r = await window.api.engine.dryRun({
        jobId: job.id,
        sideA: job.sideA,
        sideB: job.sideB,
        filters: job.filters,
        policy: job.onConflict,
        followSymlinks: job.followSymlinks,
      });
      setResult(r);
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.id]);

  const filtered = result?.plan.actions.filter(
    TABS.find((t) => t.key === tab)?.pred ?? (() => true),
  );
  const counts = TABS.map((t) => ({
    key: t.key,
    label: t.label,
    n: result?.plan.actions.filter(t.pred).length ?? 0,
  }));

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <header className="flex items-center justify-between mb-4">
        <div>
          <button onClick={onBack} className="text-xs text-slate-400 hover:text-slate-200">
            ← Back to jobs
          </button>
          <h1 className="text-2xl font-semibold mt-1">{job.name}</h1>
          <p className="text-xs text-slate-400 font-mono mt-0.5">
            {job.sideA} ↔ {job.sideB}
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={run} disabled={phase === "running"}>
            {phase === "running" ? "Walking…" : "Re-scan"}
          </Button>
          <Button
            variant="primary"
            disabled
            title="The Apply phase ships in Week 3 — for now, this is a preview only."
          >
            Apply (Week 3)
          </Button>
        </div>
      </header>

      {phase === "running" && (
        <div className="rounded-md border border-slate-800 bg-slate-900/50 p-4 text-sm text-slate-300">
          Walking both sides and computing diff…
        </div>
      )}

      {phase === "error" && error && (
        <div className="rounded-md border border-red-700/60 bg-red-900/30 p-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {phase === "done" && result && (
        <>
          <SummaryStats result={result} />

          <div className="mt-6 border-b border-slate-800 flex gap-1 overflow-x-auto">
            {counts.map((c) => (
              <button
                key={c.key}
                onClick={() => setTab(c.key)}
                className={`px-3 py-2 text-sm border-b-2 -mb-px whitespace-nowrap ${
                  tab === c.key
                    ? "border-emerald-500 text-emerald-300"
                    : "border-transparent text-slate-400 hover:text-slate-200"
                }`}
              >
                {c.label}{" "}
                <span className="text-xs text-slate-500 tabular-nums">({c.n})</span>
              </button>
            ))}
          </div>

          <ActionTable actions={filtered ?? []} />
        </>
      )}
    </div>
  );
}

function SummaryStats({ result }: { result: DryRunResponse }) {
  const s = result.plan.summary;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3 mt-4">
      <Stat label="A→B" value={s.copyAToB.toLocaleString()} />
      <Stat label="B→A" value={s.copyBToA.toLocaleString()} />
      <Stat label="Delete A" value={s.deleteA.toLocaleString()} />
      <Stat label="Delete B" value={s.deleteB.toLocaleString()} />
      <Stat label="Conflicts" value={s.conflicts.toLocaleString()} />
      <Stat label="Bytes to transfer" value={formatBytes(s.bytesToTransfer)} />
      <Stat label="Total time" value={formatDuration(result.totalDurationMs)} />
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

function ActionTable({ actions }: { actions: Action[] }) {
  if (actions.length === 0) {
    return (
      <div className="mt-4 text-sm text-slate-500 italic px-2 py-6">
        Nothing in this category.
      </div>
    );
  }
  return (
    <div className="mt-4 rounded-md border border-slate-800 overflow-hidden">
      <table className="w-full text-xs">
        <thead className="bg-slate-900/80 text-slate-400 uppercase tracking-wide">
          <tr>
            <th className="text-left px-3 py-2 font-medium">Path</th>
            <th className="text-left px-3 py-2 font-medium">Action</th>
            <th className="text-right px-3 py-2 font-medium">Size</th>
            <th className="text-left px-3 py-2 font-medium">Reason</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {actions.slice(0, 1000).map((a, i) => (
            <tr key={`${a.path}-${i}`} className="border-t border-slate-800 hover:bg-slate-900/40">
              <td className="px-3 py-1 text-slate-200 truncate max-w-md">{a.path}</td>
              <td className="px-3 py-1 text-slate-400">{a.kind}</td>
              <td className="px-3 py-1 text-right text-slate-400 tabular-nums">
                {a.bytes ? formatBytes(a.bytes) : "—"}
              </td>
              <td className="px-3 py-1 text-slate-400 break-all">{a.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {actions.length > 1000 && (
        <div className="px-3 py-2 text-xs text-slate-500 border-t border-slate-800">
          …and {actions.length - 1000} more (truncated for display).
        </div>
      )}
    </div>
  );
}
