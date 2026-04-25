import { walk as fsWalk } from "@nodelib/fs.walk";
import { sep, posix, relative } from "node:path";
import type { WalkEntry, WalkRequest, WalkResult } from "@shared/types";

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

export async function walk(req: WalkRequest): Promise<WalkResult> {
  const started = Date.now();
  const filters = compileFilters(req.filters);
  const followSymlinks = req.followSymlinks ?? false;

  const entries: WalkEntry[] = [];
  let fileCount = 0;
  let dirCount = 0;
  let totalBytes = 0;

  await new Promise<void>((resolve, reject) => {
    fsWalk(
      req.root,
      {
        stats: true,
        followSymbolicLinks: followSymlinks,
        throwErrorOnBrokenSymbolicLink: false,
        deepFilter: (entry) => {
          const rel = toPosix(relative(req.root, entry.path));
          if (rel.startsWith(TRASH_DIR)) return false;
          if (rel === "") return true;
          return !filters.exclude.some((rx) => rx.test(rel));
        },
        entryFilter: (entry) => {
          const rel = toPosix(relative(req.root, entry.path));
          if (rel === "") return false;
          if (rel.startsWith(TRASH_DIR)) return false;
          return matchesFilters(rel, filters);
        },
      },
      (err, results) => {
        if (err) return reject(err);
        for (const e of results) {
          const rel = toPosix(relative(req.root, e.path));
          const isDir = e.dirent.isDirectory();
          const size = isDir ? 0 : Number(e.stats?.size ?? 0);
          const mtimeMs = Number(e.stats?.mtimeMs ?? 0);
          entries.push({ relPath: rel, size, mtimeMs, isDirectory: isDir });
          if (isDir) dirCount++;
          else {
            fileCount++;
            totalBytes += size;
          }
        }
        resolve();
      },
    );
  });

  return {
    root: req.root,
    fileCount,
    dirCount,
    totalBytes,
    durationMs: Date.now() - started,
    entries,
  };
}
