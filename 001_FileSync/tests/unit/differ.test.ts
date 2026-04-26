import { describe, it, expect } from "vitest";
import { diff } from "../../src/main/engine/differ";
import type {
  ConflictPolicy,
  DiffInput,
  SideMeta,
  StateRecord,
} from "../../src/shared/types";

function meta(size: number, mtimeMs: number): SideMeta {
  return { size, mtimeMs };
}

function rec(parts: Partial<StateRecord>): StateRecord {
  return parts;
}

function makeInput(opts: {
  a?: Record<string, SideMeta>;
  b?: Record<string, SideMeta>;
  state?: Record<string, StateRecord>;
  policy?: ConflictPolicy;
  toleranceMs?: number;
}): DiffInput {
  return {
    walkA: new Map(Object.entries(opts.a ?? {})),
    walkB: new Map(Object.entries(opts.b ?? {})),
    state: new Map(Object.entries(opts.state ?? {})),
    policy: opts.policy ?? "newer-wins",
    toleranceMs: opts.toleranceMs ?? 2000,
  };
}

const T = 1_700_000_000_000; // base mtime
const LATER = T + 60_000;

describe("differ — 11-case truth table from PLAN.md §7", () => {
  it("(present, present, absent) → first sync: copy newer to other side; tie → noop", () => {
    // A newer than B
    let plan = diff(
      makeInput({
        a: { "x.txt": meta(10, LATER) },
        b: { "x.txt": meta(8, T) },
      }),
    );
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].kind).toBe("copy-a-to-b");
    expect(plan.actions[0].bytes).toBe(10);

    // B newer than A
    plan = diff(
      makeInput({
        a: { "x.txt": meta(10, T) },
        b: { "x.txt": meta(12, LATER) },
      }),
    );
    expect(plan.actions[0].kind).toBe("copy-b-to-a");
    expect(plan.actions[0].bytes).toBe(12);

    // Tie (same size + mtime within tolerance) → noop
    plan = diff(
      makeInput({
        a: { "x.txt": meta(10, T) },
        b: { "x.txt": meta(10, T + 500) },
      }),
    );
    expect(plan.actions[0].kind).toBe("noop");
  });

  it("(present, absent, absent) → new on A: copy A→B", () => {
    const plan = diff(
      makeInput({ a: { "n.txt": meta(5, T) }, b: {}, state: {} }),
    );
    expect(plan.actions[0].kind).toBe("copy-a-to-b");
    expect(plan.actions[0].reason).toMatch(/new on A/);
  });

  it("(absent, present, absent) → new on B: copy B→A", () => {
    const plan = diff(
      makeInput({ a: {}, b: { "n.txt": meta(5, T) }, state: {} }),
    );
    expect(plan.actions[0].kind).toBe("copy-b-to-a");
    expect(plan.actions[0].reason).toMatch(/new on B/);
  });

  it("(changed, unchanged, present) → propagate A→B", () => {
    const plan = diff(
      makeInput({
        a: { "f.txt": meta(20, LATER) }, // size changed since state
        b: { "f.txt": meta(10, T) },
        state: { "f.txt": rec({ aSize: 10, aMtime: T, bSize: 10, bMtime: T }) },
      }),
    );
    expect(plan.actions[0].kind).toBe("copy-a-to-b");
  });

  it("(unchanged, changed, present) → propagate B→A", () => {
    const plan = diff(
      makeInput({
        a: { "f.txt": meta(10, T) },
        b: { "f.txt": meta(20, LATER) },
        state: { "f.txt": rec({ aSize: 10, aMtime: T, bSize: 10, bMtime: T }) },
      }),
    );
    expect(plan.actions[0].kind).toBe("copy-b-to-a");
  });

  it("(changed, changed, present) → CONFLICT (edit-edit); newer-wins resolves", () => {
    const plan = diff(
      makeInput({
        a: { "f.txt": meta(15, LATER) }, // A edited, larger mtime
        b: { "f.txt": meta(20, T + 30_000) }, // B edited, smaller mtime
        state: { "f.txt": rec({ aSize: 10, aMtime: T, bSize: 10, bMtime: T }) },
        policy: "newer-wins",
      }),
    );
    expect(plan.actions[0].kind).toBe("copy-a-to-b"); // A wins on mtime
    expect(plan.actions[0].conflict?.type).toBe("edit-edit");
    expect(plan.actions[0].conflict?.suggested).toBe("keep-a");
    expect(plan.summary.conflicts).toBe(0); // resolved by policy
  });

  it("(changed, changed, present) under policy=ask → raw conflict action", () => {
    const plan = diff(
      makeInput({
        a: { "f.txt": meta(15, LATER) },
        b: { "f.txt": meta(20, T + 30_000) },
        state: { "f.txt": rec({ aSize: 10, aMtime: T, bSize: 10, bMtime: T }) },
        policy: "ask",
      }),
    );
    expect(plan.actions[0].kind).toBe("conflict");
    expect(plan.summary.conflicts).toBe(1);
  });

  it("(absent, unchanged, present) → deleted on A: delete-b", () => {
    const plan = diff(
      makeInput({
        a: {},
        b: { "f.txt": meta(10, T) },
        state: { "f.txt": rec({ aSize: 10, aMtime: T, bSize: 10, bMtime: T }) },
      }),
    );
    expect(plan.actions[0].kind).toBe("delete-b");
    expect(plan.actions[0].bytes).toBe(10);
    expect(plan.actions[0].reason).toMatch(/deleted on A/);
  });

  it("(unchanged, absent, present) → deleted on B: delete-a", () => {
    const plan = diff(
      makeInput({
        a: { "f.txt": meta(10, T) },
        b: {},
        state: { "f.txt": rec({ aSize: 10, aMtime: T, bSize: 10, bMtime: T }) },
      }),
    );
    expect(plan.actions[0].kind).toBe("delete-a");
    expect(plan.actions[0].reason).toMatch(/deleted on B/);
  });

  it("(absent, absent, present) → both deleted: drop-from-state", () => {
    const plan = diff(
      makeInput({
        a: {},
        b: {},
        state: { "f.txt": rec({ aSize: 10, aMtime: T, bSize: 10, bMtime: T }) },
      }),
    );
    expect(plan.actions[0].kind).toBe("drop-from-state");
  });

  it("(absent, changed, present) → CONFLICT (delete-edit)", () => {
    const plan = diff(
      makeInput({
        a: {},
        b: { "f.txt": meta(20, LATER) }, // B edited
        state: { "f.txt": rec({ aSize: 10, aMtime: T, bSize: 10, bMtime: T }) },
        policy: "ask",
      }),
    );
    expect(plan.actions[0].kind).toBe("conflict");
    expect(plan.actions[0].conflict?.type).toBe("delete-edit");
  });

  it("(changed, absent, present) → CONFLICT (edit-delete)", () => {
    const plan = diff(
      makeInput({
        a: { "f.txt": meta(20, LATER) }, // A edited
        b: {},
        state: { "f.txt": rec({ aSize: 10, aMtime: T, bSize: 10, bMtime: T }) },
        policy: "ask",
      }),
    );
    expect(plan.actions[0].kind).toBe("conflict");
    expect(plan.actions[0].conflict?.type).toBe("edit-delete");
  });
});

