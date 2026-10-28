import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { upsertJob, loadJobs } from "../../src/main/jobs/store";
import { dryRun } from "../../src/main/engine/runner";
import { apply, type ApplyProgress } from "../../src/main/engine/applier";
import { planMetrics } from "../../src/shared/plan-metrics";
import { PlanOverview } from "../../src/renderer/components/PlanOverview";
import { transferLabel } from "../../src/renderer/components/TransferProgress";
import { AnalyzeProgress } from "../../src/renderer/components/AnalyzeProgress";
import type { DiffPlan, Job } from "../../src/shared/types";

const roots: string[] = [];
function folder() { const p = mkdtempSync(join(tmpdir(), "filesync-workflow-")); roots.push(p); return p; }
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function request(job: Job, stateDbPath: string) {
  return { jobId: job.id, sideA: job.sideA, sideB: job.sideB, direction: job.direction,
    filters: job.filters, stateDbPath, preserveTimestamps: job.preserveTimestamps, trash: job.trash };
}

describe("saved-job filesystem workflows", () => {
  it.each(["a-to-b", "b-to-a"] as const)("persists and executes %s, including older-source timestamps and trash", async direction => {
    const a = folder(), b = folder(), config = folder();
    const src = direction === "a-to-b" ? a : b;
    const dest = direction === "a-to-b" ? b : a;
    writeFileSync(join(src, "shared.txt"), "AAAA");
    writeFileSync(join(dest, "shared.txt"), "BBBB");
    utimesSync(join(src, "shared.txt"), 1_600_000_000, 1_600_000_000);
    utimesSync(join(dest, "shared.txt"), 1_700_000_000, 1_700_000_000);
    writeFileSync(join(src, "new.txt"), "NEW");
    writeFileSync(join(dest, "extra.bin"), Buffer.alloc(1024 * 1024, 42));
    const jobs = join(config, "jobs.json");
    const saved = await upsertJob(jobs, { name: `Mirror ${direction}`, sideA: a, sideB: b, direction });
    const [job] = await loadJobs(jobs);
    expect(job.id).toBe(saved.id); expect(job.direction).toBe(direction);
    const req = request(job, join(config, "state.sqlite"));
    const { plan } = await dryRun(req);
    expect(planMetrics(plan)).toEqual({ copies: 2, deletions: 1, conflicts: 0, bytes: 7 });
    const updates: ApplyProgress[] = [];
    const result = await apply({ ...req, plan, onProgress: p => updates.push(p) });
    expect(result.status).toBe("ok");
    expect(result.filesCopied).toBe(2); expect(result.filesDeleted).toBe(1);
    expect(result.bytesTransferred).toBe(7);
    expect(updates.every(p => p.bytesTotal === 7)).toBe(true); // deletion size must never inflate payload
    expect(updates.some(p => p.currentAction === (direction === "a-to-b" ? "delete-b" : "delete-a") && p.stage === "actions")).toBe(true);
    expect(updates.at(-1)).toMatchObject({ doneActions: 3, totalActions: 3, stage: "complete", bytesTransferred: 7 });
    expect(readFileSync(join(dest, "shared.txt"), "utf8")).toBe("AAAA");
    expect(readFileSync(join(dest, "new.txt"), "utf8")).toBe("NEW");
    expect(readFileSync(join(src, "shared.txt"), "utf8")).toBe("AAAA");
    expect(existsSync(join(dest, "extra.bin"))).toBe(false);
    expect(existsSync(join(dest, ".filesync-trash", job.id))).toBe(true);
    expect(planMetrics((await dryRun(req)).plan)).toEqual({ copies: 0, deletions: 0, conflicts: 0, bytes: 0 });
  });

  it("persists and executes bidirectional sync, then propagates an edit and a deletion", async () => {
    const a = folder(), b = folder(), config = folder();
    writeFileSync(join(a, "alpha.txt"), "AA"); writeFileSync(join(b, "beta.txt"), "BBB");
    const jobs = join(config, "jobs.json");
    await upsertJob(jobs, { name: "Two-way test", sideA: a, sideB: b, direction: "sync" });
    const [job] = await loadJobs(jobs); const req = request(job, join(config, "state.sqlite"));
    expect((await apply({ ...req, plan: (await dryRun(req)).plan })).status).toBe("ok");
    expect(readFileSync(join(a, "beta.txt"), "utf8")).toBe("BBB");
    expect(readFileSync(join(b, "alpha.txt"), "utf8")).toBe("AA");
    writeFileSync(join(a, "alpha.txt"), "updated alpha");
    const { unlink } = await import("node:fs/promises"); await unlink(join(b, "beta.txt"));
    const plan = (await dryRun(req)).plan;
    expect(plan.actions.some(p => p.path === "alpha.txt" && p.kind === "copy-a-to-b")).toBe(true);
    expect(plan.actions.some(p => p.path === "beta.txt" && p.kind === "delete-a")).toBe(true);
    expect((await apply({ ...req, plan })).status).toBe("ok");
    expect(readFileSync(join(b, "alpha.txt"), "utf8")).toBe("updated alpha");
    expect(existsSync(join(a, "beta.txt"))).toBe(false);
    expect(planMetrics((await dryRun(req)).plan)).toEqual({ copies: 0, deletions: 0, conflicts: 0, bytes: 0 });
  });
});

