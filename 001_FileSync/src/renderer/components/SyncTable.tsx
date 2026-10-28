import { useCallback, useMemo, useState } from "react";
import type { ItemAction } from "@shared/types";
import type { SyncItem } from "@shared/inventory";
import { resolveOverride } from "@shared/inventory";
import { formatBytes, formatTime } from "../lib/format";

/**
 * The AllwaySync sync table.
 *
 * One row per file AND per folder, in an expandable tree (like the left panel
 * of Windows Explorer). Every row carries a dropdown that picks what happens
 * to that item, and the dropdown is the thing Ed remembers most about
 * AllwaySync: "a table with widgets to select in which direction the sync
 * goes, for each item, folder, or everything".
 *
 * Columns: Name | A (left folder) | B (right folder) | Action | Status.
 * The A and B columns show size + timestamp for each side, or "—" when the
 * item does not exist there.
 */

export const ACTION_LABELS: Record<ItemAction, string> = {
  auto: "Auto (use diff)",
  "copy-a-to-b": "Copy A → B",
  "copy-b-to-a": "Copy B → A",
  "keep-both": "Keep both",
  "keep-a": "Keep A (overwrite B)",
  "keep-b": "Keep B (overwrite A)",
  "delete-a": "Delete on A",
  "delete-b": "Delete on B",
  skip: "Skip this item",
};

export const ACTION_MENU_ORDER: ItemAction[] = [
  "auto",
  "copy-a-to-b",
  "copy-b-to-a",
  "keep-both",
  "keep-a",
  "keep-b",
  "delete-a",
  "delete-b",
  "skip",
];

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  item: SyncItem;
  children: TreeNode[];
  /** Files beneath this folder that need attention. */
  pending: number;
  total: number;
  bytes: number;
  /** True when this row should be rendered given the current filter. */
  visible: boolean;
}

/**
 * Build the row tree.
 *
 * `allItems` is the complete inventory — it drives the per-folder counts, so
 * a folder still says "3 items" even when the "Only changes" filter hides
 * the files inside it. `isVisible` decides which rows actually get rendered.
 */
function buildTree(
  allItems: SyncItem[],
  isVisible: (item: SyncItem) => boolean,
  hideSyncedFolders: boolean,
): TreeNode[] {
  const root: TreeNode = {
    name: "",
    path: "",
    isDir: true,
    item: allItems[0] ?? ({} as SyncItem),
    children: [],
    pending: 0,
    total: 0,
    bytes: 0,
    visible: true,
  };
  const dirIndex = new Map<string, TreeNode>([["", root]]);
  const itemsByPath = new Map(allItems.map((i) => [i.path, i]));

  const ensureDir = (path: string): TreeNode => {
    const existing = dirIndex.get(path);
    if (existing) return existing;
    const slash = path.lastIndexOf("/");
    const parentPath = slash === -1 ? "" : path.slice(0, slash);
    const name = slash === -1 ? path : path.slice(slash + 1);
    const parent = ensureDir(parentPath);
    const node: TreeNode = {
      name,
      path,
      isDir: true,
      item: itemsByPath.get(path)!,
      children: [],
      pending: 0,
      total: 0,
      bytes: 0,
      visible: true,
    };
    dirIndex.set(path, node);
    parent.children.push(node);
    return node;
  };

  for (const item of allItems) {
    if (item.isDirectory) {
      ensureDir(item.path);
      continue;
    }
    const slash = item.path.lastIndexOf("/");
    const parentPath = slash === -1 ? "" : item.path.slice(0, slash);
    const parent = ensureDir(parentPath);
    parent.children.push({
      name: slash === -1 ? item.path : item.path.slice(slash + 1),
      path: item.path,
      isDir: false,
      item,
      children: [],
      pending: 0,
      total: 0,
      bytes: 0,
      visible: isVisible(item),
    });
  }

  // Aggregate counts bottom-up. Counts come from EVERY item, not just the
  // visible ones, so a folder's "N items" stays accurate under a filter.
  const aggregate = (n: TreeNode): { pending: number; total: number; bytes: number } => {
    let pending = 0;
    let total = 0;
    let bytes = 0;
    let childVisible = false;
    for (const c of n.children) {
      const a = aggregate(c);
      pending += a.pending;
      total += a.total;
      bytes += a.bytes;
      if (c.visible) childVisible = true;
    }
    if (!n.isDir) {
      pending = n.item.inSync ? 0 : 1;
      total = 1;
      bytes = n.item.aSize ?? n.item.bSize ?? 0;
    } else if (n.path !== "") {
      // A folder that exists on one side only is itself "pending".
      const self = itemsByPath.get(n.path);
      if (self && !self.inSync && self.aExists !== self.bExists) pending += 1;
    }
    n.pending = pending;
    n.total = total;
    n.bytes = bytes;
    // A folder is visible when it has a visible descendant, or when it is
    // itself pending (e.g. it exists on only one side).
    n.visible = n.path === "" ? true : n.isDir ? childVisible : n.visible;
    return { pending, total, bytes };
  };
  aggregate(root);

  // "Only changes" should also hide folders whose whole subtree is in sync.
  if (hideSyncedFolders) {
    const pruneInvisible = (n: TreeNode): void => {
      for (const c of n.children) pruneInvisible(c);
      if (n.isDir && n.path !== "" && n.pending === 0) n.visible = false;
    };
    pruneInvisible(root);
  }

  const sortChildren = (n: TreeNode): void => {
    n.children.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
    for (const c of n.children) sortChildren(c);
  };
  sortChildren(root);

  return root.children;
}

