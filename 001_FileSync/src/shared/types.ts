export type ConflictPolicy = "newer-wins" | "rename-both" | "ask";

export interface JobFilters {
  include: string[];
  exclude: string[];
}

export interface Job {
  id: string;
  name: string;
  sideA: string;
  sideB: string;
  filters: JobFilters;
  onConflict: ConflictPolicy;
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

export interface WalkRequest {
  root: string;
  filters?: JobFilters;
  followSymlinks?: boolean;
}

// ---------- Differ ----------

export type ActionKind =
  | "copy-a-to-b"
  | "copy-b-to-a"
  | "delete-a"
  | "delete-b"
  | "conflict"
  | "noop"
  | "drop-from-state";

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
