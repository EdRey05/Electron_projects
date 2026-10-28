import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { copyAtomic } from "../../src/main/engine/copier";
import { apply } from "../../src/main/engine/applier";
import { dryRun } from "../../src/main/engine/runner";
import { moveToTrash } from "../../src/main/engine/trash";

vi.mock("node:fs/promises", async importOriginal => {
  const real = await importOriginal<typeof fs>();
  return { ...real, copyFile: vi.fn(real.copyFile), rename: vi.fn(real.rename) };
});

const real = await vi.importActual<typeof fs>("node:fs/promises");
const dirs: string[] = [];
function folder() {
  const root = mkdtempSync(join(tmpdir(), "filesync-integrity-"));
  dirs.push(root);
  return root;
}
function files() {
  const root = folder();
  const src = join(root, "source.bin");
  const dest = join(root, "destination.bin");
  writeFileSync(src, "new bytes");
  writeFileSync(dest, "old bytes");
  return { root, src, dest };
}
function expectOriginals(root: string, src: string, dest: string) {
  expect(readFileSync(src, "utf8")).toBe("new bytes");
  expect(readFileSync(dest, "utf8")).toBe("old bytes");
  expect(readdirSync(root).some(name => name.includes(".tmp."))).toBe(false);
}
afterEach(() => {
  vi.mocked(fs.copyFile).mockReset().mockImplementation(real.copyFile);
  vi.mocked(fs.rename).mockReset().mockImplementation(real.rename);
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("verified transfer integrity", () => {
  it("round-trips binary data and reports the independently verified SHA-256", async () => {
    const { src, dest } = files();
    const payload = Buffer.alloc(3 * 1024 * 1024 + 7);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    writeFileSync(src, payload);
    const result = await copyAtomic({ src, dest });
    expect(result.sha256).toBe(createHash("sha256").update(payload).digest("hex"));
    expect(result.bytes).toBe(payload.length);
    expect(readFileSync(src).equals(payload)).toBe(true);
    expect(readFileSync(dest).equals(payload)).toBe(true);
  });

  it("verifies empty files too", async () => {
    const { src, dest } = files();
    writeFileSync(src, "");
    const result = await copyAtomic({ src, dest });
    expect(result.sha256).toBe(createHash("sha256").digest("hex"));
    expect(readFileSync(dest).length).toBe(0);
  });

  it("rejects same-length corruption before replacing the old destination", async () => {
    const { root, src, dest } = files();
    vi.mocked(fs.copyFile).mockImplementationOnce(async (_src, tmp) => {
      await real.writeFile(tmp, "BAD bytes"); // same length, different hash
    });
    await expect(copyAtomic({ src, dest })).rejects.toThrow("SHA-256/size mismatch");
    expectOriginals(root, src, dest);
  });

  it("cleans up a partial copy after disk-full and leaves both originals intact", async () => {
    const { root, src, dest } = files();
    vi.mocked(fs.copyFile).mockImplementationOnce(async (_src, tmp) => {
      await real.writeFile(tmp, "partial");
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    });
    await expect(copyAtomic({ src, dest })).rejects.toMatchObject({ code: "ENOSPC" });
    expectOriginals(root, src, dest);
  });

  it("retains the existing destination if its backup fails", async () => {
    const { root, src, dest } = files();
    await expect(copyAtomic({ src, dest, beforeCommit: async () => { throw new Error("backup failed"); } }))
      .rejects.toThrow("backup failed");
    expectOriginals(root, src, dest);
  });

  it("retains the old destination when final rename fails", async () => {
    const { root, src, dest } = files();
    vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error("rename failed"), { code: "EIO" }));
    await expect(copyAtomic({ src, dest })).rejects.toThrow("rename failed");
    expectOriginals(root, src, dest);
  });

  it("retries a transient copy failure then verifies the successful result", async () => {
    const { src, dest } = files();
    vi.mocked(fs.copyFile).mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EBUSY" }));
    expect((await copyAtomic({ src, dest, initialBackoffMs: 1 })).retried).toBe(true);
    expect(readFileSync(dest, "utf8")).toBe("new bytes");
  });

  it("refuses a source modified during copying", async () => {
    const { src, dest } = files();
    vi.mocked(fs.copyFile).mockImplementationOnce(async (source, tmp, flags) => {
      await real.copyFile(source, tmp, flags);
      await real.writeFile(source, "source changed during copy");
    });
    await expect(copyAtomic({ src, dest })).rejects.toThrow("Source changed during transfer");
    expect(readFileSync(dest, "utf8")).toBe("old bytes");
  });

  it("checks for source edits again after preparing the backup", async () => {
    const { src, dest } = files();
    await expect(copyAtomic({ src, dest, beforeCommit: () => real.writeFile(src, "later source edit") }))
      .rejects.toThrow("Source changed during transfer");
    expect(readFileSync(dest, "utf8")).toBe("old bytes");
  });

  it("refuses to overwrite a destination edited during copying", async () => {
    const { src, dest } = files();
    await expect(copyAtomic({ src, dest, beforeCommit: () => real.writeFile(dest, "someone else's edit") }))
      .rejects.toThrow("Destination changed during transfer");
    expect(readFileSync(dest, "utf8")).toBe("someone else's edit");
  });

  it("refuses copying a file onto itself", async () => {
    const { src } = files();
    await expect(copyAtomic({ src, dest: src })).rejects.toThrow("same file");
    expect(readFileSync(src, "utf8")).toBe("new bytes");
  });

  it("refuses a hard-link alias of the source", async () => {
    const { src, root } = files();
    const alias = join(root, "alias.bin");
    await real.link(src, alias);
    await expect(copyAtomic({ src, dest: alias })).rejects.toThrow("same file");
    expect(readFileSync(src, "utf8")).toBe("new bytes");
  });

  it("does not delete the original after a corrupt cross-volume trash copy", async () => {
    const { root, src } = files();
    vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error("cross-device"), { code: "EXDEV" }));
    vi.mocked(fs.copyFile).mockImplementationOnce(async (_source, tmp) => { await real.writeFile(tmp, "BAD bytes"); });
    await expect(moveToTrash({ filePath: src, sideRoot: root, jobId: "job", runTimestamp: "run", relPath: "source.bin" }))
      .rejects.toThrow("SHA-256/size mismatch");
    expect(readFileSync(src, "utf8")).toBe("new bytes");
  });
});

