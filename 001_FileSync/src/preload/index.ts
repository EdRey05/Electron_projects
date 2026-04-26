import { contextBridge, ipcRenderer } from "electron";
import type { DryRunRequest, FileSyncAPI } from "@shared/api";
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
  },
  app: {
    userDataPath: () => ipcRenderer.invoke("app:userDataPath"),
  },
};

contextBridge.exposeInMainWorld("api", api);
