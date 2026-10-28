import { useEffect, useState } from "react";
import type { Job, SyncDirection } from "@shared/types";
import { Button } from "../components/Button";

const DIRECTION_LABELS: Record<SyncDirection, string> = {
  "a-to-b": "Mirror →",
  "b-to-a": "Mirror ←",
  sync: "Sync ↔",
};

export function JobList({
  onNew,
  onEdit,
  onRun,
  onHistory,
  onBack,
}: {
  onNew(): void;
  onEdit(job: Job): void;
  onRun(job: Job): void;
  onHistory(job: Job): void;
  onBack?(): void;
}) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const list = await window.api.jobs.list();
      setJobs(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleDelete(job: Job) {
    const ok = window.confirm(`Delete job "${job.name}"? (Only the config — your folders are untouched.)`);
    if (!ok) return;
    await window.api.jobs.delete(job.id);
    refresh();
  }

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <header className="flex items-center justify-between mb-6">
        <div>
          {onBack && (
            <button
              onClick={onBack}
              className="text-xs text-slate-700 hover:text-slate-900"
            >
              ← Back to Workspace
            </button>
          )}
          <h1 className="text-2xl font-semibold tracking-tight mt-1">Saved jobs</h1>
          <p className="text-slate-700 text-xs mt-0.5">
            Saved configurations for repeat sync workflows. For one-off operations, use the
            Workspace.
          </p>
        </div>
        <Button variant="primary" onClick={onNew}>
          + New job
        </Button>
      </header>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900 mb-4">
          {error}
        </div>
      )}

      {jobs === null && <p className="text-slate-700 text-sm">Loading…</p>}

      {jobs?.length === 0 && (
        <div className="rounded-md border border-dashed border-slate-400 p-8 text-center text-slate-700">
          No jobs yet. Click <strong className="text-slate-900">New job</strong> to create your
          first sync pair.
        </div>
      )}

      {jobs && jobs.length > 0 && (
        <div className="overflow-hidden rounded-md border border-outline">
          <table className="w-full text-sm">
            <thead className="bg-panel-muted text-slate-700 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Name</th>
                <th className="text-left px-4 py-2 font-medium">Folder A</th>
                <th className="text-left px-4 py-2 font-medium">Folder B</th>
                <th className="text-left px-4 py-2 font-medium">Direction</th>
                <th className="text-left px-4 py-2 font-medium">Conflict</th>
                <th className="text-right px-4 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className="border-t border-outline hover:bg-panel">
                  <td className="px-4 py-2 text-slate-900">{j.name}</td>
                  <td className="px-4 py-2 text-slate-700 font-mono text-xs">{j.sideA}</td>
                  <td className="px-4 py-2 text-slate-700 font-mono text-xs">{j.sideB}</td>
                  <td className="px-4 py-2 text-slate-700 text-xs">
                    {DIRECTION_LABELS[j.direction] ?? j.direction}
                  </td>
                  <td className="px-4 py-2 text-slate-700 text-xs">{j.onConflict}</td>
                  <td className="px-4 py-2 text-right space-x-1">
                    <Button variant="primary" onClick={() => onRun(j)}>
                      Run
                    </Button>
                    <Button onClick={() => onHistory(j)}>History</Button>
                    <Button onClick={() => onEdit(j)}>Edit</Button>
                    <Button variant="danger" onClick={() => handleDelete(j)}>
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