describe("apply protects reviewed files", () => {
  async function job() {
    const a = folder(); const b = folder(); const state = folder();
    writeFileSync(join(a, "file.txt"), "new bytes");
    writeFileSync(join(b, "file.txt"), "old destination");
    const opts = { jobId: "job", sideA: a, sideB: b, stateDbPath: join(state, "state.sqlite") };
    const { plan } = await dryRun({ ...opts, direction: "a-to-b" });
    return { ...opts, plan, trash: { enabled: true, retainDays: 30 } };
  }

  it("keeps the old live destination when its replacement cannot be copied", async () => {
    const opts = await job();
    vi.mocked(fs.copyFile).mockRejectedValueOnce(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
    const result = await apply(opts);
    expect(result.status).toBe("error");
    expect(result.filesCopied).toBe(0);
    expect(readFileSync(join(opts.sideB, "file.txt"), "utf8")).toBe("old destination");
    expect(existsSync(join(opts.sideB, ".filesync-trash"))).toBe(false);
  });

  it.each(["sideA", "sideB"] as const)("refuses edits on %s made after Analyze", async side => {
    const opts = await job();
    writeFileSync(join(opts[side], "file.txt"), "newer edit after review");
    const result = await apply(opts);
    expect(result.status).toBe("error");
    expect(result.errors[0].message).toContain("changed since Analyze");
    expect(result.filesCopied).toBe(0);
  });

  it("refuses overlapping roots before changing files", async () => {
    const opts = await job();
    await expect(apply({ ...opts, sideB: opts.sideA })).rejects.toThrow("non-overlapping");
  });

  it("rejects paths escaping the chosen folders", async () => {
    const opts = await job();
    opts.plan.actions[0].path = "../outside.txt";
    const result = await apply(opts);
    expect(result.status).toBe("error");
    expect(result.errors[0].message).toContain("Invalid relative file path");
  });

  it("does not delete a destination-only file edited after Analyze", async () => {
    const opts = await job();
    writeFileSync(join(opts.sideB, "extra.txt"), "original extra");
    const { plan } = await dryRun({ ...opts, direction: "a-to-b", deleteExtraneous: true });
    writeFileSync(join(opts.sideB, "extra.txt"), "new extra contents after review");
    const result = await apply({ ...opts, plan });
    expect(result.status).toBe("partial");
    expect(result.filesDeleted).toBe(0);
    expect(readFileSync(join(opts.sideB, "extra.txt"), "utf8")).toBe("new extra contents after review");
  });

  it("refuses a nested destination before scanning it", async () => {
    const opts = await job();
    const nested = join(opts.sideA, "nested");
    await real.mkdir(nested);
    await expect(dryRun({ ...opts, sideB: nested })).rejects.toThrow("non-overlapping");
  });

  it("does not record failed copies as synchronized state", async () => {
    const opts = await job();
    vi.mocked(fs.copyFile).mockRejectedValueOnce(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
    await apply(opts);
    const { plan } = await dryRun({ ...opts, direction: "a-to-b" });
    expect(plan.summary.copyAToB).toBe(1);
    expect(readFileSync(join(opts.sideB, "file.txt"), "utf8")).toBe("old destination");
  });

  it("rejects a concurrent transfer using an active root and releases its guard afterward", async () => {
    const opts = await job();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const copying = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(fs.copyFile).mockImplementationOnce(async (src, dest, flags) => {
      started();
      await gate;
      await real.copyFile(src, dest, flags);
    });
    const first = apply(opts);
    try {
      await copying;
      await expect(apply(opts)).rejects.toThrow("already using");
    } finally { release(); }
    expect((await first).status).toBe("ok");
    const { plan } = await dryRun({ ...opts, direction: "a-to-b" });
    expect((await apply({ ...opts, plan })).status).toBe("ok");
  });
});
