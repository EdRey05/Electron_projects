import { describe, it, expect } from "vitest";
import {
  buildInventory,
  effectiveAction,
  overrideMatches,
  resolveOverride,
  type SyncItem,
} from "../../src/shared/inventory";
import type { OverrideMap, WalkResult } from "../../src/shared/types";

function walk(entries: WalkResult["entries"]): WalkResult {
  return {
    root: "C:/root",
    fileCount: entries.filter((e) => !e.isDirectory).length,
    dirCount: entries.filter((e) => e.isDirectory).length,
    totalBytes: 0,
    durationMs: 0,
    entries,
  };
}

const T = 1_700_000_000_000;

describe("inventory.buildInventory", () => {
  it("emits a row for every file on either side", () => {
    const items = buildInventory(
      walk([
        { relPath: "a.txt", size: 10, mtimeMs: T, isDirectory: false },
        { relPath: "sub", size: 0, mtimeMs: T, isDirectory: true },
      ]),
      walk([
        { relPath: "b.txt", size: 20, mtimeMs: T, isDirectory: false },
        { relPath: "sub", size: 0, mtimeMs: T, isDirectory: true },
      ]),
      [],
    );

    const paths = items.map((i) => i.path).sort();
    expect(paths).toEqual(["a.txt", "b.txt", "sub"]);
  });

  it("marks a file present only on A with aExists=true, bExists=false", () => {
    const items = buildInventory(
      walk([{ relPath: "only-a.txt", size: 10, mtimeMs: T, isDirectory: false }]),
      walk([]),
      [],
    );
    const item = items.find((i) => i.path === "only-a.txt")!;
    expect(item.aExists).toBe(true);
    expect(item.bExists).toBe(false);
    expect(item.aSize).toBe(10);
    expect(item.bSize).toBeNull();
  });

  it("marks a file that the differ called in-sync as inSync", () => {
    const items = buildInventory(
      walk([{ relPath: "same.txt", size: 5, mtimeMs: T, isDirectory: false }]),
      walk([{ relPath: "same.txt", size: 5, mtimeMs: T, isDirectory: false }]),
      [{ kind: "noop", path: "same.txt", reason: "in sync" }],
    );
    const item = items.find((i) => i.path === "same.txt")!;
    expect(item.inSync).toBe(true);
    expect(item.plannedKind).toBe("noop");
  });

  it("marks a file the differ wants to copy as NOT in sync", () => {
    const items = buildInventory(
      walk([{ relPath: "new.txt", size: 5, mtimeMs: T, isDirectory: false }]),
      walk([]),
      [{ kind: "copy-a-to-b", path: "new.txt", reason: "new on A" }],
    );
    const item = items.find((i) => i.path === "new.txt")!;
    expect(item.inSync).toBe(false);
    expect(item.plannedKind).toBe("copy-a-to-b");
  });

  it("includes folder rows so folders can carry an action", () => {
    const items = buildInventory(
      walk([
        { relPath: "photos", size: 0, mtimeMs: T, isDirectory: true },
        { relPath: "photos/x.jpg", size: 5, mtimeMs: T, isDirectory: false },
      ]),
      walk([{ relPath: "photos", size: 0, mtimeMs: T, isDirectory: true }]),
      [{ kind: "copy-a-to-b", path: "photos/x.jpg", reason: "new on A" }],
    );
    const folder = items.find((i) => i.path === "photos")!;
    expect(folder.isDirectory).toBe(true);
    expect(folder.inSync).toBe(false);
  });

  it("marks a folder in sync when every file under it is in sync", () => {
    const items = buildInventory(
      walk([
        { relPath: "photos", size: 0, mtimeMs: T, isDirectory: true },
        { relPath: "photos/x.jpg", size: 5, mtimeMs: T, isDirectory: false },
      ]),
      walk([
        { relPath: "photos", size: 0, mtimeMs: T, isDirectory: true },
        { relPath: "photos/x.jpg", size: 5, mtimeMs: T, isDirectory: false },
      ]),
      [{ kind: "noop", path: "photos/x.jpg", reason: "in sync" }],
    );
    const folder = items.find((i) => i.path === "photos")!;
    expect(folder.inSync).toBe(true);
  });
});

describe("inventory.overrideMatches", () => {
  it("the root key matches everything", () => {
    expect(overrideMatches("anything/at/all.txt", "")).toBe(true);
  });

  it("a folder key matches its descendants but not a sibling prefix", () => {
    expect(overrideMatches("photos/a.jpg", "photos")).toBe(true);
    expect(overrideMatches("photos", "photos")).toBe(true);
    // "photos2" must NOT be caught by the "photos" folder rule.
    expect(overrideMatches("photos2/a.jpg", "photos")).toBe(false);
  });

  it("a file key matches only that file", () => {
    expect(overrideMatches("a.txt", "a.txt")).toBe(true);
    expect(overrideMatches("b.txt", "a.txt")).toBe(false);
    expect(overrideMatches("dir/a.txt", "a.txt")).toBe(false);
  });
});

describe("inventory.resolveOverride", () => {
  it("returns auto when nothing is set", () => {
    expect(resolveOverride("a.txt", {})).toBe("auto");
  });

  it("the most specific (longest) matching key wins", () => {
    const overrides: OverrideMap = {
      "": "skip",
      photos: "copy-b-to-a",
      "photos/2024": "keep-both",
    };
    expect(resolveOverride("photos/2024/a.jpg", overrides)).toBe("keep-both");
    expect(resolveOverride("photos/2023/a.jpg", overrides)).toBe("copy-b-to-a");
    expect(resolveOverride("other/a.jpg", overrides)).toBe("skip");
  });
});

describe("inventory.effectiveAction", () => {
  function item(over: Partial<SyncItem> = {}): SyncItem {
    return {
      path: "f.txt",
      isDirectory: false,
      aExists: true,
      bExists: true,
      aSize: 10,
      bSize: 20,
      aMtime: T,
      bMtime: T,
      plannedKind: "copy-a-to-b",
      reason: "",
      action: "auto",
      inSync: false,
      overridden: false,
      ...over,
    };
  }

  it("auto keeps the differ's action", () => {
    expect(effectiveAction(item(), "auto")).toBe("copy-a-to-b");
  });

  it("auto on an in-sync file produces no action", () => {
    expect(effectiveAction(item({ plannedKind: "noop" }), "auto")).toBeNull();
  });

  it("skip produces no action", () => {
    expect(effectiveAction(item(), "skip")).toBeNull();
  });

  it("copy-a-to-b is a no-op when A does not have the file", () => {
    expect(effectiveAction(item({ aExists: false }), "copy-a-to-b")).toBeNull();
  });

  it("keep-a with A present becomes copy-a-to-b", () => {
    expect(effectiveAction(item(), "keep-a")).toBe("copy-a-to-b");
  });

  it("keep-a with A gone becomes delete-b", () => {
    expect(effectiveAction(item({ aExists: false }), "keep-a")).toBe("delete-b");
  });

  it("keep-b with B gone becomes delete-a", () => {
    expect(effectiveAction(item({ bExists: false }), "keep-b")).toBe("delete-a");
  });

  it("keep-both needs the file on both sides", () => {
    expect(effectiveAction(item(), "keep-both")).toBe("keep-both");
    expect(effectiveAction(item({ bExists: false }), "keep-both")).toBeNull();
  });

  it("delete-a is a no-op when A does not have the file", () => {
    expect(effectiveAction(item({ aExists: false }), "delete-a")).toBeNull();
  });
});
