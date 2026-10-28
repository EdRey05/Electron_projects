export type ConflictPolicy = "newer-wins" | "rename-both" | "ask";

/**
 * Direction of synchronization for a single Analyze/Run operation.
 *
 * - `a-to-b`: mirror — make B match A. Files only on B get deleted, A always
 *   wins on differences. No state DB needed.
 * - `b-to-a`: mirror — make A match B. Inverse of above.
 * - `sync`: bidirectional three-way merge (the original behavior). Uses the
 *   per-pair state DB to detect deletes vs new files.
 */
export type SyncDirection = "a-to-b" | "b-to-a" | "sync";

/**
 * Per-item action the user can pick in the sync table.
 *
 * This is the AllwaySync "action widget": every row (file or folder) exposes a
 * dropdown that decides what happens to that item during the next Run.
 *
 * - `auto` — no override; use whatever the differ decided.
 * - `skip` — ignore this item (and, for a folder, its whole subtree).
 * - `copy-a-to-b` — force A to overwrite B for this item.
 * - `copy-b-to-a` — force B to overwrite A for this item.
 * - `keep-both` — keep both versions side by side; the loser is preserved
 *   under a timestamped sibling name instead of being overwritten.
 * - `delete-a` / `delete-b` — move the file on that side to the trash.
 * - `keep-a` / `keep-b` — conflict resolutions: the named side wins and the
 *   other side is replaced (or removed when the winner is missing).
 */
export type ItemAction =
  | "auto"
  | "skip"
  | "copy-a-to-b"
  | "copy-b-to-a"
  | "keep-both"
  | "delete-a"
  | "delete-b"
  | "keep-a"
  | "keep-b";

/** Every valid ItemAction, in menu order. */
export const ITEM_ACTIONS: readonly ItemAction[] = [
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

/**
 * Map of relative path -> ItemAction.
 *
 * The key is a POSIX-style relative path. The empty string is the reserved key
 * for "apply to everything" (the root row). A folder path applies to every
 * descendant of that folder. A file path applies only to that file.
 */
export type OverrideMap = Record<string, ItemAction>;

export interface JobFilters {
  include: string[];
  exclude: string[];
  /**
   * Per-side ignore lists. AllwaySync lets each side of the pair have its
   * own ignore rules — useful when one folder is a mixed dump and the other
   * is a curated set. Patterns are gitignore-style globs.
   *
   * Optional so callers that only care about the shared list (and older
   * saved jobs) do not have to spell them out.
   */
  excludeA?: string[];
  excludeB?: string[];
}

export interface Job {
  id: string;
  name: string;
  sideA: string;
  sideB: string;
  filters: JobFilters;
  onConflict: ConflictPolicy;
  /** Default direction used when this job is run. */
  direction: SyncDirection;
  /** Mirror modes: delete files that exist only on the destination side. */
  deleteExtraneous: boolean;
  /** Per-path action overrides, persisted with the job. */
  overrides: OverrideMap;
  trash: { enabled: boolean; retainDays: number };
  followSymlinks: boolean;
  preserveTimestamps: boolean;
}

export interface WalkEntry {
  relPath: string;
  size: number;
  mtimeMs: number;
  isDirectory: boolean;
}

export interface WalkResult {
  root: string;
  fileCount: number;
  dirCount: number;
  totalBytes: number;
  durationMs: number;
  entries: WalkEntry[];
}

export interface WalkProgress {
  fileCount: number;
  dirCount: number;
  totalBytes: number;
  currentPath: string;
  lastEntryAt: number;
  complete: boolean;
}

export interface AnalysisProgress {
  jobId: string;
  stage: "scanning" | "loading-state" | "comparing" | "inventory" | "complete" | "failed";
  startedAt: number;
  updatedAt: number;
  a: WalkProgress;
  b: WalkProgress;
}

export interface WalkRequest {
  root: string;
  filters?: JobFilters;
  followSymlinks?: boolean;
  /**
   * Extra ignore globs applied to THIS side only. The runner passes
   * `filters.excludeA` when walking side A and `filters.excludeB` when
   * walking side B.
   */
  sideExcludes?: string[];
}

// ---------- Differ ----------

export type ActionKind =
  | "copy-a-to-b"
  | "copy-b-to-a"
  | "delete-a"
  | "delete-b"
  | "conflict"
  | "noop"
  | "drop-from-state"
  | "keep-both";

export type ConflictType = "edit-edit" | "edit-delete" | "delete-edit";

export interface ConflictDetail {
  type: ConflictType;
  aSize?: number;
  aMtime?: number;
  bSize?: number;
  bMtime?: number;
  /** What `newer-wins` would do; UI can override. */
  suggested: "keep-a" | "keep-b" | "rename-both";
}

export interface Action {
  kind: ActionKind;
  path: string;
  /** Bytes to be transferred (for copies) or freed (for deletes). 0 for noop. */
  bytes: number;
  /** Human-readable reason — surfaced in the dry-run table. */
  reason: string;
  conflict?: ConflictDetail;
  /** Which side the file currently exists on. */
  aExists?: boolean;
  bExists?: boolean;
  /** Size / mtime of the file on each side, when it exists. */
  aSize?: number;
  bSize?: number;
  aMtime?: number;
  bMtime?: number;
  /** True when the path is a directory on at least one side. */
  isDirectory?: boolean;
}

export interface DiffSummary {
  copyAToB: number;
  copyBToA: number;
  deleteA: number;
  deleteB: number;
  conflicts: number;
  noops: number;
  /** Total bytes to be transferred (copies only). */
  bytesToTransfer: number;
}

export interface DiffPlan {
  actions: Action[];
  summary: DiffSummary;
}

/** Last-known state for one path, as stored in the state DB. */
export interface StateRecord {
  aSize?: number;
  aMtime?: number;
  bSize?: number;
  bMtime?: number;
}

/** Current observed state for one path on one side. */
export interface SideMeta {
  size: number;
  mtimeMs: number;
}

export interface DiffInput {
  walkA: Map<string, SideMeta>;
  walkB: Map<string, SideMeta>;
  state: Map<string, StateRecord>;
  policy: ConflictPolicy;
  /** mtime tolerance in ms. FAT32 / SMB have 2-second resolution. */
  toleranceMs?: number;
}
