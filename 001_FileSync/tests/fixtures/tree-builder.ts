import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

export interface TreeSpec {
  [path: string]: string | null; // string = file content; null = empty directory
}

export interface Tree {
  root: string;
  cleanup(): void;
}

export function buildTree(spec: TreeSpec): Tree {
  const root = join(tmpdir(), `filesync-test-${randomUUID()}`);
  mkdirSync(root, { recursive: true });

  for (const [relPath, content] of Object.entries(spec)) {
    const full = join(root, relPath);
    if (content === null) {
      mkdirSync(full, { recursive: true });
    } else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
  }

  return {
    root,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
