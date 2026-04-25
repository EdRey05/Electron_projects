import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openStateDb,
  upsertSideA,
  upsertSideB,
  getState,
  listStatePaths,
  countState,
} from "../../src/main/engine/state-db";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop()!;
    rmSync(d, { recursive: true, force: true });
  }
});

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "filesync-db-"));
  dirs.push(dir);
  return openStateDb(join(dir, "state.sqlite"));
}

describe("state-db", () => {
  it("creates schema and reports zero rows initially", async () => {
    const db = await freshDb();
    expect(countState(db)).toBe(0);
    expect(listStatePaths(db)).toEqual([]);
    db.close();
  });

  it("upserts side A then reads it back", async () => {
    const db = await freshDb();
    upsertSideA(db, "foo/bar.txt", 42, 1700000000000);
    const row = getState(db, "foo/bar.txt");
    expect(row).toBeDefined();
    expect(row!.side_a_size).toBe(42);
    expect(row!.side_a_mtime).toBe(1700000000000);
    expect(row!.side_b_size == null).toBe(true);
    db.close();
  });

  it("upserts side B without disturbing side A", async () => {
    const db = await freshDb();
    upsertSideA(db, "x.txt", 10, 1000);
    upsertSideB(db, "x.txt", 20, 2000);
    const row = getState(db, "x.txt")!;
    expect(row.side_a_size).toBe(10);
    expect(row.side_a_mtime).toBe(1000);
    expect(row.side_b_size).toBe(20);
    expect(row.side_b_mtime).toBe(2000);
    db.close();
  });

  it("re-upsert updates existing row, does not insert duplicate", async () => {
    const db = await freshDb();
    upsertSideA(db, "p.txt", 1, 100);
    upsertSideA(db, "p.txt", 2, 200);
    expect(countState(db)).toBe(1);
    const row = getState(db, "p.txt")!;
    expect(row.side_a_size).toBe(2);
    expect(row.side_a_mtime).toBe(200);
    db.close();
  });

  it("persists across reopens (flush + reload)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filesync-db-"));
    dirs.push(dir);
    const path = join(dir, "state.sqlite");

    const db1 = await openStateDb(path);
    upsertSideA(db1, "a.txt", 1, 100);
    db1.flush();
    db1.close();

    const db2 = await openStateDb(path);
    expect(countState(db2)).toBe(1);
    expect(getState(db2, "a.txt")!.side_a_size).toBe(1);
    db2.close();
  });

  it("listStatePaths returns sorted paths", async () => {
    const db = await freshDb();
    upsertSideA(db, "z.txt", 1, 0);
    upsertSideA(db, "a.txt", 1, 0);
    upsertSideA(db, "m.txt", 1, 0);
    expect(listStatePaths(db)).toEqual(["a.txt", "m.txt", "z.txt"]);
    db.close();
  });
});