describe("differ — supporting behavior", () => {
  it("(unchanged, unchanged, present) → noop, summarized", () => {
    const plan = diff(
      makeInput({
        a: { "f.txt": meta(10, T) },
        b: { "f.txt": meta(10, T) },
        state: { "f.txt": rec({ aSize: 10, aMtime: T, bSize: 10, bMtime: T }) },
      }),
    );
    expect(plan.actions[0].kind).toBe("noop");
    expect(plan.summary).toEqual({
      copyAToB: 0,
      copyBToA: 0,
      deleteA: 0,
      deleteB: 0,
      conflicts: 0,
      noops: 1,
      bytesToTransfer: 0,
    });
  });

  it("respects mtime tolerance window (FAT32 / SMB 2-second drift)", () => {
    const plan = diff(
      makeInput({
        a: { "f.txt": meta(10, T + 1500) }, // within 2s tolerance
        b: { "f.txt": meta(10, T) },
        state: { "f.txt": rec({ aSize: 10, aMtime: T, bSize: 10, bMtime: T }) },
        toleranceMs: 2000,
      }),
    );
    expect(plan.actions[0].kind).toBe("noop");
  });

  it("flags as changed when mtime drift exceeds tolerance", () => {
    const plan = diff(
      makeInput({
        a: { "f.txt": meta(10, T + 5000) }, // 5s drift, exceeds 2s tolerance
        b: { "f.txt": meta(10, T) },
        state: { "f.txt": rec({ aSize: 10, aMtime: T, bSize: 10, bMtime: T }) },
        toleranceMs: 2000,
      }),
    );
    expect(plan.actions[0].kind).toBe("copy-a-to-b");
  });

  it("aggregates summary counts and bytes across many actions", () => {
    const plan = diff(
      makeInput({
        a: {
          "new.txt": meta(100, T),
          "edited.txt": meta(50, LATER),
          "kept.txt": meta(10, T),
          "del-on-b.txt": meta(7, T),
        },
        b: {
          "edited.txt": meta(40, T),
          "kept.txt": meta(10, T),
          // del-on-b.txt was deleted from B since last sync
          "new-on-b.txt": meta(20, T),
        },
        state: {
          "edited.txt": rec({ aSize: 40, aMtime: T, bSize: 40, bMtime: T }),
          "kept.txt": rec({ aSize: 10, aMtime: T, bSize: 10, bMtime: T }),
          "del-on-b.txt": rec({ aSize: 7, aMtime: T, bSize: 7, bMtime: T }),
        },
      }),
    );
    expect(plan.summary.copyAToB).toBe(2); // new.txt + edited.txt
    expect(plan.summary.copyBToA).toBe(1); // new-on-b.txt
    expect(plan.summary.deleteA).toBe(1); // del-on-b.txt removed because gone from B (unchanged)
    expect(plan.summary.noops).toBe(1); // kept.txt
    expect(plan.summary.bytesToTransfer).toBe(100 + 50 + 20);
  });

  it("a second run after a hypothetical apply is idempotent (noops only)", () => {
    // Simulate state matching what both walks now contain.
    const after = makeInput({
      a: { "x.txt": meta(10, T), "y.txt": meta(20, T) },
      b: { "x.txt": meta(10, T), "y.txt": meta(20, T) },
      state: {
        "x.txt": rec({ aSize: 10, aMtime: T, bSize: 10, bMtime: T }),
        "y.txt": rec({ aSize: 20, aMtime: T, bSize: 20, bMtime: T }),
      },
    });
    const plan = diff(after);
    expect(plan.actions.every((a) => a.kind === "noop")).toBe(true);
    expect(plan.summary.bytesToTransfer).toBe(0);
  });

  it("rename-both policy emits raw conflict (not auto-resolved)", () => {
    const plan = diff(
      makeInput({
        a: { "f.txt": meta(15, LATER) },
        b: { "f.txt": meta(20, T + 30_000) },
        state: { "f.txt": rec({ aSize: 10, aMtime: T, bSize: 10, bMtime: T }) },
        policy: "rename-both",
      }),
    );
    expect(plan.actions[0].kind).toBe("conflict");
    expect(plan.actions[0].conflict?.suggested).toBe("rename-both");
  });

  it("orders actions by path (deterministic output)", () => {
    const plan = diff(
      makeInput({
        a: { "z.txt": meta(1, T), "a.txt": meta(1, T), "m.txt": meta(1, T) },
        b: {},
        state: {},
      }),
    );
    expect(plan.actions.map((x) => x.path)).toEqual(["a.txt", "m.txt", "z.txt"]);
  });
});
