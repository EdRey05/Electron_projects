import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dryRun } from "../../src/main/engine/runner";
import { apply } from "../../src/main/engine/applier";
import { TRASH_DIR_NAME } from "../../src/main/engine/trash";
import {
  listRunActions,
  listRunLogs,
  openStateDb,
} from "../../src/main/engine/state-db";
import { buildTree } from "../fixtures/tree-builder";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function track<T extends { cleanup(): void }>(t: T): T {
  cleanups.push(() => t.cleanup());
  return t;
}

function freshJobDir(): string {
  const d = mkdtempSync(join(tmpdir(), "filesync-applier-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

const TRASH_DEFAULT = { enabled: true, retainDays: 30 };

/**
 * Seed the state DB with rows that reflect the current on-disk size + mtime
 * of the given paths on each side — i.e., simulate "we already synced these".
 * Without this, mtime=0 in seeded state would make the differ flag the side
 * as "changed since last sync" and emit a conflict instead of a delete.
 */
async function seedStateFromCurrent(
  dbPath: string,
  sideA: string,
  sideB: string,
  paths: string[],
) {
  const db = await openStateDb(dbPath);
  const { upsertSideA, upsertSideB } = await import(
    "../../src/main/engine/state-db"
  );
  for (const p of paths) {
    const aFull = join(sideA, p);
    const bFull = join(sideB, p);
    if (existsSync(aFull)) {
      const s = statSync(aFull);
      upsertSideA(db, p, s.size, s.mtimeMs);
    }
    if (existsSync(bFull)) {
      const s = statSync(bFull);
      upsertSideB(db, p, s.size, s.mtimeMs);
    }
    // If a path is absent on one side but we want the differ to treat it as
    // "previously synced", borrow the other side's stats as the seed.
    if (!existsSync(aFull) && existsSync(bFull)) {
      const s = statSync(bFull);
      upsertSideA(db, p, s.size, s.mtimeMs);
    }
    if (!existsSync(bFull) && existsSync(aFull)) {
      const s = statSync(aFull);
      upsertSideB(db, p, s.size, s.mtimeMs);
    }
  }
  db.flush();
  db.close();
}

async function runDryThenApply(opts: {
  jobId: string;
  sideA: string;
  sideB: string;
  stateDbPath: string;
}) {
  const dr = await dryRun(opts);
  const ar = await apply({
    ...opts,
    plan: dr.plan,
    trash: TRASH_DEFAULT,
    preserveTimestamps: true,
  });
  return { dr, ar };
}

describe("applier — basic copy semantics", () => {
  it("first sync: copies all A-only files into B and updates state DB", async () => {
    const a = track(buildTree({ "a.txt": "AA", "sub/b.txt": "BBB" }));
    const b = track(buildTree({}));
    const jobDir = freshJobDir();
    const dbPath = join(jobDir, "job.sqlite");

    const { ar } = await runDryThenApply({
      jobId: "job1",
      sideA: a.root,
      sideB: b.root,
      stateDbPath: dbPath,
    });

    expect(ar.status).toBe("ok");
    expect(ar.filesCopied).toBe(2);
    expect(ar.errors).toEqual([]);
    expect(readFileSync(join(b.root, "a.txt"), "utf8")).toBe("AA");
    expect(readFileSync(join(b.root, "sub/b.txt"), "utf8")).toBe("BBB");

    // Verify state DB recorded both sides for both paths.
    const db = await openStateDb(dbPath);
    const logs = listRunLogs(db);
    expect(logs.length).toBe(1);
    expect(logs[0].status).toBe("ok");
    expect(logs[0].files_copied).toBe(2);
    db.close();
  });

  it("propagates a delete: file deleted on A is trashed on B", async () => {
    const a = track(buildTree({ "keep.txt": "k" }));
    const b = track(buildTree({ "keep.txt": "k", "gone.txt": "bye" }));
    const jobDir = freshJobDir();
    const dbPath = join(jobDir, "job.sqlite");

    // Seed state so the differ sees gone.txt as deleted on A.
    await seedStateFromCurrent(dbPath, a.root, b.root, ["keep.txt", "gone.txt"]);

    const { ar } = await runDryThenApply({
      jobId: "job1",
      sideA: a.root,
      sideB: b.root,
      stateDbPath: dbPath,
    });

    expect(ar.status).toBe("ok");
    expect(ar.filesDeleted).toBe(1);
    expect(existsSync(join(b.root, "gone.txt"))).toBe(false);

    // The deleted file should be in trash, not gone forever.
    const trashRoot = join(b.root, TRASH_DIR_NAME, "job1");
    expect(existsSync(trashRoot)).toBe(true);
  });

  it("trashes existing destination before overwrite (no silent data loss)", async () => {
    const a = track(buildTree({ "doc.txt": "AAAAA-newer" }));
    const b = track(buildTree({ "doc.txt": "old-B-version" }));
    const jobDir = freshJobDir();
    const dbPath = join(jobDir, "job.sqlite");

    // Force A to have a newer mtime than B so newer-wins picks A.
    const { utimesSync } = await import("node:fs");
    const aNewer = Math.floor(Date.now() / 1000) + 60;
    utimesSync(join(a.root, "doc.txt"), aNewer, aNewer);

    // Seed an "old" baseline so the differ sees both sides as changed.
    // Using mtime=0 and size=99 (different from both files' real sizes) means
    // both sideA and sideB classify as "changed since last sync" -> conflict.
    {
      const db = await openStateDb(dbPath);
      const { upsertSideA, upsertSideB } = await import(
        "../../src/main/engine/state-db"
      );
      upsertSideA(db, "doc.txt", 99, 0);
      upsertSideB(db, "doc.txt", 99, 0);
      db.flush();
      db.close();
    }

    const { ar } = await runDryThenApply({
      jobId: "job1",
      sideA: a.root,
      sideB: b.root,
      stateDbPath: dbPath,
    });

    expect(ar.status).toBe("ok");
    expect(readFileSync(join(b.root, "doc.txt"), "utf8")).toBe("AAAAA-newer");
    // Old B version should be retrievable from trash.
    const trashJob = join(b.root, TRASH_DIR_NAME, "job1");
    expect(existsSync(trashJob)).toBe(true);
    const stamps = readdirSync(trashJob);
    expect(stamps.length).toBe(1);
    const trashed = join(trashJob, stamps[0], "doc.txt");
    expect(readFileSync(trashed, "utf8")).toBe("old-B-version");
  });
});

describe("applier — idempotency (the critical invariant)", () => {
  it("second run after a successful apply is fully a noop", async () => {
    const a = track(buildTree({ "a.txt": "x", "sub/b.txt": "yy" }));
    const b = track(buildTree({}));
    const jobDir = freshJobDir();
    const dbPath = join(jobDir, "job.sqlite");

    await runDryThenApply({
      jobId: "job1",
      sideA: a.root,
      sideB: b.root,
      stateDbPath: dbPath,
    });

    // Re-run without changing either side.
    const second = await dryRun({
      jobId: "job1",
      sideA: a.root,
      sideB: b.root,
      stateDbPath: dbPath,
    });
    expect(second.plan.summary.copyAToB).toBe(0);
    expect(second.plan.summary.copyBToA).toBe(0);
    expect(second.plan.summary.deleteA).toBe(0);
    expect(second.plan.summary.deleteB).toBe(0);
    expect(second.plan.summary.conflicts).toBe(0);
    // Every action recorded should be a noop (the differ records noop entries
    // for in-sync files).
    expect(second.plan.actions.every((x) => x.kind === "noop")).toBe(true);
  });

  it("after a delete propagation, both sides are empty and re-run is fully noop", async () => {
    const a = track(buildTree({ "x.txt": "1" }));
    const b = track(buildTree({ "x.txt": "1" }));
    const jobDir = freshJobDir();
    const dbPath = join(jobDir, "job.sqlite");

    // Seed initial state from current files (both sides in sync).
    await seedStateFromCurrent(dbPath, a.root, b.root, ["x.txt"]);

    // Delete from A.
    rmSync(join(a.root, "x.txt"));

    await runDryThenApply({
      jobId: "job1",
      sideA: a.root,
      sideB: b.root,
      stateDbPath: dbPath,
    });

    // Now both sides should be empty (B's x.txt was trashed).
    expect(existsSync(join(a.root, "x.txt"))).toBe(false);
    expect(existsSync(join(b.root, "x.txt"))).toBe(false);

    // Re-run: nothing to do.
    const second = await dryRun({
      jobId: "job1",
      sideA: a.root,
      sideB: b.root,
      stateDbPath: dbPath,
    });
    expect(second.plan.summary.copyAToB).toBe(0);
    expect(second.plan.summary.deleteA).toBe(0);
    expect(second.plan.summary.deleteB).toBe(0);
  });
});

describe("applier — robustness", () => {
  it("removes stale .tmp.<pid>.<rand> artifacts at the start of a run", async () => {
    const a = track(buildTree({ "a.txt": "x" }));
    const b = track(buildTree({}));
    const jobDir = freshJobDir();
    const dbPath = join(jobDir, "job.sqlite");

    // Drop a stale temp on side B (as if a previous run was killed mid-copy).
    const stale = join(b.root, "stale.txt.tmp.99999.deadbeef");
    writeFileSync(stale, "should be cleaned");
    expect(existsSync(stale)).toBe(true);

    await runDryThenApply({
      jobId: "job1",
      sideA: a.root,
      sideB: b.root,
      stateDbPath: dbPath,
    });

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(b.root, "a.txt"))).toBe(true);
  });

  it("emits progress for each action via onProgress callback", async () => {
    const a = track(buildTree({ "a.txt": "1", "b.txt": "22", "c.txt": "333" }));
    const b = track(buildTree({}));
    const jobDir = freshJobDir();
    const dbPath = join(jobDir, "job.sqlite");

    const events: number[] = [];
    const dr = await dryRun({
      jobId: "job1",
      sideA: a.root,
      sideB: b.root,
      stateDbPath: dbPath,
    });
    await apply({
      jobId: "job1",
      sideA: a.root,
      sideB: b.root,
      stateDbPath: dbPath,
      plan: dr.plan,
      trash: TRASH_DEFAULT,
      onProgress: (p) => events.push(p.doneActions),
    });

    // Initial emit is 0; then 1, 2, 3.
    expect(events[0]).toBe(0);
    expect(events[events.length - 1]).toBe(3);
  });

  it("records each action in run_action", async () => {
    const a = track(buildTree({ "a.txt": "x", "b.txt": "y" }));
    const b = track(buildTree({}));
    const jobDir = freshJobDir();
    const dbPath = join(jobDir, "job.sqlite");

    const { ar } = await runDryThenApply({
      jobId: "job1",
      sideA: a.root,
      sideB: b.root,
      stateDbPath: dbPath,
    });

    const db = await openStateDb(dbPath);
    const actions = listRunActions(db, ar.runId);
    expect(actions.length).toBe(2);
    expect(actions.every((x) => x.action === "copy-a-to-b")).toBe(true);
    expect(actions.every((x) => x.ok === 1)).toBe(true);
    db.close();
  });

  it("when trash is disabled, deletes are unlinked outright", async () => {
    const a = track(buildTree({}));
    const b = track(buildTree({ "x.txt": "x" }));
    const jobDir = freshJobDir();
    const dbPath = join(jobDir, "job.sqlite");

    await seedStateFromCurrent(dbPath, a.root, b.root, ["x.txt"]);

    const dr = await dryRun({
      jobId: "job1",
      sideA: a.root,
      sideB: b.root,
      stateDbPath: dbPath,
    });
    await apply({
      jobId: "job1",
      sideA: a.root,
      sideB: b.root,
      stateDbPath: dbPath,
      plan: dr.plan,
      trash: { enabled: false, retainDays: 30 },
    });

    expect(existsSync(join(b.root, "x.txt"))).toBe(false);
    // No trash directory should be created when disabled.
    expect(existsSync(join(b.root, TRASH_DIR_NAME))).toBe(false);
  });
});
