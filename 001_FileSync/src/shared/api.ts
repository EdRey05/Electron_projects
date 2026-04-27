import type {
  ConflictPolicy,
  DiffPlan,
  Job,
  JobFilters,
  SyncDirection,
  WalkRequest,
  WalkResult,
} from "./types";

export interface DryRunRequest {
  /** Omit for ad-hoc Workspace runs — main derives a stable id from the path pair. */
  jobId?: string;
  sideA: string;
  sideB: string;
  direction?: SyncDirection;
  filters?: JobFilters;
  policy?: ConflictPolicy;
  followSymlinks?: boolean;
}

export interface DryRunResponse {
  jobId: string;
  sideA: string;
  sideB: string;
  direction: SyncDirection;
  walkA: { fileCount: number; totalBytes: number; durationMs: number };
  walkB: { fileCount: number; totalBytes: number; durationMs: number };
  stateLoadedRows: number;
  plan: DiffPlan;
  totalDurationMs: number;
}

export interface ApplyRequest {
  /** Omit for ad-hoc Workspace runs — main derives a stable id from the path pair. */
  jobId?: string;
  sideA: string;
  sideB: string;
  plan: DiffPlan;
  trash: { enabled: boolean; retainDays: number };
  preserveTimestamps?: boolean;
}

export interface ApplyResponse {
  runId: number;
  jobId: string;
  startedAt: number;
  endedAt: number;
  status: "ok" | "partial" | "error";
  filesCopied: number;
  filesDeleted: number;
  conflicts: number;
  bytesTransferred: number;
  errors: { path: string; action: string; message: string }[];
  trashSweep: { removedDirs: number; freedBytes: number } | null;
}

export interface ApplyProgressEvent {
  jobId: string;
  doneActions: number;
  totalActions: number;
  bytesTransferred: number;
  bytesTotal: number;
  currentPath: string;
  errors: number;
}

export interface HistoryRunRow {
  id: number;
  started_at: number;
  ended_at: number | null;
  files_copied: number;
  files_deleted: number;
  conflicts: number;
  bytes_transferred: number;
  status: string | null;
  error: string | null;
}

export interface HistoryActionRow {
  run_id: number;
  path: string;
  action: string;
  bytes: number;
  ok: number;
  message: string | null;
}

export interface HistoryListResponse {
  runs: HistoryRunRow[];
}

export interface HistoryActionsResponse {
  actions: HistoryActionRow[];
}

export interface FileSyncAPI {
  dialog: {
    openDirectory(): Promise<string | null>;
  };
  jobs: {
    list(): Promise<Job[]>;
    upsert(job: Partial<Job>): Promise<Job>;
    delete(id: string): Promise<void>;
  };
  engine: {
    walkAndPersist(req: WalkRequest): Promise<WalkResult & { sessionId: string; dbPath: string }>;
    dryRun(req: DryRunRequest): Promise<DryRunResponse>;
    apply(req: ApplyRequest): Promise<ApplyResponse>;
    /** Subscribe to apply progress events. Returns an unsubscribe fn. */
    onApplyProgress(cb: (p: ApplyProgressEvent) => void): () => void;
  };
  history: {
    list(jobId: string): Promise<HistoryListResponse>;
    actions(req: { jobId: string; runId: number }): Promise<HistoryActionsResponse>;
  };
  app: {
    userDataPath(): Promise<string>;
  };
}

declare global {
  interface Window {
    api: FileSyncAPI;
  }
}
