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
