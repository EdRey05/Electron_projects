import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function overlaps(a: string, b: string): boolean {
  return contains(a, b) || contains(b, a);
}

/** Resolve aliases too: syncing a directory with itself or a descendant
 * can overwrite the source or recursively copy the destination into itself.
 */
export async function validateRoots(a: string, b: string): Promise<[string, string]> {
  const roots = await Promise.all([realpath(a), realpath(b)]);
  if (overlaps(roots[0], roots[1])) throw new Error("Choose two separate, non-overlapping folders");
  return roots as [string, string];
}

export function fileInRoot(root: string, path: string): string {
  if (!path || path.includes("\\") || path.includes(":") || path.split("/").some(p => p === ".." || p === ".") || isAbsolute(path)) {
    throw new Error("Invalid relative file path in sync plan");
  }
  const result = resolve(root, path);
  if (!contains(resolve(root), result) || result === resolve(root)) throw new Error("File path escapes sync root");
  return result;
}
