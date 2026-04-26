import { contextBridge, ipcRenderer } from "electron";
import type { DryRunRequest, FileSyncAPI } from "@shared/api";
import type { WalkRequest } from "@shared/types";

const api: FileSyncAPI = {
  dialog: {
    openDirectory: () => ipcRenderer.invoke("dialog:openDirectory"),
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
