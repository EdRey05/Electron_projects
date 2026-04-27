import { useMemo, useState } from "react";
import type { Action } from "@shared/types";
import { formatBytes } from "../lib/format";

interface TreeNode {
  name: string;
  fullPath: string;
  isDir: boolean;
  action?: Action;
  children: TreeNode[];
  /** Aggregate counts for the subtree (dirs only). */
  total: number;
  totalBytes: number;
}

function buildTree(actions: Action[]): TreeNode {
  const root: TreeNode = {
    name: "",
    fullPath: "",
    isDir: true,
    children: [],
    total: 0,
    totalBytes: 0,
  };
  for (const a of actions) {
    const parts = a.path.split("/");
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const partPath = parts.slice(0, i + 1).join("/");
      let next = cur.children.find((c) => c.isDir && c.name === parts[i]);
      if (!next) {
        next = {
          name: parts[i],
          fullPath: partPath,
          isDir: true,
          children: [],
          total: 0,
          totalBytes: 0,
        };
        cur.children.push(next);
      }
      cur = next;
    }
    cur.children.push({
      name: parts[parts.length - 1],
      fullPath: a.path,
      isDir: false,
      action: a,
      children: [],
      total: 1,
      totalBytes: a.bytes,
    });
  }
  // Bubble up totals.
  function aggregate(n: TreeNode): void {
    if (!n.isDir) return;
    let total = 0;
    let totalBytes = 0;
    for (const c of n.children) {
      aggregate(c);
      if (c.isDir) {
        total += c.total;
        totalBytes += c.totalBytes;
      } else {
        total += 1;
        totalBytes += c.totalBytes;
      }
    }
    n.total = total;
    n.totalBytes = totalBytes;
    // Sort: dirs first, then files, alphabetical within each group.
    n.children.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }
  aggregate(root);
  return root;
}

const ARROWS: Record<Action["kind"], { glyph: string; cls: string; label: string }> = {
  "copy-a-to-b": { glyph: "→", cls: "text-emerald-400", label: "copy A→B" },
  "copy-b-to-a": { glyph: "←", cls: "text-emerald-400", label: "copy B→A" },
  "delete-a": { glyph: "⊘ A", cls: "text-red-400", label: "delete on A" },
  "delete-b": { glyph: "⊘ B", cls: "text-red-400", label: "delete on B" },
  conflict: { glyph: "!", cls: "text-amber-400", label: "conflict" },
  noop: { glyph: "=", cls: "text-slate-500", label: "in sync" },
  "drop-from-state": { glyph: "—", cls: "text-slate-500", label: "drop state row" },
};

