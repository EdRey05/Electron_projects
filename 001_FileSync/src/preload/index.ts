import { contextBridge, ipcRenderer } from "electron";
import type { FileSyncAPI } from "@shared/api";
import type { WalkRequest } from "@shared/types";

const api: FileSyncAPI = {
  dialog: {
    openDirectory: () => ipcRenderer.invoke("dialog:openDirectory"),
  },
  engine: {
    walkAndPersist: (req: WalkRequest) => ipcRenderer.invoke("engine:walkAndPersist", req),
  },
  app: {
    userDataPath: () => ipcRenderer.invoke("app:userDataPath"),
  },
};

contextBridge.exposeInMainWorld("api", api);
