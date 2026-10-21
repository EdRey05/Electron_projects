import type {
  ActionKind,
  ConflictDetail,
  ItemAction,
  OverrideMap,
  WalkResult,
} from "./types";

/**
 * One row of the sync table.
 *
 * AllwaySync's defining screen is a table where every file and folder appears
 * as a row, with a widget that picks what happens to that item. `SyncItem` is
 * that row: the merged view of a path across both sides, the action the
 * differ proposed for it, and the action the user actually selected.
 */
export interface SyncItem {
  /** POSIX relative path. "" is the root (the "everything" row). */
  path: string;
  isDirectory: boolean;
  aExists: boolean;
  bExists: boolean;
  aSize: number | null;
  bSize: number | null;
  aMtime: number | null;
  bMtime: number | null;
  /** What the differ proposed, before any user override. */
  plannedKind: ActionKind;
  /** Human-readable explanation of `plannedKind`. */
  reason: string;
  /** The action that will actually run (after overrides). */
  action: ItemAction;
  /** True when the two sides are identical and nothing needs to happen. */
  inSync: boolean;
  conflict?: ConflictDetail;
  /** True when the user changed `action` away from the differ's proposal. */
  overridden: boolean;
}

function toMap(walk: WalkResult): {
  files: Map<string, { size: number; mtimeMs: number }>;
  dirs: Set<string>;
} {
  const files = new Map<string, { size: number; mtimeMs: number }>();
  const dirs = new Set<string>();
  for (const e of walk.entries) {
    if (e.isDirectory) dirs.add(e.relPath);
    else files.set(e.relPath, { size: e.size, mtimeMs: e.mtimeMs });
  }
  return { files, dirs };
}

/**
 * Merge the two walks into the full row set: every file and every directory
 * on either side gets a row, whether or not it needs an action.
 *
 * Directories are included on purpose — AllwaySync lets you pick an action
 * for a whole folder, so the folder has to be a first-class row even when
 * every file inside it is already in sync.
 */
export function buildInventory(
  walkA: WalkResult,
  walkB: WalkResult,
  actions: {
    kind: ActionKind;
    path: string;
    reason: string;
    conflict?: ConflictDetail;
  }[],
): SyncItem[] {
  const A = toMap(walkA);
  const B = toMap(walkB);
  const byPath = new Map(actions.map((a) => [a.path, a]));

  const items: SyncItem[] = [];

  const allPaths = new Set<string>([...A.files.keys(), ...B.files.keys()]);
  for (const path of [...allPaths].sort()) {
    const a = A.files.get(path);
    const b = B.files.get(path);
    const act = byPath.get(path);
    const plannedKind: ActionKind = act?.kind ?? "noop";
    items.push({
      path,
      isDirectory: false,
      aExists: !!a,
      bExists: !!b,
      aSize: a?.size ?? null,
      bSize: b?.size ?? null,
      aMtime: a?.mtimeMs ?? null,
      bMtime: b?.mtimeMs ?? null,
      plannedKind,
      reason: act?.reason ?? "not compared",
      action: "auto",
      inSync: plannedKind === "noop",
      conflict: act?.conflict,
      overridden: false,
    });
  }

  // Directories: a folder is "in sync" when every file beneath it is.
  const dirPaths = new Set<string>([...A.dirs, ...B.dirs]);
  const fileByDir = new Map<string, { total: number; unsynced: number }>();
  for (const it of items) {
    let dir = it.path;
    while (dir.includes("/")) {
      dir = dir.slice(0, dir.lastIndexOf("/"));
      const slot = fileByDir.get(dir) ?? { total: 0, unsynced: 0 };
      slot.total++;
      if (!it.inSync) slot.unsynced++;
      fileByDir.set(dir, slot);
    }
  }

  for (const path of [...dirPaths].sort()) {
    const stat = fileByDir.get(path) ?? { total: 0, unsynced: 0 };
    const aExists = A.dirs.has(path);
    const bExists = B.dirs.has(path);
    const bothSides = aExists && bExists;
    items.push({
      path,
      isDirectory: true,
      aExists,
      bExists,
      aSize: null,
      bSize: null,
      aMtime: null,
      bMtime: null,
      plannedKind: bothSides ? "noop" : "copy-a-to-b",
      reason:
        stat.unsynced === 0
          ? "folder is in sync"
          : `${stat.unsynced} of ${stat.total} item${stat.total === 1 ? "" : "s"} need attention`,
      action: "auto",
      inSync: stat.unsynced === 0,
      overridden: false,
    });
  }

  return items;
}

/**
 * Does an override key apply to this path?
 *
 * The empty key is the root and applies to everything. A non-empty key
 * applies to the path itself and to every descendant of it.
 */
export function overrideMatches(path: string, key: string): boolean {
  if (key === "") return true;
  if (path === key) return true;
  return path.startsWith(`${key}/`);
}

/**
 * Find the most specific override that applies to `path`.
 *
 * "Most specific" = longest matching key, so a file-level override beats the
 * folder-level override it sits inside, and the folder beats the root.
 */
export function resolveOverride(path: string, overrides: OverrideMap): ItemAction {
  let best: ItemAction = "auto";
  let bestLen = -1;
  for (const key of Object.keys(overrides)) {
    if (!overrideMatches(path, key)) continue;
    if (key.length > bestLen) {
      best = overrides[key];
      bestLen = key.length;
    }
  }
  return best;
}

/**
 * The action a file will actually run, given the effective override.
 *
 * Returns null when the item is not actionable at all (skipped, or the
 * source side does not have the file so there is nothing to copy).
 */
export function effectiveAction(
  item: SyncItem,
  override: ItemAction,
): ActionKind | null {
  switch (override) {
    case "auto":
      return item.plannedKind === "noop" ? null : item.plannedKind;

    case "skip":
      return null;

    case "copy-a-to-b":
      // Nothing to copy when A does not have the file.
      return item.aExists ? "copy-a-to-b" : null;

    case "copy-b-to-a":
      return item.bExists ? "copy-b-to-a" : null;

    case "keep-both":
      // Only meaningful when both sides have a (different) version.
      return item.aExists && item.bExists ? "keep-both" : null;

    case "keep-a":
      // A is the truth: push A onto B, or remove B if A is gone.
      return item.aExists ? "copy-a-to-b" : "delete-b";

    case "keep-b":
      return item.bExists ? "copy-b-to-a" : "delete-a";

    case "delete-a":
      return item.aExists ? "delete-a" : null;

    case "delete-b":
      return item.bExists ? "delete-b" : null;

    default:
      return item.plannedKind === "noop" ? null : item.plannedKind;
  }
}
