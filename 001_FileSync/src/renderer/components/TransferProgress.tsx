import type { ApplyProgressEvent } from "@shared/api";
import { formatBytes } from "../lib/format";

export function transferLabel(p: ApplyProgressEvent, trashEnabled = true): string {
  if (p.stage === "complete") return "File operations complete";
  if (p.stage === "trash-cleanup") return "File operations complete · cleaning expired trash";
  switch (p.currentAction) {
    case "copy-a-to-b": return "Copying and verifying Folder A → B";
    case "copy-b-to-a": return "Copying and verifying Folder B → A";
    case "delete-a": return trashEnabled ? "Moving Folder A file to local trash" : "Deleting Folder A file";
    case "delete-b": return trashEnabled ? "Moving Folder B file to local trash" : "Deleting Folder B file";
    case "keep-both": return "Preserving both versions";
    case "conflict": return "Leaving unresolved conflict unchanged";
    case "drop-from-state": return "Updating the synchronization index";
    default: return "Preparing file operations…";
  }
}

export function TransferProgress({ progress, trashEnabled = true }: { progress: ApplyProgressEvent; trashEnabled?: boolean }) {
  const percent = progress.totalActions ? Math.min(100, Math.round(progress.doneActions / progress.totalActions * 100)) : 0;
  return (
    <section className="mt-4 rounded-xl border border-emerald-300 bg-emerald-50 p-4" aria-label="File operation progress">
      <div className="flex flex-wrap justify-between gap-2 text-sm font-semibold text-emerald-900">
        <span role="status">{transferLabel(progress, trashEnabled)}</span>
        <span className="tabular-nums">{progress.doneActions.toLocaleString()} of {progress.totalActions.toLocaleString()} actions · {percent}%</span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-emerald-200" role="progressbar" aria-label="Completed file actions" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div className="h-full bg-emerald-700 transition-all" style={{ width: `${percent}%` }} />
      </div>
      <div className="mt-3 flex flex-wrap justify-between gap-2 text-sm text-slate-700">
        <span className="min-w-0 flex-1 break-all font-mono text-xs">{progress.currentPath || "Finishing…"}</span>
        <span className="tabular-nums">Copied payload: {formatBytes(progress.bytesTransferred)} of {formatBytes(progress.bytesTotal)}</span>
      </div>
      <p className="mt-2 text-sm text-slate-600">Copy payload only · excludes trash and verification I/O. Counts update per file.</p>
      {progress.errors > 0 && <p className="mt-2 text-sm font-medium text-red-800">{progress.errors} action(s) failed; review the final result.</p>}
    </section>
  );
}
