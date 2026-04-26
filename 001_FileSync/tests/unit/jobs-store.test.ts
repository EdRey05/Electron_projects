import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyJobDefaults,
  deleteJob,
  loadJobs,
  saveJobs,
  upsertJob,
  validateJob,
} from "../../src/main/jobs/store";
import type { Job } from "../../src/shared/types";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "filesync-jobs-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function jobAt(name: string, sideA: string, sideB: string, overrides: Partial<Job> = {}): Job {
  return applyJobDefaults({ name, sideA, sideB, ...overrides });
}

describe("jobs/store — defaults and validation", () => {
  it("applyJobDefaults assigns id, defaults, and trims name", () => {
    const j = applyJobDefaults({ name: "  hello  ", sideA: "C:\\a", sideB: "C:\\b" });
    expect(j.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(j.name).toBe("hello");
    expect(j.onConflict).toBe("newer-wins");
    expect(j.trash.enabled).toBe(true);
    expect(j.trash.retainDays).toBe(30);
    expect(j.preserveTimestamps).toBe(true);
  });

  it("flags missing required fields", () => {
    const j = applyJobDefaults({});
    const errs = validateJob(j, { skipExistenceCheck: true });
    expect(errs).toContain("Name is required.");
    expect(errs).toContain("Side A folder is required.");
    expect(errs).toContain("Side B folder is required.");
  });

  it("rejects non-absolute side paths", () => {
    const j = jobAt("ok", "relative/a", "relative/b");
    const errs = validateJob(j, { skipExistenceCheck: true });
    expect(errs.some((e) => e.includes("Side A must be an absolute path"))).toBe(true);
    expect(errs.some((e) => e.includes("Side B must be an absolute path"))).toBe(true);
  });

  it("rejects identical Side A and Side B", () => {
    const a = freshDir();
    const j = jobAt("ok", a, a);
    const errs = validateJob(j);
    expect(errs.some((e) => e.includes("must be different"))).toBe(true);
  });

  it("rejects nested Side A inside Side B", () => {
    const root = freshDir();
    const inner = join(root, "nested");
    require("node:fs").mkdirSync(inner, { recursive: true });
    const j = jobAt("ok", root, inner);
    const errs = validateJob(j);
    expect(errs.some((e) => e.includes("nested"))).toBe(true);
  });

  it("rejects nonexistent paths unless skipExistenceCheck is set", () => {
    const j = jobAt("ok", "C:\\definitely-not-here-xyz123", "C:\\also-not-here-xyz456");
    const errs = validateJob(j);
    expect(errs.some((e) => e.includes("does not exist"))).toBe(true);

    const errsSkipped = validateJob(j, { skipExistenceCheck: true });
    expect(errsSkipped.every((e) => !e.includes("does not exist"))).toBe(true);
  });

  it("rejects nonsense conflict policy and out-of-range trash retention", () => {
    const a = freshDir();
    const b = freshDir();
    const j = jobAt("ok", a, b, {
      onConflict: "weird" as never,
      trash: { enabled: true, retainDays: -1 },
    });
    const errs = validateJob(j);
    expect(errs.some((e) => e.includes("conflict policy"))).toBe(true);
    expect(errs.some((e) => e.includes("retention"))).toBe(true);
  });
});

describe("jobs/store — CRUD", () => {
  it("loadJobs returns [] when file missing", async () => {
    const d = freshDir();
    expect(await loadJobs(join(d, "jobs.json"))).toEqual([]);
  });

  it("loadJobs returns [] when file empty", async () => {
    const d = freshDir();
    const p = join(d, "jobs.json");
    writeFileSync(p, "");
    expect(await loadJobs(p)).toEqual([]);
  });

  it("saveJobs writes atomically and loadJobs reads back", async () => {
    const d = freshDir();
    const a = freshDir();
    const b = freshDir();
    const p = join(d, "jobs.json");
    const j = jobAt("Photos backup", a, b);
    await saveJobs(p, [j]);
    const loaded = await loadJobs(p);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe(j.id);
    expect(loaded[0].name).toBe("Photos backup");
  });

  it("upsertJob creates then updates a job by id", async () => {
    const d = freshDir();
    const a = freshDir();
    const b = freshDir();
    const p = join(d, "jobs.json");

    const created = await upsertJob(p, { name: "v1", sideA: a, sideB: b });
    expect((await loadJobs(p))).toHaveLength(1);

    const updated = await upsertJob(p, { ...created, name: "v2" });
    const list = await loadJobs(p);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(created.id);
    expect(list[0].name).toBe("v2");
    expect(updated.name).toBe("v2");
  });

  it("upsertJob throws on validation failure (Side A inside Side B)", async () => {
    const d = freshDir();
    const root = freshDir();
    const nested = join(root, "child");
    require("node:fs").mkdirSync(nested, { recursive: true });
    const p = join(d, "jobs.json");

    await expect(
      upsertJob(p, { name: "bad", sideA: nested, sideB: root }),
    ).rejects.toThrow(/nested/);
  });

  it("deleteJob is a no-op when id missing, otherwise removes", async () => {
    const d = freshDir();
    const a = freshDir();
    const b = freshDir();
    const p = join(d, "jobs.json");

    const j = await upsertJob(p, { name: "x", sideA: a, sideB: b });
    await deleteJob(p, "no-such-id");
    expect(await loadJobs(p)).toHaveLength(1);

    await deleteJob(p, j.id);
    expect(await loadJobs(p)).toEqual([]);
  });

  it("loadJobs survives a file with missing optional fields (apply defaults)", async () => {
    const d = freshDir();
    const a = freshDir();
    const b = freshDir();
    const p = join(d, "jobs.json");
    writeFileSync(
      p,
      JSON.stringify({
        version: 1,
        jobs: [{ id: "abc", name: "old", sideA: a, sideB: b }],
      }),
    );
    const list = await loadJobs(p);
    expect(list[0].onConflict).toBe("newer-wins");
    expect(list[0].trash).toEqual({ enabled: true, retainDays: 30 });
  });
});