export interface SyncTableProps {
  items: SyncItem[];
  /** Current per-path action selections. */
  overrides: Record<string, ItemAction>;
  onSetAction(path: string, action: ItemAction): void;
  /** Apply an action to a folder and everything under it. */
  onApplyToSubtree(path: string, action: ItemAction): void;
  /** Apply an action to EVERYTHING (the root row). */
  onApplyToAll(action: ItemAction): void;
  /** Show only rows that need attention. */
  showOnlyChanges: boolean;
  onToggleShowOnlyChanges(next: boolean): void;
  /** Text filter on the path. */
  filter: string;
  onChangeFilter(next: string): void;
  /** Selected row path, for detail pane. */
  selected: string | null;
  onSelect(path: string | null): void;
}

export function SyncTable({
  items,
  overrides,
  onSetAction,
  onApplyToSubtree,
  onApplyToAll,
  showOnlyChanges,
  onToggleShowOnlyChanges,
  filter,
  onChangeFilter,
  selected,
  onSelect,
}: SyncTableProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // The filter decides which rows are rendered; the counts always come from
  // the full inventory so a folder's "N items" never lies.
  const needle = filter.trim().toLowerCase();
  const isVisible = useCallback(
    (i: SyncItem) => {
      if (showOnlyChanges && i.inSync && !i.isDirectory) return false;
      if (needle && !i.path.toLowerCase().includes(needle)) return false;
      return true;
    },
    [showOnlyChanges, needle],
  );

  const tree = useMemo(
    () => buildTree(items, isVisible, showOnlyChanges),
    [items, isVisible, showOnlyChanges],
  );

  const pendingCount = useMemo(
    () => items.filter((i) => !i.inSync && !i.isDirectory).length,
    [items],
  );

  // The root override ("" key) is the "apply to everything" action.
  const rootAction: ItemAction = overrides[""] ?? "auto";

  function toggle(path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <div className="mt-4 rounded-md border border-outline overflow-hidden">
      <div className="bg-panel-muted px-3 py-2 flex items-center justify-between gap-3 flex-wrap">
        <div className="text-xs uppercase tracking-wide text-slate-700 flex items-center gap-3">
          <span>
            {items.length.toLocaleString()} item{items.length === 1 ? "" : "s"}
          </span>
          <span className={pendingCount > 0 ? "text-amber-800" : "text-emerald-800"}>
            {pendingCount.toLocaleString()} need attention
          </span>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={filter}
            onChange={(e) => onChangeFilter(e.target.value)}
            placeholder="Filter paths…"
            className="bg-panel border border-slate-400 rounded px-2 py-1 text-xs font-mono text-slate-900 focus:outline-none focus:border-emerald-500 w-40"
          />
          <label className="flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showOnlyChanges}
              onChange={(e) => onToggleShowOnlyChanges(e.target.checked)}
            />
            Only changes
          </label>
        </div>
      </div>

      {/* "Apply to everything" — the AllwaySync master action. Setting it
          writes the root key ("") into the override map, which every path
          inherits. */}
      <div className="bg-panel border-t border-outline px-3 py-2 flex items-center gap-2 flex-wrap">
        <span className="text-xs uppercase tracking-wide text-slate-600">
          Apply to all
        </span>
        <div className="inline-flex rounded border border-slate-400 overflow-hidden">
          {(["auto", "copy-a-to-b", "copy-b-to-a", "keep-both", "skip"] as ItemAction[]).map(
            (a) => (
              <button
                key={a}
                onClick={() => onApplyToAll(a)}
                title={ACTION_LABELS[a]}
                className={`px-2 py-1 text-xs border-r border-slate-400 last:border-r-0 transition-colors ${
                  rootAction === a
                    ? "bg-emerald-700 text-white"
                    : "bg-panel-muted text-slate-700 hover:bg-slate-200"
                }`}
              >
                {a === "auto"
                  ? "Reset"
                  : a === "copy-a-to-b"
                    ? "→"
                    : a === "copy-b-to-a"
                      ? "←"
                      : a === "keep-both"
                        ? "⇄"
                        : "Skip"}
              </button>
            ),
          )}
        </div>
        {rootAction !== "auto" && (
          <span className="text-xs text-emerald-800">
            every item is set to “{ACTION_LABELS[rootAction]}”
          </span>
        )}
      </div>

      <div className="overflow-x-auto"><div className="min-w-[760px]">
      <div className="bg-panel-muted px-3 py-1.5 text-xs uppercase tracking-wide text-slate-600 grid grid-cols-[minmax(10rem,1.2fr)_5rem_5rem_11rem_minmax(12rem,1.5fr)] gap-2">
        <span>Name</span>
        <span className="text-right">A</span>
        <span className="text-right">B</span>
        <span>Action</span>
        <span>Status</span>
      </div>

      <div className="max-h-[58vh] overflow-y-auto font-mono text-xs">
        {tree.filter((n) => n.visible).length === 0 ? (
          <div className="text-sm text-slate-600 italic px-3 py-6 border-t border-outline">
            {filter
              ? "No paths match the filter."
              : "Nothing to show — both sides are already in sync."}
          </div>
        ) : (
          tree
            .filter((n) => n.visible)
            .map((node) => (
              <Row
                key={node.path}
                node={node}
                depth={0}
                collapsed={collapsed}
                onToggle={toggle}
                overrides={overrides}
                onSetAction={onSetAction}
                onApplyToSubtree={onApplyToSubtree}
                selected={selected}
                onSelect={onSelect}
              />
            ))
        )}
      </div>
      </div></div>
    </div>
  );
}

