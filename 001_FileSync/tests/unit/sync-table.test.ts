import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dryRun } from "../../src/main/engine/runner";
import { apply } from "../../src/main/engine/applier";
import { buildTree } from "../fixtures/tree-builder";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function makeJobDir(): string {
  const d = mkdtempSync(join(tmpdir(), "filesync-ovr-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function trackedTree(spec: Parameters<typeof buildTree>[0]) {
  const t = buildTree(spec);
  cleanups.push(() => t.cleanup());
  return t;
}

const TRASH = { enabled: true, retainDays: 30 };

describe("sync table overrides — end to end", () => {
  it("the dry-run returns a full inventory of files and folders", async () => {
    const a = trackedTree({ "photos/a.jpg": "A", "photos/b.jpg": "BB", "notes.txt": "n" });
    const b = trackedTree({ "photos/a.jpg": "A" });
    const jobDir = makeJobDir();

    const r = await dryRun({
      jobId: "job1",
      sideA: a.root,
      sideB: b.root,
      stateDbPath: join(jobDir, "job1.sqlite"),
      direction: "a-to-b",
    });

    const paths = r.inventory.map((i) => i.path).sort();
    expect(paths).toEqual(["notes.txt", "photos", "photos/a.jpg", "photos/b.jpg"]);

    // Every inventory row carries the per-side existence flags.
    const bRow = r.inventory.find((i) => i.path === "photos/b.jpg")!;
    expect(bRow.aExists).toBe(true);
    expect(bRow.bExists).toBe(false);
  });

  it("a folder-level 'skip' override stops the whole subtree from running", async () => {
    const a = trackedTree({ "photos/a.jpg": "A", "photos/b.jpg": "BB", "keep.txt": "k" });
    const b = trackedTree({});
    const jobDir = makeJobDir();
    const dbPath = join(jobDir, "job1.sqlite");

    const r = await dryRun({
      jobId: "job1",
      sideA: a.root,
      sideB: b.root,
      stateDbPath: dbPath,
      direction: "a-to-b",
    });
    expect(r.plan.summary.copyAToB).toBe(3);

    // Re-run with the override the table would have produced.
    const r2 = await dryRun({
      jobId: "job1",
      sideA: a.root,
      sideB: b.root,
      stateDbPath: dbPath,
      direction: "a-to-b",
      overrides: { photos: "skip" },
    });
    expect(r2.plan.summary.copyAToB).toBe(1);
    expect(r2.plan.actions.map((x) => x.path)).toEqual(["keep.txt"]);

    const result = await apply({
      jobId: "job1",
      sideA: a.root,
      sideB: b.root,
      stateDbPath: dbPath,
      plan: r2.plan,
      trash: TRASH,
    });
    expect(result.status).toBe("ok");
    expect(existsSync(join(b.root, "keep.txt"))).toBe(true);
    expect(existsSync(join(b.root, "photos", "a.jpg"))).toBe(false);
  });

  it("a per-file override forces the opposite direction", async () => {
    const a = trackedTree({ "x.txt": "from-A" });
    const b = trackedTree({ "x.txt": "from-B", "y.txt": "only-B" });
    const jobDir = makeJobDir();
    const dbPath = join(jobDir, "job1.sqlite");

    const r = await dryRun({
      jobId: "job1",
      sideA: a.root,
      sideB: b.root,
      stateDbPath: dbPath,
      direction: "a-to-b",
      overrides: { "x.txt": "copy-b-to-a" },
    });

    const x = r.plan.actions.find((x) => x.path === "x.txt")!;
    expect(x.kind).toBe("copy-b-to-a");

    const result = await apply({
      jobId: "job1",
      sideA: a.root,
      sideB: b.root,
      stateDbPath: dbPath,
      plan: r.plan,
      trash: TRASH,
    });
    expect(result.status).toBe("ok");
    // B won for x.txt despite the A→B direction.
    expect(readFileSync(join(a.root, "x.txt"), "utf8")).toBe("from-B");
    // y.txt was still deleted from B (mirror semantics for the rest).
    expect(existsSync(join(b.root, "y.txt"))).toBe(false);
  });

  it("'keep both' preserves both versions side by side", async () => {
    const a = trackedTree({ "doc.txt": "AAAA" });
    const b = trackedTree({ "doc.txt": "BBBB" });
    const jobDir = makeJobDir();
    const dbPath = join(jobDir, "job1.sqlite");

    const r = await dryRun({
      jobId: "job1",
      sideA: a.root,
      sideB: b.root,
      stateDbPath: dbPath,
      direction: "a-to-b",
      overrides: { "doc.txt": "keep-both" },
    });
    expect(r.plan.actions.find((x) => x.path === "doc.txt")!.kind).toBe("keep-both");

    const result = await apply({
      jobId: "job1",
      sideA: a.root,
      sideB: b.root,
      stateDbPath: dbPath,
      plan: r.plan,
      trash: TRASH,
    });
    expect(result.status).toBe("ok");

    // The original name holds A's content on both sides.
    expect(readFileSync(join(a.root, "doc.txt"), "utf8")).toBe("AAAA");
    expect(readFileSync(join(b.root, "doc.txt"), "utf8")).toBe("AAAA");

    // And the timestamped siblings preserve the other versions.
    const aFiles = readdirSync(a.root).sort();
    const bFiles = readdirSync(b.root).sort();
    expect(aFiles.some((f) => f.startsWith("doc.A"))).toBe(true);
    expect(bFiles.some((f) => f.startsWith("doc.B"))).toBe(true);
  });

  it("'delete on A' removes the file from side A and keeps side B", async () => {
    const a = trackedTree({ "gone.txt": "x" });
    const b = trackedTree({ "gone.txt": "x" });
    const jobDir = makeJobDir();
    const dbPath = join(jobDir, "job1.sqlite");

    const r = await dryRun({
      jobId: "job1",
      sideA: a.root,
      sideB: b.root,
      stateDbPath: dbPath,
      direction: "a-to-b",
      overrides: { "gone.txt": "delete-a" },
    });
    expect(r.plan.actions.find((x) => x.path === "gone.txt")!.kind).toBe("delete-a");

    const result = await apply({
      jobId: "job1",
      sideA: a.root,
      sideB: b.root,
      stateDbPath: dbPath,
      plan: r.plan,
      trash: TRASH,
    });
    expect(result.status).toBe("ok");
    expect(existsSync(join(a.root, "gone.txt"))).toBe(false);
    expect(existsSync(join(b.root, "gone.txt"))).toBe(true);
  });
});

describe("mirror mode — deleteExtraneous", () => {
  it("keeps destination-only files when delete is off", async () => {
    const a = trackedTree({ "only-a.txt": "a" });
    const b = trackedTree({ "only-b.txt": "b" });
    const jobDir = makeJobDir();

    const r = await dryRun({
      jobId: "job1",
      sideA: a.root,
      sideB: b.root,
      stateDbPath: join(jobDir, "job1.sqlite"),
      direction: "a-to-b",
      deleteExtraneous: false,
    });
    expect(r.plan.summary.deleteB).toBe(0);
    expect(r.plan.summary.copyAToB).toBe(1);
  });

  it("deletes destination-only files when delete is on (the default)", async () => {
    const a = trackedTree({ "only-a.txt": "a" });
    const b = trackedTree({ "only-b.txt": "b" });
    const jobDir = makeJobDir();

    const r = await dryRun({
      jobId: "job1",
      sideA: a.root,
      sideB: b.root,
      stateDbPath: join(jobDir, "job1.sqlite"),
      direction: "a-to-b",
      deleteExtraneous: true,
    });
    expect(r.plan.summary.deleteB).toBe(1);
  });
});
