import { describe, it, expect, afterEach } from "vitest";
import { walk, compileFilters, matchesFilters } from "../../src/main/engine/walker";
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

describe("walker", () => {
  it("walks a flat directory and returns sizes + counts", async () => {
    const { root } = setup({
      "a.txt": "hello",
      "b.txt": "world!",
    });

    const r = await walk({ root });
    expect(r.fileCount).toBe(2);
    expect(r.totalBytes).toBe(11);
    const paths = r.entries.filter((e) => !e.isDirectory).map((e) => e.relPath).sort();
    expect(paths).toEqual(["a.txt", "b.txt"]);
  });

  it("walks nested directories", async () => {
    const { root } = setup({
      "src/main/index.ts": "x",
      "src/renderer/App.tsx": "yy",
      "README.md": "zzz",
    });

    const r = await walk({ root });
    const paths = r.entries.filter((e) => !e.isDirectory).map((e) => e.relPath).sort();
    expect(paths).toEqual(["README.md", "src/main/index.ts", "src/renderer/App.tsx"]);
    expect(r.fileCount).toBe(3);
  });

  it("excludes via gitignore-style globs", async () => {
    const { root } = setup({
      "keep.txt": "k",
      "node_modules/foo/index.js": "mod",
      "src/a.ts": "a",
      "src/b.test.ts": "b",
    });

    const r = await walk({
      root,
      filters: { include: [], exclude: ["node_modules/", "*.test.ts"] },
    });
    const paths = r.entries.filter((e) => !e.isDirectory).map((e) => e.relPath).sort();
    expect(paths).toEqual(["keep.txt", "src/a.ts"]);
  });

  it("automatically excludes the .filesync-trash directory", async () => {
    const { root } = setup({
      "keep.txt": "k",
      ".filesync-trash/job1/old.txt": "o",
    });

    const r = await walk({ root });
    const paths = r.entries.filter((e) => !e.isDirectory).map((e) => e.relPath);
    expect(paths).toEqual(["keep.txt"]);
  });

  it("respects include filters when provided", async () => {
    const { root } = setup({
      "a.md": "a",
      "b.txt": "b",
      "sub/c.md": "c",
      "sub/d.txt": "d",
    });

    const r = await walk({
      root,
      filters: { include: ["**/*.md"], exclude: [] },
    });
    const paths = r.entries.filter((e) => !e.isDirectory).map((e) => e.relPath).sort();
    expect(paths).toEqual(["a.md", "sub/c.md"]);
  });
});

describe("filter matcher", () => {
  it("anchored vs unanchored patterns", () => {
    const f = compileFilters({ include: [], exclude: ["/secret.txt", "tmp/"] });
    expect(matchesFilters("secret.txt", f)).toBe(false);
    expect(matchesFilters("foo/secret.txt", f)).toBe(true); // anchored: only matches at root
    expect(matchesFilters("tmp/anything.txt", f)).toBe(false);
    expect(matchesFilters("src/tmp/x.txt", f)).toBe(false); // tmp/ matches at any depth
  });

  it("** crosses path segments", () => {
    const f = compileFilters({ include: ["src/**/*.ts"], exclude: [] });
    expect(matchesFilters("src/a.ts", f)).toBe(true);
    expect(matchesFilters("src/deep/nested/a.ts", f)).toBe(true);
    expect(matchesFilters("other/a.ts", f)).toBe(false);
  });
});
