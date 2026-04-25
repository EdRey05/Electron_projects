import type { WalkRequest, WalkResult } from "./types";

export interface FileSyncAPI {
  dialog: {
    openDirectory(): Promise<string | null>;
  };
  engine: {
    walkAndPersist(req: WalkRequest): Promise<WalkResult & { sessionId: string; dbPath: string }>;
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