function Row({
  node,
  depth,
  collapsed,
  onToggle,
  overrides,
  onSetAction,
  onApplyToSubtree,
  selected,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  onToggle(path: string): void;
  overrides: Record<string, ItemAction>;
  onSetAction(path: string, action: ItemAction): void;
  onApplyToSubtree(path: string, action: ItemAction): void;
  selected: string | null;
  onSelect(path: string | null): void;
}) {
  const isCollapsed = collapsed.has(node.path);
  // A folder can inherit an action from a parent folder or from the root
  // ("apply to all"). The dropdown shows the *effective* action so the user
  // can see what will really happen to that subtree.
  const own = overrides[node.path];
  const inherited = resolveOverride(node.path, overrides);
  const current = own ?? inherited;
  const isSelected = selected === node.path;
  const pad = 12 + depth * 14;

  if (node.isDir) {
    return (
      <>
        <div
          className={`grid grid-cols-[minmax(10rem,1.2fr)_5rem_5rem_11rem_minmax(12rem,1.5fr)] gap-2 items-center px-3 py-1 border-t border-outline hover:bg-panel ${
            isSelected ? "bg-emerald-50" : ""
          }`}
          style={{ paddingLeft: pad }}
        >
          <button
            className="text-left text-slate-700 hover:text-slate-900 truncate flex items-center gap-1"
            onClick={() => onToggle(node.path)}
            title={isCollapsed ? "Expand" : "Collapse"}
          >
            <span className="text-slate-600 select-none">{isCollapsed ? "▶" : "▼"}</span>
            <span className="truncate">{node.name}/</span>
            {node.pending > 0 && (
              <span className="text-xs text-amber-800">({node.pending})</span>
            )}
          </button>
          <span className="text-right text-slate-600">—</span>
          <span className="text-right text-slate-600">—</span>
          <ActionSelect
            value={current}
            onChange={(a) => onApplyToSubtree(node.path, a)}
            title="Applies to this folder and everything inside it"
          />
          <span className="text-slate-600 text-xs">
            {node.total} item{node.total === 1 ? "" : "s"}
          </span>
        </div>
        {!isCollapsed &&
          node.children
            .filter((c) => c.visible)
            .map((c) => (
              <Row
                key={c.path}
                node={c}
                depth={depth + 1}
                collapsed={collapsed}
                onToggle={onToggle}
                overrides={overrides}
                onSetAction={onSetAction}
                onApplyToSubtree={onApplyToSubtree}
                selected={selected}
                onSelect={onSelect}
              />
            ))}
      </>
    );
  }

  const item = node.item;
  // A file inherits the action of its folder (or the root) when it has no
  // override of its own. The dropdown shows the effective action; setting a
  // value writes a file-level override, which then wins over the folder.
  const ownAction = overrides[item.path];
  const effective = ownAction ?? resolveOverride(item.path, overrides);
  const isOverridden = effective !== "auto";

  return (
    <div
      className={`grid grid-cols-[minmax(10rem,1.2fr)_5rem_5rem_11rem_minmax(12rem,1.5fr)] gap-2 items-center px-3 py-1 border-t border-outline hover:bg-panel ${
        isSelected ? "bg-emerald-50" : ""
      }`}
      style={{ paddingLeft: pad }}
      onClick={() => onSelect(item.path)}
    >
      <span
        className={`truncate ${isOverridden ? "text-emerald-800" : "text-slate-900"}`}
        title={item.path}
      >
        {node.name}
      </span>
      <SideCell
        exists={item.aExists}
        size={item.aSize}
        mtime={item.aMtime}
      />
      <SideCell
        exists={item.bExists}
        size={item.bSize}
        mtime={item.bMtime}
      />
      <ActionSelect
        value={effective}
        onChange={(a) => onSetAction(item.path, a)}
        title={item.reason}
      />
      <span
        className={
          item.inSync
            ? "text-slate-600 text-xs"
            : "text-amber-800 text-xs break-words whitespace-normal"
        }
        title={item.reason}
      >
        {isOverridden ? `Selected: ${ACTION_LABELS[effective]}. ${item.reason}` : item.inSync ? "Same size and modification time" : item.reason}
      </span>
    </div>
  );
}

function SideCell({
  exists,
  size,
  mtime,
}: {
  exists: boolean;
  size: number | null;
  mtime: number | null;
}) {
  if (!exists) {
    return <span className="text-right text-slate-600 text-xs">missing</span>;
  }
  return (
    <span
      className="text-right text-slate-700 text-xs truncate"
      title={mtime ? formatTime(mtime) : ""}
    >
      {formatBytes(size ?? 0)}
    </span>
  );
}

function ActionSelect({
  value,
  onChange,
  title,
}: {
  value: ItemAction;
  onChange(action: ItemAction): void;
  title?: string;
}) {
  return (
    <select
      value={value}
      title={title}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value as ItemAction)}
      className={`w-full bg-panel border rounded px-1.5 py-0.5 text-xs focus:outline-none focus:border-emerald-500 ${
        value === "auto"
          ? "border-slate-400 text-slate-700"
          : "border-emerald-700 text-emerald-800"
      }`}
    >
      {ACTION_MENU_ORDER.map((a) => (
        <option key={a} value={a}>
          {ACTION_LABELS[a]}
        </option>
      ))}
    </select>
  );
}