export function PlanTree({
  actions,
  excluded,
  onToggleExclude,
  onToggleSubtree,
  /** Hide noop rows by default — they're noisy and never run. */
  hideNoops = true,
}: {
  actions: Action[];
  excluded: Set<string>;
  onToggleExclude(path: string): void;
  /** Toggle every actionable leaf under a directory (include all / exclude all). */
  onToggleSubtree(paths: string[], makeExcluded: boolean): void;
  hideNoops?: boolean;
}) {
  const filtered = useMemo(
    () =>
      hideNoops
        ? actions.filter(
            (a) => a.kind !== "noop" && a.kind !== "drop-from-state",
          )
        : actions,
    [actions, hideNoops],
  );
  const tree = useMemo(() => buildTree(filtered), [filtered]);

  if (filtered.length === 0) {
    return (
      <div className="mt-4 text-sm text-slate-500 italic px-3 py-6 border border-dashed border-slate-800 rounded">
        Nothing to do — both sides are already in sync.
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-md border border-slate-800 overflow-hidden">
      <div className="bg-slate-900/80 px-3 py-2 text-xs uppercase tracking-wide text-slate-400 grid grid-cols-[2rem_1fr_5rem_6rem] gap-2">
        <span></span>
        <span>Path</span>
        <span className="text-right">Size</span>
        <span>Action</span>
      </div>
      <div className="max-h-[55vh] overflow-y-auto font-mono text-xs">
        {tree.children.map((c) => (
          <NodeRow
            key={c.fullPath}
            node={c}
            depth={0}
            excluded={excluded}
            onToggleExclude={onToggleExclude}
            onToggleSubtree={onToggleSubtree}
          />
        ))}
      </div>
    </div>
  );
}

function NodeRow({
  node,
  depth,
  excluded,
  onToggleExclude,
  onToggleSubtree,
}: {
  node: TreeNode;
  depth: number;
  excluded: Set<string>;
  onToggleExclude(path: string): void;
  onToggleSubtree(paths: string[], makeExcluded: boolean): void;
}) {
  const [open, setOpen] = useState(depth < 1);

  if (!node.isDir) {
    const a = node.action!;
    const isExcluded = excluded.has(a.path);
    const arrow = ARROWS[a.kind];
    return (
      <div
        className={`grid grid-cols-[2rem_1fr_5rem_6rem] gap-2 items-center px-3 py-1 border-t border-slate-900/80 hover:bg-slate-900/40 ${
          isExcluded ? "opacity-40" : ""
        }`}
        style={{ paddingLeft: `${0.75 + depth * 1}rem` }}
      >
        <input
          type="checkbox"
          checked={!isExcluded}
          onChange={() => onToggleExclude(a.path)}
          title={isExcluded ? "Excluded — click to include" : "Included — click to exclude"}
          className="justify-self-start"
        />
        <span
          className={`truncate ${isExcluded ? "line-through" : "text-slate-200"}`}
          title={`${a.path}\n${a.reason}`}
        >
          {node.name}
        </span>
        <span className="text-right text-slate-500 tabular-nums">
          {a.bytes ? formatBytes(a.bytes) : "—"}
        </span>
        <span className={arrow.cls} title={arrow.label}>
          {arrow.glyph}
        </span>
      </div>
    );
  }

  // Directory row.
  const allLeafPaths = collectLeafPaths(node);
  const excludedInSubtree = allLeafPaths.filter((p) => excluded.has(p)).length;
  const subtreeExcluded = excludedInSubtree === allLeafPaths.length && allLeafPaths.length > 0;
  return (
    <>
      <div
        className="grid grid-cols-[2rem_1fr_5rem_6rem] gap-2 items-center px-3 py-1 border-t border-slate-900/80 hover:bg-slate-900/40"
        style={{ paddingLeft: `${0.75 + depth * 1}rem` }}
      >
        <input
          type="checkbox"
          checked={!subtreeExcluded}
          onChange={() => onToggleSubtree(allLeafPaths, !subtreeExcluded)}
          title={
            subtreeExcluded
              ? "All in subtree excluded — click to include all"
              : "Click to exclude all in subtree"
          }
          className="justify-self-start"
        />
        <button
          className="text-left text-slate-300 truncate hover:text-slate-100"
          onClick={() => setOpen((o) => !o)}
        >
          <span className="text-slate-500 mr-1">{open ? "▼" : "▶"}</span>
          {node.name}/
        </button>
        <span className="text-right text-slate-500 tabular-nums">
          {formatBytes(node.totalBytes)}
        </span>
        <span className="text-slate-500 text-[10px]">{node.total} item{node.total !== 1 ? "s" : ""}</span>
      </div>
      {open &&
        node.children.map((c) => (
          <NodeRow
            key={c.fullPath}
            node={c}
            depth={depth + 1}
            excluded={excluded}
            onToggleExclude={onToggleExclude}
            onToggleSubtree={onToggleSubtree}
          />
        ))}
    </>
  );
}

function collectLeafPaths(n: TreeNode): string[] {
  if (!n.isDir) return [n.fullPath];
  const out: string[] = [];
  for (const c of n.children) {
    if (c.isDir) out.push(...collectLeafPaths(c));
    else out.push(c.fullPath);
  }
  return out;
}
