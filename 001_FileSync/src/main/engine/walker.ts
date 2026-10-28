import { walkStream, type Entry } from "@nodelib/fs.walk";
import { sep, posix, relative } from "node:path";
import type { WalkEntry, WalkRequest, WalkResult, WalkProgress } from "@shared/types";
import { TEMP_SUFFIX_RE } from "./copier";

const TRASH_DIR = ".filesync-trash";

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join(posix.sep);
}

function compileGlob(glob: string): RegExp {
  // Minimal gitignore-flavored glob:
  //   **      → match across path segments
  //   *       → match within one segment (no /)
  //   ?       → single non-/ char
  //   leading "/" anchors to root; otherwise matches at any depth.
  //   trailing "/" matches a directory and everything under it.
  const trimmed = glob.trim();
  if (!trimmed || trimmed.startsWith("#")) return /^\b$/; // matches nothing

  let pattern = trimmed;
  const anchored = pattern.startsWith("/");
  if (anchored) pattern = pattern.slice(1);

  const dirOnly = pattern.endsWith("/");
  if (dirOnly) pattern = pattern.slice(0, -1);

  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\/?/g, "::DOUBLESTAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/::DOUBLESTAR::/g, "(?:.*/)?");

  const head = anchored ? "^" : "(?:^|.*/)";
  const tail = dirOnly ? "(?:/.*)?$" : "(?:/.*)?$";
  return new RegExp(head + escaped + tail);
}

export interface CompiledFilters {
  include: RegExp[];
  exclude: RegExp[];
}

export function compileFilters(filters?: { include: string[]; exclude: string[] }): CompiledFilters {
  return {
    include: (filters?.include ?? []).map(compileGlob),
    exclude: (filters?.exclude ?? []).map(compileGlob),
  };
}

export function matchesFilters(relPosix: string, f: CompiledFilters): boolean {
  if (f.exclude.some((rx) => rx.test(relPosix))) return false;
  if (f.include.length === 0) return true;
  return f.include.some((rx) => rx.test(relPosix));
}

interface WalkOptions extends WalkRequest {
  onProgress?(progress: WalkProgress): void;
  signal?: AbortSignal;
}

export async function walk(req: WalkOptions): Promise<WalkResult> {
  const started = Date.now();
  const filters = compileFilters(req.filters);
  const followSymlinks = req.followSymlinks ?? false;

  // Per-side ignores are compiled separately so the walker can honour them
  // without the caller having to build two filter sets by hand.
  const sideExtras = compileFilters({
    include: [],
    exclude: req.sideExcludes ?? [],
  });

  const entries: WalkEntry[] = [];
  let fileCount = 0;
  let dirCount = 0;
  let totalBytes = 0;
  let currentPath = "";
  let lastEntryAt = started;
  let lastSentAt = 0;
  function notify(complete = false, force = false) {
    const now = Date.now();
    if (force || now - lastSentAt >= 250) {
      req.onProgress?.({ fileCount, dirCount, totalBytes, currentPath, lastEntryAt, complete });
      lastSentAt = now;
    }
  }
  if (req.signal?.aborted) throw new Error("Analysis stopped");
  notify(false, true);

  const stream = walkStream(
      req.root,
      {
        concurrency: 16,
        stats: true,
        followSymbolicLinks: followSymlinks,
        throwErrorOnBrokenSymbolicLink: false,
        deepFilter: (entry) => {
          const rel = toPosix(relative(req.root, entry.path));
          if (rel.startsWith(TRASH_DIR)) return false;
          if (rel === "") return true;
          if (filters.exclude.some((rx) => rx.test(rel))) return false;
          if (sideExtras.exclude.some((rx) => rx.test(rel))) return false;
          return true;
        },
        entryFilter: (entry) => {
          const rel = toPosix(relative(req.root, entry.path));
          if (rel === "") return false;
          if (rel.startsWith(TRASH_DIR)) return false;
          if (TEMP_SUFFIX_RE.test(entry.name)) return false;
          if (sideExtras.exclude.some((rx) => rx.test(rel))) return false;
          return matchesFilters(rel, filters);
        },
      });
  const abort = () => { stream.destroy(new Error("Analysis stopped")); };
  req.signal?.addEventListener("abort", abort, { once: true });
  try {
    // Consume entries as discovered, rather than waiting for the library
    // to materialize a second full-tree array before reporting anything.
    for await (const e of stream as AsyncIterable<Entry>) {
      const rel = toPosix(relative(req.root, e.path));
      const isDir = e.dirent.isDirectory();
      const size = isDir ? 0 : Number(e.stats?.size ?? 0);
      const mtimeMs = Number(e.stats?.mtimeMs ?? 0);
      entries.push({ relPath: rel, size, mtimeMs, isDirectory: isDir });
      currentPath = rel;
      lastEntryAt = Date.now();
      if (isDir) dirCount++;
      else {
        fileCount++;
        totalBytes += size;
      }
      notify();
      if (entries.length % 1000 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    }
    notify(true, true);
  } finally {
    req.signal?.removeEventListener("abort", abort);
    if (!stream.destroyed) stream.destroy();
  }

  return {
    root: req.root,
    fileCount,
    dirCount,
    totalBytes,
    durationMs: Date.now() - started,
    entries,
  };
}
