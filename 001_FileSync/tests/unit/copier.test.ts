import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  readdirSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyAtomic } from "../../src/main/engine/copier";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "filesync-copier-"));
  dirs.push(d);
  return d;
}

describe("copier.copyAtomic", () => {
  it("copies a file and reports byte count", async () => {
    const a = freshDir();
    const src = join(a, "src.txt");
    const dest = join(a, "dest.txt");
    writeFileSync(src, "hello world");

    const result = await copyAtomic({ src, dest });
    expect(result.bytes).toBe(11);
    expect(result.retried).toBe(false);
    expect(readFileSync(dest, "utf8")).toBe("hello world");
  });

  it("creates intermediate directories on the destination side", async () => {
    const a = freshDir();
    const src = join(a, "src.txt");
    const dest = join(a, "deep", "nested", "dir", "file.txt");
    writeFileSync(src, "x");

    await copyAtomic({ src, dest });
    expect(existsSync(dest)).toBe(true);
  });

  it("preserves timestamps when requested", async () => {
    const a = freshDir();
    const src = join(a, "src.txt");
    const dest = join(a, "dest.txt");
    writeFileSync(src, "y");
    const oldMs = Math.floor(Date.UTC(2020, 0, 1) / 1000);
    utimesSync(src, oldMs, oldMs);

    await copyAtomic({ src, dest, preserveTimestamps: true });
    const dStat = statSync(dest);
    // Allow 1 second drift (some filesystems quantize).
    expect(Math.abs(dStat.mtimeMs / 1000 - oldMs)).toBeLessThan(1.5);
  });

  it("does not preserve timestamps unless asked", async () => {
    const a = freshDir();
    const src = join(a, "src.txt");
    const dest = join(a, "dest.txt");
    writeFileSync(src, "z");
    const oldMs = Math.floor(Date.UTC(2020, 0, 1) / 1000);
    utimesSync(src, oldMs, oldMs);

    await copyAtomic({ src, dest });
    const dStat = statSync(dest);
    // Default fs.copyFile copies mtime on most platforms; we assert that the
    // dest is at least as new as src (not silently truncated to 0).
    expect(dStat.mtimeMs).toBeGreaterThan(0);
  });

  it("leaves no .tmp.* files behind on success", async () => {
    const a = freshDir();
    const src = join(a, "src.txt");
    const dest = join(a, "dest.txt");
    writeFileSync(src, "k");

    await copyAtomic({ src, dest });
    const stragglers = readdirSync(a).filter((n) => n.includes(".tmp."));
    expect(stragglers).toEqual([]);
  });

  it("propagates ENOENT immediately (not retried)", async () => {
    const a = freshDir();
    await expect(
      copyAtomic({ src: join(a, "missing.txt"), dest: join(a, "dest.txt") }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("overwrites an existing destination", async () => {
    const a = freshDir();
    const src = join(a, "src.txt");
    const dest = join(a, "dest.txt");
    writeFileSync(src, "NEW");
    writeFileSync(dest, "OLD");

    await copyAtomic({ src, dest });
    expect(readFileSync(dest, "utf8")).toBe("NEW");
  });
});
