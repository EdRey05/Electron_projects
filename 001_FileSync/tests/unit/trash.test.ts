import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  mkdirSync,
  utimesSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  moveToTrash,
  sweepTrash,
  cleanupStaleTemps,
  trashStamp,
  TRASH_DIR_NAME,
} from "../../src/main/engine/trash";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "filesync-trash-"));
  dirs.push(d);
  return d;
}

describe("trashStamp", () => {
  it("yields a path-safe ISO-like string", () => {
    const s = trashStamp(new Date(Date.UTC(2026, 3, 26, 14, 30, 12, 345)));
    expect(s).toBe("2026-04-26T14-30-12-345Z");
    expect(s).not.toMatch(/[:.]/);
  });
});

describe("moveToTrash", () => {
  it("moves the file into <sideRoot>/.filesync-trash/<jobId>/<runStamp>/<rel>", async () => {
    const root = freshDir();
    const file = join(root, "subdir", "x.txt");
    mkdirSync(join(root, "subdir"));
    writeFileSync(file, "payload");

    const stamp = "2026-04-26T00-00-00-000Z";
    const result = await moveToTrash({
      filePath: file,
      sideRoot: root,
      jobId: "job1",
      runTimestamp: stamp,
      relPath: "subdir/x.txt",
    });

    expect(existsSync(file)).toBe(false);
    const trashed = join(root, TRASH_DIR_NAME, "job1", stamp, "subdir", "x.txt");
    expect(existsSync(trashed)).toBe(true);
    expect(readFileSync(trashed, "utf8")).toBe("payload");
    expect(result.trashedTo).toBe(trashed);
    expect(result.bytes).toBe(7);
  });

  it("creates the trash subtree if missing", async () => {
    const root = freshDir();
    const file = join(root, "x.txt");
    writeFileSync(file, "y");

    await moveToTrash({
      filePath: file,
      sideRoot: root,
      jobId: "j",
      runTimestamp: "stamp",
      relPath: "x.txt",
    });
    expect(existsSync(join(root, TRASH_DIR_NAME, "j", "stamp", "x.txt"))).toBe(true);
  });
});

describe("sweepTrash", () => {
  it("returns 0/0 when no trash directory exists", async () => {
    const root = freshDir();
    const r = await sweepTrash({ sideRoot: root, retainDays: 30 });
    expect(r).toEqual({ removedDirs: 0, freedBytes: 0 });
  });

  it("removes dated subfolders older than retainDays and tallies freed bytes", async () => {
    const root = freshDir();
    const trash = join(root, TRASH_DIR_NAME, "job1");
    mkdirSync(trash, { recursive: true });

    // "Old" run: backdate mtime to 60 days ago.
    const old = join(trash, "2025-01-01T00-00-00-000Z");
    mkdirSync(old);
    writeFileSync(join(old, "a.txt"), "hello"); // 5 bytes
    const oldSec = Math.floor((Date.now() - 60 * 86400 * 1000) / 1000);
    utimesSync(old, oldSec, oldSec);

    // "New" run: now-ish.
    const fresh = join(trash, "2026-04-26T12-00-00-000Z");
    mkdirSync(fresh);
    writeFileSync(join(fresh, "b.txt"), "k");

    const result = await sweepTrash({ sideRoot: root, retainDays: 30 });
    expect(result.removedDirs).toBe(1);
    expect(result.freedBytes).toBe(5);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("removes empty jobId folders left behind after sweep", async () => {
    const root = freshDir();
    const trash = join(root, TRASH_DIR_NAME, "job1");
    mkdirSync(trash, { recursive: true });
    const old = join(trash, "old");
    mkdirSync(old);
    writeFileSync(join(old, "a.txt"), "x");
    const oldSec = Math.floor((Date.now() - 90 * 86400 * 1000) / 1000);
    utimesSync(old, oldSec, oldSec);

    await sweepTrash({ sideRoot: root, retainDays: 30 });
    expect(existsSync(trash)).toBe(false);
  });
});

describe("cleanupStaleTemps", () => {
  it("removes leftover .tmp.<pid>.<rand> files but leaves user files alone", async () => {
    const root = freshDir();
    writeFileSync(join(root, "real.txt"), "hello");
    writeFileSync(join(root, "real.tmp.txt"), "no-match"); // does NOT match the strict regex
    writeFileSync(join(root, "victim.txt.tmp.1234.abcdef0"), "stale");
    mkdirSync(join(root, "deep"));
    writeFileSync(join(root, "deep", "deep.txt.tmp.5678.deadbeef"), "stale");

    const r = await cleanupStaleTemps(root);
    expect(r.removed).toBe(2);
    expect(existsSync(join(root, "real.txt"))).toBe(true);
    expect(existsSync(join(root, "real.tmp.txt"))).toBe(true);
    expect(existsSync(join(root, "victim.txt.tmp.1234.abcdef0"))).toBe(false);
    expect(existsSync(join(root, "deep", "deep.txt.tmp.5678.deadbeef"))).toBe(false);
  });

  it("does not recurse into the trash directory", async () => {
    const root = freshDir();
    const trash = join(root, TRASH_DIR_NAME);
    mkdirSync(trash);
    writeFileSync(join(trash, "decoy.tmp.1.aaaa"), "should be left");

    await cleanupStaleTemps(root);
    expect(readdirSync(trash)).toContain("decoy.tmp.1.aaaa");
  });

  it("returns 0 when root does not exist", async () => {
    const r = await cleanupStaleTemps(join(tmpdir(), "filesync-no-such-dir-xyz"));
    expect(r.removed).toBe(0);
  });
});
