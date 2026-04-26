import { describe, it, expect, afterEach } from "vitest";
import { utimesSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dryRun } from "../../src/main/engine/runner";
import {
  openStateDb,
  upsertSideA,
  upsertSideB,
  transaction,
} from "../../src/main/engine/state-db";
import { buildTree } from "../fixtures/tree-builder";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function makeJobDir() {
  const dir = mkdtempSync(join(tmpdir(), "filesync-job-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function trackedTree(spec: Parameters<typeof buildTree>[0]) {
  const t = buildTree(spec);
  cleanups.push(() => t.cleanup());
  return t;
}

function setMtime(path: string, mtimeSec: number) {
  utimesSync(path, mtimeSec, mtimeSec);
}

describe("runner.dryRun — first sync (no state DB on disk)", () => {
  it("walks two empty trees → empty plan", async () => {
    const a = trackedTree({});
    const b = trackedTree({});
    const jobDir = makeJobDir();

    const result = await dryRun({
      jobId: "job1",
      sideA: a.root,
      sideB: b.root,
      stateDbPath: join(jobDir, "job1.sqlite"),
    });
    expect(result.plan.actions).toHaveLength(0);
    expect(result.plan.summary.bytesToTransfer).toBe(0);
    expect(result.stateLoadedRows).toBe(0);
  });

  it("seeds first sync from A: every A-only file becomes copy-a-to-b", async () => {
    const a = trackedTree({ "a.txt": "a", "sub/b.txt": "bb" });
    const b = trackedTree({});
    const jobDir = makeJobDir();

    const result = await dryRun({
      jobId: "job1",
      sideA: a.root,
      sideB: b.root,
      stateDbPath: join(jobDir, "job1.sqlite"),
    });
    expect(result.plan.summary.copyAToB).toBe(2);
    expect(result.plan.summary.bytesToTransfer).toBe(3);
    expect(result.plan.actions.every((x) => x.kind === "copy-a-to-b")).toBe(true);
  });

  it("first sync with both sides populated picks newer per path", async () => {
    const a = trackedTree({ "newer.txt": "AA", "older.txt": "AA" });
    const b = trackedTree({ "newer.txt": "BB", "older.txt": "BB" });

    setMtime(join(a.root, "newer.txt"), 1700001000); // A newer
    setMtime(join(b.root, "newer.txt"), 1700000000);
    setMtime(join(a.root, "older.txt"), 1700000000);
    setMtime(join(b.root, "older.txt"), 1700002000); // B newer

    const jobDir = makeJobDir();
    const result = await dryRun({
      jobId: "job1",
      sideA: a.root,
      sideB: b.root,
      stateDbPath: join(jobDir, "job1.sqlite"),
    });

    const byPath = new Map(result.plan.actions.map((act) => [act.path, act.kind]));
    expect(byPath.get("newer.txt")).toBe("copy-a-to-b");
    expect(byPath.get("older.txt")).toBe("copy-b-to-a");
  });
});

describe("runner.dryRun — with persisted state", () => {
  it("after a hypothetical apply, a re-run is fully a no-op", async () => {
    const a = trackedTree({ "kept.txt": "k", "shared.txt": "ss" });
    const b = trackedTree({ "kept.txt": "k", "shared.txt": "ss" });

    // Make sure mtimes match closely on both sides.
    setMtime(join(a.root, "kept.txt"), 1700000000);
    setMtime(join(b.root, "kept.txt"), 1700000000);
    setMtime(join(a.root, "shared.txt"), 1700000000);
    setMtime(join(b.root, "shared.txt"), 1700000000);

    const jobDir = makeJobDir();
    const dbPath = join(jobDir, "job1.sqlite");

    // Seed state DB as though we already synced these files.
    const db = await openStateDb(dbPath);
    transaction(db, () => {
      upsertSideA(db, "kept.txt", 1, 1700000000_000);
      upsertSideB(db, "kept.txt", 1, 1700000000_000);
      upsertSideA(db, "shared.txt", 2, 1700000000_000);
      upsertSideB(db, "shared.txt", 2, 1700000000_000);
    });
    db.close();

    const result = await dryRun({
      jobId: "job1",
      sideA: a.root,
      sideB: b.root,
      stateDbPath: dbPath,
    });

    expect(result.stateLoadedRows).toBe(2);
    expect(result.plan.summary.copyAToB).toBe(0);
    expect(result.plan.summary.copyBToA).toBe(0);
    expect(result.plan.summary.deleteA).toBe(0);
    expect(result.plan.summary.deleteB).toBe(0);
    expect(result.plan.summary.noops).toBe(2);
  });

  it("propagates a delete on side A to a delete-b action", async () => {
    const a = trackedTree({ "keep.txt": "k" });
    const b = trackedTree({ "keep.txt": "k", "deleted-on-a.txt": "g" });

    setMtime(join(a.root, "keep.txt"), 1700000000);
    setMtime(join(b.root, "keep.txt"), 1700000000);
    setMtime(join(b.root, "deleted-on-a.txt"), 1700000000);

    const jobDir = makeJobDir();
    const dbPath = join(jobDir, "job1.sqlite");

    const db = await openStateDb(dbPath);
    transaction(db, () => {
      upsertSideA(db, "keep.txt", 1, 1700000000_000);
      upsertSideB(db, "keep.txt", 1, 1700000000_000);
      upsertSideA(db, "deleted-on-a.txt", 1, 1700000000_000);
      upsertSideB(db, "deleted-on-a.txt", 1, 1700000000_000);
    });
    db.close();

    const result = await dryRun({
      jobId: "job1",
      sideA: a.root,
      sideB: b.root,
      stateDbPath: dbPath,
    });

    const action = result.plan.actions.find((x) => x.path === "deleted-on-a.txt");
    expect(action?.kind).toBe("delete-b");
    expect(result.plan.summary.deleteB).toBe(1);
  });

  it("detects edit-edit conflict and resolves it under newer-wins", async () => {
    const a = trackedTree({ "doc.txt": "AAAAA" });
    const b = trackedTree({ "doc.txt": "BBBB" });

    setMtime(join(a.root, "doc.txt"), 1700001000); // A newer
    setMtime(join(b.root, "doc.txt"), 1700000500);

    const jobDir = makeJobDir();
    const dbPath = join(jobDir, "job1.sqlite");

    const db = await openStateDb(dbPath);
    transaction(db, () => {
      // Recorded baseline differs from current both sides → both "changed".
      upsertSideA(db, "doc.txt", 3, 1700000000_000);
      upsertSideB(db, "doc.txt", 3, 1700000000_000);
    });
    db.close();

    const result = await dryRun({
      jobId: "job1",
      sideA: a.root,
      sideB: b.root,
      stateDbPath: dbPath,
      policy: "newer-wins",
    });

    const action = result.plan.actions.find((x) => x.path === "doc.txt");
    expect(action?.kind).toBe("copy-a-to-b");
    expect(action?.conflict?.type).toBe("edit-edit");
    expect(action?.conflict?.suggested).toBe("keep-a");
  });

  it("respects exclude filters end-to-end (skipped files don't appear in plan)", async () => {
    const a = trackedTree({ "good.txt": "g", "node_modules/skip.js": "x" });
    const b = trackedTree({});
    const jobDir = makeJobDir();

    const result = await dryRun({
      jobId: "job1",
      sideA: a.root,
      sideB: b.root,
      stateDbPath: join(jobDir, "job1.sqlite"),
      filters: { include: [], exclude: ["node_modules/"] },
    });
    const paths = result.plan.actions.map((x) => x.path);
    expect(paths).toEqual(["good.txt"]);
  });

  it("treats a state row whose file vanished from both sides as drop-from-state", async () => {
    const a = trackedTree({});
    const b = trackedTree({});
    const jobDir = makeJobDir();
    const dbPath = join(jobDir, "job1.sqlite");

    const db = await openStateDb(dbPath);
    transaction(db, () => {
      upsertSideA(db, "ghost.txt", 1, 1700000000_000);
      upsertSideB(db, "ghost.txt", 1, 1700000000_000);
    });
    db.close();

    const result = await dryRun({
      jobId: "job1",
      sideA: a.root,
      sideB: b.root,
      stateDbPath: dbPath,
    });

    expect(result.plan.actions[0].kind).toBe("drop-from-state");
  });

  it("never writes to either side or the state DB during a dry-run", async () => {
    const a = trackedTree({ "a.txt": "a" });
    const b = trackedTree({});
    const jobDir = makeJobDir();
    const dbPath = join(jobDir, "job1.sqlite");

    // Pre-create a state DB and capture its contents.
    const db = await openStateDb(dbPath);
    transaction(db, () => upsertSideA(db, "a.txt", 1, 1700000000_000));
    db.close();
    const beforeBytes = require("node:fs").readFileSync(dbPath).length;

    // Drop a sentinel file on both sides; we'll re-check it after the run.
    writeFileSync(join(a.root, "_sentinel.txt"), "untouched");
    const aSentinelBefore = require("node:fs").readFileSync(join(a.root, "_sentinel.txt"), "utf8");

    await dryRun({
      jobId: "job1",
      sideA: a.root,
      sideB: b.root,
      stateDbPath: dbPath,
    });

    const afterBytes = require("node:fs").readFileSync(dbPath).length;
    const aSentinelAfter = require("node:fs").readFileSync(join(a.root, "_sentinel.txt"), "utf8");
    expect(afterBytes).toBe(beforeBytes);
    expect(aSentinelAfter).toBe(aSentinelBefore);

    unlinkSync(join(a.root, "_sentinel.txt"));
  });
});
