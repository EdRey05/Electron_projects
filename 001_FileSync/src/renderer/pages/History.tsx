import { useEffect, useState } from "react";
import type { Job } from "@shared/types";
import type { HistoryActionRow, HistoryRunRow } from "@shared/api";
import { Button } from "../components/Button";
import { formatBytes, formatDuration } from "../lib/format";

export function History({ job, onBack }: { job: Job; onBack(): void }) {
  const [runs, setRuns] = useState<HistoryRunRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [actionsByRun, setActionsByRun] = useState<Record<number, HistoryActionRow[]>>({});

  async function refresh() {
    try {
      const r = await window.api.history.list(job.id);
      setRuns(r.runs);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function toggle(runId: number) {
    const next = new Set(expanded);
    if (next.has(runId)) {
      next.delete(runId);
    } else {
      next.add(runId);
      if (!actionsByRun[runId]) {
        const r = await window.api.history.actions({ jobId: job.id, runId });
        setActionsByRun((m) => ({ ...m, [runId]: r.actions }));
      }
    }
    setExpanded(next);
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.id]);

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <header className="flex items-center justify-between mb-4">
        <div>
          <button onClick={onBack} className="text-xs text-slate-400 hover:text-slate-200">
            ← Back to jobs
          </button>
          <h1 className="text-2xl font-semibold mt-1">{job.name} — history</h1>
          <p className="text-xs text-slate-400 font-mono mt-0.5">
            {job.sideA} ↔ {job.sideB}
          </p>
        </div>
        <Button onClick={refresh}>Refresh</Button>
      </header>

      {error && (
        <div className="rounded-md border border-red-700/60 bg-red-900/30 p-3 text-sm text-red-200 mb-3">
          {error}
        </div>
      )}

      {runs === null && <p className="text-slate-400 text-sm">Loading…</p>}

      {runs?.length === 0 && (
        <div className="rounded-md border border-dashed border-slate-700 p-8 text-center text-slate-400 text-sm">
          No runs yet. The first dry-run + Apply you do will show up here.
        </div>
      )}

      {runs && runs.length > 0 && (
        <div className="rounded-md border border-slate-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-900/80 text-slate-400 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-3 py-2 font-medium">When</th>
                <th className="text-left px-3 py-2 font-medium">Status</th>
                <th className="text-right px-3 py-2 font-medium">Copied</th>
                <th className="text-right px-3 py-2 font-medium">Deleted</th>
                <th className="text-right px-3 py-2 font-medium">Conflicts</th>
                <th className="text-right px-3 py-2 font-medium">Bytes</th>
                <th className="text-right px-3 py-2 font-medium">Duration</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <RunRow
                  key={r.id}
                  run={r}
                  expanded={expanded.has(r.id)}
                  onToggle={() => toggle(r.id)}
                  actions={actionsByRun[r.id]}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function statusColor(s: string | null): string {
  switch (s) {
    case "ok":
      return "text-emerald-400";
    case "partial":
      return "text-amber-400";
    case "error":
      return "text-red-400";
    default:
      return "text-slate-400";
  }
}

function RunRow({
  run,
  expanded,
  onToggle,
  actions,
}: {
  run: HistoryRunRow;
  expanded: boolean;
  onToggle(): void;
  actions?: HistoryActionRow[];
}) {
  const dur = run.ended_at != null ? run.ended_at - run.started_at : 0;
  return (
    <>
      <tr
        onClick={onToggle}
        className="border-t border-slate-800 hover:bg-slate-900/40 cursor-pointer"
      >
        <td className="px-3 py-2 text-slate-200 tabular-nums text-xs">
          <span className="text-slate-500 mr-1">{expanded ? "▼" : "▶"}</span>
          {new Date(run.started_at).toLocaleString()}
        </td>
        <td className={`px-3 py-2 text-xs ${statusColor(run.status)}`}>
          {run.status ?? "—"}
        </td>
        <td className="px-3 py-2 text-right tabular-nums text-slate-300">
          {run.files_copied}
        </td>
        <td className="px-3 py-2 text-right tabular-nums text-slate-300">
          {run.files_deleted}
        </td>
        <td className="px-3 py-2 text-right tabular-nums text-slate-300">
          {run.conflicts}
        </td>
        <td className="px-3 py-2 text-right tabular-nums text-slate-300">
          {formatBytes(run.bytes_transferred)}
        </td>
        <td className="px-3 py-2 text-right tabular-nums text-slate-300">
          {dur > 0 ? formatDuration(dur) : "—"}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-slate-950/40">
          <td colSpan={7} className="px-3 py-2">
            {!actions ? (
              <p className="text-xs text-slate-500">Loading actions…</p>
            ) : actions.length === 0 ? (
              <p className="text-xs text-slate-500 italic">
                No per-action records (this run was a pure no-op).
              </p>
            ) : (
              <div className="overflow-hidden border border-slate-800 rounded">
                <table className="w-full text-xs">
                  <thead className="bg-slate-900/60 text-slate-500">
                    <tr>
                      <th className="text-left px-2 py-1 font-medium">Path</th>
                      <th className="text-left px-2 py-1 font-medium">Action</th>
                      <th className="text-right px-2 py-1 font-medium">Bytes</th>
                      <th className="text-left px-2 py-1 font-medium">Result</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {actions.map((a, i) => (
                      <tr key={i} className="border-t border-slate-800/60">
                        <td className="px-2 py-1 text-slate-200 truncate max-w-md">
                          {a.path}
                        </td>
                        <td className="px-2 py-1 text-slate-400">{a.action}</td>
                        <td className="px-2 py-1 text-right text-slate-400 tabular-nums">
                          {a.bytes ? formatBytes(a.bytes) : "—"}
                        </td>
                        <td
                          className={`px-2 py-1 ${
                            a.ok ? "text-emerald-400" : "text-red-400"
                          }`}
                        >
                          {a.ok ? "ok" : a.message ?? "fail"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