describe("unambiguous progress and summaries", () => {
  const plan: DiffPlan = { actions: [{ kind: "copy-a-to-b", path: "new", bytes: 7, reason: "new on A" },
    { kind: "delete-b", path: "old", bytes: 999, reason: "extra" }],
    summary: { copyAToB: 1, copyBToA: 0, deleteA: 0, deleteB: 1, conflicts: 0, noops: 0, bytesToTransfer: 7 } };
  it("shows explicit folder totals, a source denominator and only four wider cards", () => {
    const html = renderToStaticMarkup(createElement(PlanOverview, { plan, direction: "a-to-b",
      walkA: { fileCount: 350000, totalBytes: 1.6 * 1024 ** 4 }, walkB: { fileCount: 340000, totalBytes: 1.5 * 1024 ** 4 }, durationMs: 590000 }));
    expect(html).toContain(`1 of ${(350000).toLocaleString()} files`);
    expect(html).toContain("7 B of 1.60 TB · A");
    expect(html).toContain("Folder A · total");
    expect(html).toContain("Folder B · total");
    expect(html.match(/<dl /g)).toHaveLength(4);
    expect(html).toContain("grid-cols-4");
    expect(html).not.toContain('aria-label="Checked"');
  });
  it("marks all four cards green only when the caller confirms a clean result check", () => {
    const html = renderToStaticMarkup(createElement(PlanOverview, { plan, direction: "a-to-b", validated: true,
      walkA: { fileCount: 10, totalBytes: 100 }, walkB: { fileCount: 10, totalBytes: 100 }, durationMs: 100 }));
    expect(html.match(/aria-label="Checked"/g)).toHaveLength(4);
    expect(html.match(/bg-emerald-100/g)).toHaveLength(4);
  });
  it("labels copying, trash, permanent deletion and cleanup distinctly", () => {
    const base = { jobId: "test", doneActions: 0, totalActions: 1, bytesTransferred: 0, bytesTotal: 7, currentPath: "file", errors: 0 };
    expect(transferLabel({ ...base, currentAction: "copy-a-to-b" })).toContain("Copying and verifying");
    expect(transferLabel({ ...base, currentAction: "delete-b" })).toContain("local trash");
    expect(transferLabel({ ...base, currentAction: "delete-b" }, false)).toContain("Deleting");
    expect(transferLabel({ ...base, stage: "trash-cleanup" })).toContain("cleaning expired trash");
  });
  it("fills discovery at completion while clearly identifying metadata result checking", () => {
    const now = Date.now(); const side = { fileCount: 350000, dirCount: 2, totalBytes: 1.6 * 1024 ** 4, currentPath: "last-file", lastEntryAt: now, complete: true };
    const html = renderToStaticMarkup(createElement(AnalyzeProgress, { purpose: "verify", startedAt: now,
      progress: { jobId: "check", startedAt: now, updatedAt: now, stage: "inventory", a: side, b: side } }));
    expect(html).toContain("Checking results"); expect(html).toContain('aria-valuenow="100"');
    expect(html).toContain("w-full"); expect(html).not.toContain("analysis-activity");
    expect(html).toContain("not a whole-drive checksum check");
  });
});
