import type {
  AnalysisProgress,
  ActionKind,
  ConflictPolicy,
  DiffPlan,
  Job,
  JobFilters,
  OverrideMap,
  SyncDirection,
  WalkRequest,
  WalkResult,
} from "./types";
import type { SyncItem } from "./inventory";

export interface DryRunRequest {
  /** Correlates progress to this particular analysis, including ad-hoc jobs. */
  requestId?: string;
  /** Omit for ad-hoc Workspace runs — main derives a stable id from the path pair. */
  jobId?: string;
  sideA: string;
  sideB: string;
  direction?: SyncDirection;
  filters?: JobFilters;
  policy?: ConflictPolicy;
  followSymlinks?: boolean;
  /** Mirror modes only: delete destination-only files. Defaults to true. */
  deleteExtraneous?: boolean;
  /** Per-path user action overrides from the sync table. */
  overrides?: OverrideMap;
}

export interface AnalyzeProgressEvent extends AnalysisProgress {
  requestId: string;
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
  /** The full sync table: one row per file AND per folder across both sides. */
  inventory: SyncItem[];
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
  currentAction?: ActionKind;
  stage?: "actions" | "trash-cleanup" | "complete";
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
    onAnalyzeProgress(cb: (p: AnalyzeProgressEvent) => void): () => void;
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
