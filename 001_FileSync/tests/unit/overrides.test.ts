import { describe, it, expect } from "vitest";
import { applyOverrides, summarize } from "../../src/shared/overrides";
import type { Action, DiffPlan } from "../../src/shared/types";

function action(over: Partial<Action> = {}): Action {
  return {
    kind: "copy-a-to-b",
    path: "f.txt",
    bytes: 10,
    reason: "new on A",
    aExists: true,
    bExists: true,
    aSize: 10,
    bSize: 20,
    ...over,
  };
}

function plan(actions: Action[]): DiffPlan {
  return { actions, summary: summarize(actions) };
}

describe("overrides.applyOverrides", () => {
  it("returns the plan unchanged when there are no overrides", () => {
    const p = plan([action()]);
    const out = applyOverrides(p, {});
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0].kind).toBe("copy-a-to-b");
  });

  it("a file-level override rewrites the action kind", () => {
    const p = plan([action()]);
    const out = applyOverrides(p, { "f.txt": "copy-b-to-a" });
    expect(out.actions[0].kind).toBe("copy-b-to-a");
    expect(out.actions[0].reason).toMatch(/forced B→A/);
  });

  it("skip drops the action from the runnable plan", () => {
    const p = plan([action(), action({ path: "g.txt" })]);
    const out = applyOverrides(p, { "f.txt": "skip" });
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0].path).toBe("g.txt");
  });

  it("a folder override applies to every file beneath it", () => {
    const p = plan([
      action({ path: "photos/a.jpg" }),
      action({ path: "photos/b.jpg" }),
      action({ path: "other/c.jpg" }),
    ]);
    const out = applyOverrides(p, { photos: "skip" });
    expect(out.actions.map((a) => a.path)).toEqual(["other/c.jpg"]);
  });

  it("a more specific override beats the folder override", () => {
    const p = plan([
      action({ path: "photos/a.jpg" }),
      action({ path: "photos/b.jpg" }),
    ]);
    const out = applyOverrides(p, {
      photos: "skip",
      "photos/a.jpg": "copy-b-to-a",
    });
    // photos/b.jpg is covered by the folder-level skip; photos/a.jpg keeps
    // its own, more specific override.
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0].path).toBe("photos/a.jpg");
    expect(out.actions[0].kind).toBe("copy-b-to-a");
  });

  it("the root override applies to everything", () => {
    const p = plan([action({ path: "a.txt" }), action({ path: "b/c.txt" })]);
    const out = applyOverrides(p, { "": "skip" });
    expect(out.actions).toHaveLength(0);
  });

  it("keep-both rewrites the action and sums both sizes", () => {
    const p = plan([
      action({ aSize: 10, bSize: 25, bExists: true, kind: "conflict" }),
    ]);
    const out = applyOverrides(p, { "f.txt": "keep-both" });
    expect(out.actions[0].kind).toBe("keep-both");
    expect(out.actions[0].bytes).toBe(35);
  });

  it("keep-a on a file missing from A becomes delete-b", () => {
    const p = plan([action({ aExists: false, bExists: true, kind: "conflict" })]);
    const out = applyOverrides(p, { "f.txt": "keep-a" });
    expect(out.actions[0].kind).toBe("delete-b");
  });

  it("recomputes the summary after applying overrides", () => {
    const p = plan([
      action({ path: "a.txt" }),
      action({ path: "b.txt" }),
      action({ path: "c.txt" }),
    ]);
    const out = applyOverrides(p, { "a.txt": "skip", "b.txt": "delete-b" });
    expect(out.summary.copyAToB).toBe(1);
    expect(out.summary.deleteB).toBe(1);
    expect(out.summary.bytesToTransfer).toBe(10);
  });
});

describe("overrides.summarize", () => {
  it("counts noop and drop-from-state as noops", () => {
    const s = summarize([
      action({ kind: "noop", bytes: 0 }),
      action({ kind: "drop-from-state", bytes: 0, path: "g.txt" }),
    ]);
    expect(s.noops).toBe(2);
  });

  it("counts keep-both as a copy in both directions", () => {
    const s = summarize([action({ kind: "keep-both", bytes: 30 })]);
    expect(s.copyAToB).toBe(1);
    expect(s.copyBToA).toBe(1);
    expect(s.bytesToTransfer).toBe(30);
  });
});
