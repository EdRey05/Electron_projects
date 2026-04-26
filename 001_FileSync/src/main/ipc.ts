import { app, dialog, ipcMain } from "electron";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { walk } from "./engine/walker";
import { openStateDb, upsertSideA, transaction } from "./engine/state-db";
import { dryRun, type DryRunResult } from "./engine/runner";
import type { ConflictPolicy, JobFilters, WalkRequest, WalkResult } from "@shared/types";

export function registerIpcHandlers(): void {
  ipcMain.handle("dialog:openDirectory", async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      title: "Choose a folder",
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("app:userDataPath", async () => app.getPath("userData"));

  ipcMain.handle(
    "engine:walkAndPersist",
    async (
      _evt,
      req: WalkRequest,
    ): Promise<WalkResult & { sessionId: string; dbPath: string }> => {
      const sessionId = randomUUID();
      const dbDir = join(app.getPath("userData"), "walks");
      mkdirSync(dbDir, { recursive: true });
      const dbPath = join(dbDir, `${sessionId}.sqlite`);

      const started = Date.now();
      const result = await walk(req);
      const durationMs = Date.now() - started;

      const db = await openStateDb(dbPath);
      try {
        transaction(db, () => {
          for (const e of result.entries) {
            if (e.isDirectory) continue;
            upsertSideA(db, e.relPath, e.size, e.mtimeMs);
          }
        });
        db.flush();
      } finally {
        db.close();
      }

      return { ...result, durationMs, sessionId, dbPath };
    },
  );

  ipcMain.handle(
    "engine:dryRun",
    async (
      _evt,
      req: {
        jobId: string;
        sideA: string;
        sideB: string;
        filters?: JobFilters;
        policy?: ConflictPolicy;
        followSymlinks?: boolean;
      },
    ): Promise<DryRunResult> => {
      const dbDir = join(app.getPath("userData"), "jobs");
      mkdirSync(dbDir, { recursive: true });
      return dryRun({
        jobId: req.jobId,
        sideA: req.sideA,
        sideB: req.sideB,
        stateDbPath: join(dbDir, `${req.jobId}.sqlite`),
        filters: req.filters,
        policy: req.policy,
        followSymlinks: req.followSymlinks,
      });
    },
  );
}
