import { describe, it, expect } from "vitest";
import { oneWayDiff } from "../../src/main/engine/oneway-diff";
import type { SideMeta } from "../../src/shared/types";

function meta(size: number, mtimeMs: number): SideMeta {
  return { size, mtimeMs };
}

const T = 1_700_000_000_000;

describe("oneWayDiff — a-to-b mirror", () => {
  it("copies A-only files to B", () => {
    const plan = oneWayDiff({
      walkA: new Map([["x.txt", meta(10, T)]]),
      walkB: new Map(),
      direction: "a-to-b",
    });
    expect(plan.actions[0].kind).toBe("copy-a-to-b");
    expect(plan.actions[0].reason).toMatch(/new on A/);
    expect(plan.summary.copyAToB).toBe(1);
    expect(plan.summary.bytesToTransfer).toBe(10);
  });

  it("deletes B-only files from B (mirror semantics)", () => {
    const plan = oneWayDiff({
      walkA: new Map(),
      walkB: new Map([["extra.txt", meta(5, T)]]),
      direction: "a-to-b",
    });
    expect(plan.actions[0].kind).toBe("delete-b");
    expect(plan.summary.deleteB).toBe(1);
  });

  it("noops when both sides match (size + mtime within tolerance)", () => {
    const plan = oneWayDiff({
      walkA: new Map([["f.txt", meta(7, T)]]),
      walkB: new Map([["f.txt", meta(7, T + 500)]]),
      direction: "a-to-b",
      toleranceMs: 2000,
    });
    expect(plan.actions[0].kind).toBe("noop");
    expect(plan.summary.noops).toBe(1);
    expect(plan.summary.bytesToTransfer).toBe(0);
  });

  it("A always wins on size differences regardless of mtime", () => {
    // B is newer in mtime, but A is authoritative for mirror.
    const plan = oneWayDiff({
      walkA: new Map([["f.txt", meta(10, T)]]),
      walkB: new Map([["f.txt", meta(20, T + 60_000)]]),
      direction: "a-to-b",
    });
    expect(plan.actions[0].kind).toBe("copy-a-to-b");
    expect(plan.actions[0].reason).toMatch(/size differs/);
    expect(plan.actions[0].reason).toMatch(/A wins/);
  });

  it("flags mtime drift beyond tolerance even when sizes match", () => {
    const plan = oneWayDiff({
      walkA: new Map([["f.txt", meta(10, T + 5000)]]),
      walkB: new Map([["f.txt", meta(10, T)]]),
      direction: "a-to-b",
      toleranceMs: 2000,
    });
    expect(plan.actions[0].kind).toBe("copy-a-to-b");
    expect(plan.actions[0].reason).toMatch(/mtime drift/);
  });

  it("never produces copy-b-to-a or delete-a actions", () => {
    const plan = oneWayDiff({
      walkA: new Map([["a.txt", meta(1, T)], ["both.txt", meta(2, T)]]),
      walkB: new Map([["b-only.txt", meta(3, T)], ["both.txt", meta(99, T)]]),
      direction: "a-to-b",
    });
    expect(plan.summary.copyBToA).toBe(0);
    expect(plan.summary.deleteA).toBe(0);
    expect(
      plan.actions.every(
        (a) => a.kind !== "copy-b-to-a" && a.kind !== "delete-a",
      ),
    ).toBe(true);
  });

  it("re-running a successful mirror is idempotent (all noops)", () => {
    // Simulate state after a successful mirror: B is identical to A.
    const both = new Map([
      ["a.txt", meta(1, T)],
      ["sub/b.txt", meta(2, T)],
    ]);
    const plan = oneWayDiff({
      walkA: both,
      walkB: new Map(both),
      direction: "a-to-b",
    });
    expect(plan.actions.every((a) => a.kind === "noop")).toBe(true);
    expect(plan.summary.bytesToTransfer).toBe(0);
  });
});

describe("oneWayDiff — b-to-a mirror (symmetry check)", () => {
  it("the same fixture under reverse direction produces mirrored plan", () => {
    const a = new Map([["only-a.txt", meta(1, T)]]);
    const b = new Map([["only-b.txt", meta(2, T)]]);

    const ab = oneWayDiff({ walkA: a, walkB: b, direction: "a-to-b" });
    const ba = oneWayDiff({ walkA: a, walkB: b, direction: "b-to-a" });

    // a-to-b: copy only-a.txt A->B; delete only-b.txt from B.
    expect(ab.summary.copyAToB).toBe(1);
    expect(ab.summary.deleteB).toBe(1);
    expect(ab.summary.copyBToA).toBe(0);
    expect(ab.summary.deleteA).toBe(0);

    // b-to-a: copy only-b.txt B->A; delete only-a.txt from A.
    expect(ba.summary.copyBToA).toBe(1);
    expect(ba.summary.deleteA).toBe(1);
    expect(ba.summary.copyAToB).toBe(0);
    expect(ba.summary.deleteB).toBe(0);
  });

  it("orders actions by path for deterministic output", () => {
    const plan = oneWayDiff({
      walkA: new Map([
        ["z.txt", meta(1, T)],
        ["a.txt", meta(1, T)],
        ["m.txt", meta(1, T)],
      ]),
      walkB: new Map(),
      direction: "a-to-b",
    });
    expect(plan.actions.map((x) => x.path)).toEqual(["a.txt", "m.txt", "z.txt"]);
  });
});
