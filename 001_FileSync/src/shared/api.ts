import type {
  ConflictPolicy,
  DiffPlan,
  JobFilters,
  WalkRequest,
  WalkResult,
} from "./types";

export interface DryRunRequest {
  jobId: string;
  sideA: string;
  sideB: string;
  filters?: JobFilters;
  policy?: ConflictPolicy;
  followSymlinks?: boolean;
}

export interface DryRunResponse {
  jobId: string;
  sideA: string;
  sideB: string;
  walkA: { fileCount: number; totalBytes: number; durationMs: number };
  walkB: { fileCount: number; totalBytes: number; durationMs: number };
  stateLoadedRows: number;
  plan: DiffPlan;
  totalDurationMs: number;
}

export interface FileSyncAPI {
  dialog: {
    openDirectory(): Promise<string | null>;
  };
  engine: {
    walkAndPersist(req: WalkRequest): Promise<WalkResult & { sessionId: string; dbPath: string }>;
    dryRun(req: DryRunRequest): Promise<DryRunResponse>;
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
