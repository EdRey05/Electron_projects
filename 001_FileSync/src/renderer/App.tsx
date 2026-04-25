import { useState } from "react";
import type { WalkResult } from "@shared/types";

type WalkResponse = WalkResult & { sessionId: string; dbPath: string };

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export default function App() {
  const [root, setRoot] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<WalkResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function pickFolder() {
    setError(null);
    const picked = await window.api.dialog.openDirectory();
    if (picked) setRoot(picked);
  }

  async function runWalk() {
    if (!root) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await window.api.engine.walkAndPersist({
        root,
        filters: { include: [], exclude: [".filesync-trash/", "node_modules/", ".git/"] },
      });
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-full p-8 max-w-5xl mx-auto">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">FileSync</h1>
        <p className="text-slate-400 text-sm mt-1">
          Week 1 demo — walk a folder and persist its state to SQLite.
        </p>
      </header>

      <section className="space-y-4">
        <div className="flex gap-2 items-center">
          <button
            onClick={pickFolder}
            className="px-4 py-2 rounded-md bg-slate-800 hover:bg-slate-700 border border-slate-700"
          >
            Choose folder…
          </button>
          <button
            onClick={runWalk}
            disabled={!root || busy}
            className="px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? "Walking…" : "Walk + persist"}
          </button>
        </div>

        {root && (
          <div className="text-sm">
            <span className="text-slate-400">Folder:</span>{" "}
            <code className="text-slate-200">{root}</code>
          </div>
        )}

        {error && (
          <div className="rounded-md border border-red-700/60 bg-red-900/30 p-3 text-sm text-red-200">
            {error}
          </div>
        )}

        {result && (
          <div className="rounded-md border border-slate-800 bg-slate-900/60 p-4 text-sm space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Files" value={result.fileCount.toLocaleString()} />
              <Stat label="Directories" value={result.dirCount.toLocaleString()} />
              <Stat label="Total" value={formatBytes(result.totalBytes)} />
              <Stat label="Duration" value={`${result.durationMs} ms`} />
            </div>
            <div className="text-xs text-slate-400 break-all">
              <span className="text-slate-500">DB:</span> {result.dbPath}
            </div>
            <details className="text-xs">
              <summary className="cursor-pointer text-slate-400 hover:text-slate-200">
                First 50 entries
              </summary>
              <ul className="mt-2 max-h-72 overflow-y-auto font-mono space-y-0.5">
                {result.entries.slice(0, 50).map((e) => (
                  <li key={e.relPath} className="text-slate-300">
                    {e.isDirectory ? "📁" : "📄"} {e.relPath}{" "}
                    {!e.isDirectory && (
                      <span className="text-slate-500">({formatBytes(e.size)})</span>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded bg-slate-950/40 border border-slate-800 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-lg font-medium tabular-nums">{value}</div>
    </div>
  );
}
