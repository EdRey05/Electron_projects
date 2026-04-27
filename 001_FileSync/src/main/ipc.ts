import { app, dialog, ipcMain } from "electron";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { walk } from "./engine/walker";
import {
  openStateDb,
  upsertSideA,
  transaction,
  listRunActions,
  listRunLogs,
  type RunActionRow,
  type RunLogRow,
} from "./engine/state-db";
import { dryRun, type DryRunResult } from "./engine/runner";
import { apply, type ApplyProgress, type ApplyResult } from "./engine/applier";
import { deleteJob, loadJobs, upsertJob } from "./jobs/store";
import type {
  ConflictPolicy,
  DiffPlan,
  Job,
  JobFilters,
  SyncDirection,
  WalkRequest,
  WalkResult,
} from "@shared/types";

import { createHash } from "node:crypto";

function jobsFilePath(): string {
  return join(app.getPath("userData"), "jobs.json");
}

/**
 * Stable id for an ad-hoc folder pair, used when there is no saved job —
 * a sha1 of "<sideA>|<sideB>" (case-folded), truncated to 16 hex chars.
 * Same path pair always resolves to the same id, so the per-pair state DB
 * and trash directory are consistent across Workspace runs.
 */
function deriveAdhocJobId(sideA: string, sideB: string): string {
  const key = `${sideA.toLowerCase()}|${sideB.toLowerCase()}`;
  return "adhoc-" + createHash("sha1").update(key).digest("hex").slice(0, 16);
}

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

  // ---------- jobs ----------

  ipcMain.handle("jobs:list", async (): Promise<Job[]> => {
    return loadJobs(jobsFilePath());
  });

  ipcMain.handle("jobs:upsert", async (_evt, input: Partial<Job>): Promise<Job> => {
    return upsertJob(jobsFilePath(), input);
  });

  ipcMain.handle("jobs:delete", async (_evt, id: string): Promise<void> => {
    await deleteJob(jobsFilePath(), id);
  });

  // ---------- engine ----------

  ipcMain.handle(
    "engine:dryRun",
    async (
      _evt,
      req: {
        jobId?: string;
        sideA: string;
        sideB: string;
        direction?: SyncDirection;
        filters?: JobFilters;
        policy?: ConflictPolicy;
        followSymlinks?: boolean;
      },
    ): Promise<DryRunResult> => {
      const dbDir = join(app.getPath("userData"), "jobs");
      mkdirSync(dbDir, { recursive: true });
      const jobId = req.jobId ?? deriveAdhocJobId(req.sideA, req.sideB);
      return dryRun({
        jobId,
        sideA: req.sideA,
        sideB: req.sideB,
        direction: req.direction,
        stateDbPath: join(dbDir, `${jobId}.sqlite`),
        filters: req.filters,
        policy: req.policy,
        followSymlinks: req.followSymlinks,
      });
    },
  );

  ipcMain.handle(
    "engine:apply",
    async (
      evt,
      req: {
        jobId?: string;
        sideA: string;
        sideB: string;
        plan: DiffPlan;
        trash: { enabled: boolean; retainDays: number };
        preserveTimestamps?: boolean;
      },
    ): Promise<ApplyResult> => {
      const dbDir = join(app.getPath("userData"), "jobs");
      mkdirSync(dbDir, { recursive: true });
      const jobId = req.jobId ?? deriveAdhocJobId(req.sideA, req.sideB);
      const stateDbPath = join(dbDir, `${jobId}.sqlite`);
      const sender = evt.sender;
      return apply({
        jobId,
        sideA: req.sideA,
        sideB: req.sideB,
        stateDbPath,
        plan: req.plan,
        trash: req.trash,
        preserveTimestamps: req.preserveTimestamps,
        onProgress: (p: ApplyProgress) => {
          if (!sender.isDestroyed()) {
            sender.send("engine:apply:progress", { jobId, ...p });
          }
        },
      });
    },
  );

  // ---------- history ----------

  ipcMain.handle(
    "history:list",
    async (
      _evt,
      jobId: string,
    ): Promise<{ runs: RunLogRow[] }> => {
      const dbDir = join(app.getPath("userData"), "jobs");
      const stateDbPath = join(dbDir, `${jobId}.sqlite`);
      if (!existsSync(stateDbPath)) return { runs: [] };
      const db = await openStateDb(stateDbPath);
      try {
        return { runs: listRunLogs(db, 200) };
      } finally {
        db.close();
      }
    },
  );

  ipcMain.handle(
    "history:actions",
    async (
      _evt,
      req: { jobId: string; runId: number },
    ): Promise<{ actions: RunActionRow[] }> => {
      const dbDir = join(app.getPath("userData"), "jobs");
      const stateDbPath = join(dbDir, `${req.jobId}.sqlite`);
      if (!existsSync(stateDbPath)) return { actions: [] };
      const db = await openStateDb(stateDbPath);
      try {
        return { actions: listRunActions(db, req.runId) };
      } finally {
        db.close();
      }
    },
  );
}
