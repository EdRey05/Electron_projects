import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walk } from "../../src/main/engine/walker";
import { toLongPath } from "../../src/main/engine/copier";
import { buildTree } from "../fixtures/tree-builder";

const trees: { cleanup(): void }[] = [];
afterEach(() => {
  while (trees.length) trees.pop()!.cleanup();
});

function setup(spec: Parameters<typeof buildTree>[0]) {
  const t = buildTree(spec);
  trees.push(t);
  return t;
}

describe("walker — per-side ignore lists", () => {
  it("sideExcludes removes matching files from this side only", async () => {
    const { root } = setup({
      "keep.txt": "k",
      "scratch.tmp": "t",
      "sub/scratch.tmp": "t2",
    });

    const r = await walk({ root, sideExcludes: ["*.tmp"] });
    const paths = r.entries.filter((e) => !e.isDirectory).map((e) => e.relPath);
    expect(paths).toEqual(["keep.txt"]);
  });

  it("the shared exclude list still applies alongside the side list", async () => {
    const { root } = setup({
      "keep.txt": "k",
      "node_modules/x.js": "m",
      "scratch.tmp": "t",
    });

    const r = await walk({
      root,
      filters: { include: [], exclude: ["node_modules/"] },
      sideExcludes: ["*.tmp"],
    });
    const paths = r.entries.filter((e) => !e.isDirectory).map((e) => e.relPath);
    expect(paths).toEqual(["keep.txt"]);
  });

  it("a side-excluded directory is not descended into", async () => {
    const { root } = setup({
      "keep.txt": "k",
      "build/out.bin": "b",
    });

    const r = await walk({ root, sideExcludes: ["build/"] });
    const paths = r.entries.filter((e) => !e.isDirectory).map((e) => e.relPath);
    expect(paths).toEqual(["keep.txt"]);
  });
});

describe("copier.toLongPath — Windows long-path support", () => {
  it("prefixes an absolute drive path with \\\\?\\", () => {
    expect(toLongPath("C:\\Users\\Ed\\file.txt")).toBe("\\\\?\\C:\\Users\\Ed\\file.txt");
  });

  it("converts a UNC path to the \\\\?\\UNC\\ form", () => {
    expect(toLongPath("\\\\server\\share\\file.txt")).toBe(
      "\\\\?\\UNC\\server\\share\\file.txt",
    );
  });

  it("is idempotent — an already-prefixed path is left alone", () => {
    const p = "\\\\?\\C:\\Users\\Ed\\file.txt";
    expect(toLongPath(p)).toBe(p);
  });

  it("leaves a relative path alone", () => {
    expect(toLongPath("relative/file.txt")).toBe("relative/file.txt");
  });
});

describe("copier — deep path copy", () => {
  it("copies a file whose path exceeds the classic 260-char limit", async () => {
    const root = mkdtempSync(join(tmpdir(), "filesync-long-"));
    trees.push({ cleanup: () => rmSync(root, { recursive: true, force: true }) });

    // Build a path well past MAX_PATH: 12 segments of 20 chars each.
    const segments = Array.from({ length: 12 }, (_, i) =>
      `seg${String(i).padStart(2, "0")}_${"x".repeat(14)}`,
    );
    const rel = segments.join("\\");
    const src = join(root, rel, "deep.txt");
    mkdirSync(join(root, rel), { recursive: true });
    writeFileSync(src, "deep content");

    const dest = join(root, rel, "deep-copy.txt");
    const { copyAtomic } = await import("../../src/main/engine/copier");
    const result = await copyAtomic({ src, dest });

    expect(result.bytes).toBe(12);
    expect(result.retried).toBe(false);
  });
});
