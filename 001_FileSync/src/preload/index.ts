import { contextBridge, ipcRenderer } from "electron";
import type {
  ApplyProgressEvent,
  ApplyRequest,
  ApplyResponse,
  DryRunRequest,
  FileSyncAPI,
  HistoryActionsResponse,
  HistoryListResponse,
} from "@shared/api";
import type { Job, WalkRequest } from "@shared/types";

const api: FileSyncAPI = {
  dialog: {
    openDirectory: () => ipcRenderer.invoke("dialog:openDirectory"),
  },
  jobs: {
    list: () => ipcRenderer.invoke("jobs:list"),
    upsert: (job: Partial<Job>) => ipcRenderer.invoke("jobs:upsert", job),
    delete: (id: string) => ipcRenderer.invoke("jobs:delete", id),
  },
  engine: {
    walkAndPersist: (req: WalkRequest) => ipcRenderer.invoke("engine:walkAndPersist", req),
    dryRun: (req: DryRunRequest) => ipcRenderer.invoke("engine:dryRun", req),
    apply: (req: ApplyRequest): Promise<ApplyResponse> => ipcRenderer.invoke("engine:apply", req),
    onApplyProgress: (cb: (p: ApplyProgressEvent) => void) => {
      const listener = (_evt: unknown, payload: ApplyProgressEvent) => cb(payload);
      ipcRenderer.on("engine:apply:progress", listener);
      return () => ipcRenderer.off("engine:apply:progress", listener);
    },
  },
  history: {
    list: (jobId: string): Promise<HistoryListResponse> =>
      ipcRenderer.invoke("history:list", jobId),
    actions: (req: { jobId: string; runId: number }): Promise<HistoryActionsResponse> =>
      ipcRenderer.invoke("history:actions", req),
  },
  app: {
    userDataPath: () => ipcRenderer.invoke("app:userDataPath"),
  },
};

contextBridge.exposeInMainWorld("api", api);
