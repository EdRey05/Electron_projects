import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as walker from "../../src/main/engine/walker";
import { dryRun } from "../../src/main/engine/runner";
import { AnalyzeProgress, elapsedClock } from "../../src/renderer/components/AnalyzeProgress";
import { formatBytes } from "../../src/renderer/lib/format";
import { buildTree } from "../fixtures/tree-builder";
import type { AnalysisProgress, WalkProgress } from "../../src/shared/types";

vi.mock("../../src/main/engine/walker", async original => {
  const real = await original<typeof walker>();
  return { ...real, walk: vi.fn(real.walk) };
});
const real = await vi.importActual<typeof walker>("../../src/main/engine/walker");
const trees: ReturnType<typeof buildTree>[] = [];
function tree(spec: Parameters<typeof buildTree>[0]) {
  const t = buildTree(spec); trees.push(t); return t.root;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(walker.walk).mockReset().mockImplementation(real.walk);
  while (trees.length) trees.pop()!.cleanup();
});

describe("streamed analysis progress", () => {
  it("reports real intermediate counts before completing the tree, and honors filters", async () => {
    const root = tree({ "a.txt": "AA", "sub/b.txt": "BBB", "skip.tmp": "ignored" });
    let clock = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock += 300);
    const updates: WalkProgress[] = [];
    let finished = false;
    const result = await real.walk({ root,
      filters: { include: [], exclude: ["*.tmp"] },
      onProgress: p => { expect(finished).toBe(false); updates.push(p); },
    });
    finished = true;
    expect(updates.some(p => !p.complete && p.fileCount > 0)).toBe(true);
    expect(updates[0].fileCount).toBe(0);
    expect(updates.at(-1)).toMatchObject({ complete: true, fileCount: 2, dirCount: 1, totalBytes: 5 });
    expect(updates.at(-1)?.currentPath).not.toContain("skip.tmp");
    expect(result.fileCount).toBe(2);
  });

  it("completes an empty folder with a final zero count", async () => {
    const updates: WalkProgress[] = [];
    await real.walk({ root: tree({}), onProgress: p => updates.push(p) });
    expect(updates.at(-1)).toMatchObject({ complete: true, fileCount: 0, dirCount: 0 });
  });

  it("honors an aborted scan rather than starting a background walk", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(real.walk({ root: tree({}), signal: controller.signal })).rejects.toThrow("Analysis stopped");
  });

  it("closes an active stream when its analysis is aborted", async () => {
    const controller = new AbortController();
    let clock = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock += 300);
    await expect(real.walk({ root: tree({ "a.txt": "A", "b.txt": "B" }), signal: controller.signal,
      onProgress: p => { if (p.fileCount && !p.complete) controller.abort(); },
    })).rejects.toThrow("Analysis stopped");
  });

  it("reports both folders, comparison/table phases and matching final totals", async () => {
    const a = tree({ "a.txt": "AA" });
    const b = tree({ "b.txt": "BBB" });
    const updates: AnalysisProgress[] = [];
    const result = await dryRun({ jobId: "progress-test", sideA: a, sideB: b,
      stateDbPath: join(tree({}), "state.sqlite"), onProgress: p => updates.push(p) });
    expect(updates.map(p => p.stage)).toEqual(expect.arrayContaining(["scanning", "loading-state", "comparing", "inventory", "complete"]));
    const final = updates.at(-1)!;
    expect(final.a).toMatchObject({ fileCount: result.walkA.fileCount, totalBytes: 2, complete: true });
    expect(final.b).toMatchObject({ fileCount: result.walkB.fileCount, totalBytes: 3, complete: true });
    expect(updates[0].a.fileCount).toBe(0); // immutable earlier snapshot
    expect(final.jobId).toBe("progress-test");
  });

  it("sends a heartbeat while a drive is waiting without inventing extra files", async () => {
    vi.mocked(walker.walk).mockImplementation(async opts => {
      await new Promise(resolve => setTimeout(resolve, 1100));
      return real.walk(opts);
    });
    const a = tree({}); const b = tree({});
    const updates: AnalysisProgress[] = [];
    const clear = vi.spyOn(global, "clearInterval");
    await dryRun({ jobId: "slow", sideA: a, sideB: b, stateDbPath: join(a, "state.sqlite"),
      direction: "a-to-b", onProgress: p => updates.push(p) });
    expect(updates.some(p => p.stage === "scanning" && !p.a.complete && !p.b.complete && p.updatedAt - p.startedAt >= 900)).toBe(true);
    expect(updates.every(p => p.a.fileCount === 0 && p.b.fileCount === 0)).toBe(true);
    expect(clear).toHaveBeenCalled();
  });

  it("stops the sibling walk and clears heartbeat if one drive fails", async () => {
    const a = tree({}); const b = tree({});
    let aborted = false;
    vi.mocked(walker.walk).mockImplementation(async opts => {
      if (opts.root === a) throw new Error("drive disconnected");
      return new Promise((_resolve, reject) => opts.signal!.addEventListener("abort", () => {
        aborted = true; reject(new Error("sibling stopped"));
      }, { once: true }));
    });
    const clear = vi.spyOn(global, "clearInterval");
    const updates: AnalysisProgress[] = [];
    await expect(dryRun({ jobId: "failed", sideA: a, sideB: b,
      stateDbPath: join(a, "state.sqlite"), onProgress: p => updates.push(p) })).rejects.toThrow("drive disconnected");
    expect(aborted).toBe(true);
    expect(updates.at(-1)?.stage).toBe("failed");
    expect(clear).toHaveBeenCalled();
  });
});

describe("large-drive progress presentation", () => {
  it("formats terabytes and hours without millisecond-scale output", () => {
    expect(formatBytes(4 * 1024 ** 4)).toBe("4.00 TB");
    expect(elapsedClock(3_723_000)).toBe("1h 2m 3s");
  });

  it("shows million-file counts without claiming a percentage or ETA", () => {
    const now = Date.now();
    const side = { fileCount: 1_234_567, dirCount: 24_000, totalBytes: 3 * 1024 ** 4,
      currentPath: "backup/data.bin", lastEntryAt: now, complete: false };
    const html = renderToStaticMarkup(createElement(AnalyzeProgress, { startedAt: now - 300_000,
      progress: { jobId: "big", stage: "scanning", startedAt: now - 300_000, updatedAt: now, a: side, b: { ...side, complete: true } } }));
    expect(html).toContain((1_234_567).toLocaleString());
    expect(html).toContain("3.00 TB");
    expect(html).toContain('role="progressbar"');
    expect(html).not.toContain('aria-valuenow');
    expect(html).toContain("no ETA");
    expect(html).toContain("Scan complete");
    expect(html).toContain("backup/data.bin");
  });

  it("does not label a stale engine update as responsive", () => {
    const now = Date.now();
    const side = { fileCount: 10, dirCount: 2, totalBytes: 20, currentPath: "waiting", lastEntryAt: now - 30_000, complete: false };
    const html = renderToStaticMarkup(createElement(AnalyzeProgress, { startedAt: now - 60_000,
      progress: { jobId: "waiting", stage: "scanning", startedAt: now - 60_000, updatedAt: now - 30_000, a: side, b: side } }));
    expect(html).toContain("No update:");
    expect(html).not.toContain("Engine responding");
    expect(html).toContain("No new entry:");
  });
});
