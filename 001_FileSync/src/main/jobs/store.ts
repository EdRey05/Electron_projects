import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { Job } from "@shared/types";

const SCHEMA_VERSION = 1;

interface JobsFile {
  version: 1;
  jobs: Job[];
}

const DEFAULT_FILTERS = {
  include: [] as string[],
  exclude: [".filesync-trash/", "node_modules/", ".git/"] as string[],
};

const DEFAULT_TRASH = { enabled: true, retainDays: 30 };

/** Fill in defaults for fields the caller may have omitted. */
export function applyJobDefaults(input: Partial<Job>): Job {
  return {
    id: input.id ?? randomUUID(),
    name: (input.name ?? "").trim(),
    sideA: input.sideA ?? "",
    sideB: input.sideB ?? "",
    filters: input.filters ?? { ...DEFAULT_FILTERS },
    onConflict: input.onConflict ?? "newer-wins",
    trash: input.trash ?? { ...DEFAULT_TRASH },
    followSymlinks: input.followSymlinks ?? false,
    preserveTimestamps: input.preserveTimestamps ?? true,
  };
}

/** Case-normalized prefix containment for nesting check. */
function isNested(a: string, b: string): boolean {
  // Normalize: trailing separator + lowercase. NTFS/HFS+ are case-insensitive
  // by default; on case-sensitive filesystems this gives at most false positives,
  // which is the safer direction for a "would corrupt your data" check.
  const norm = (p: string): string => {
    const withSep = p.endsWith(sep) ? p : p + sep;
    return withSep.toLowerCase();
  };
  const aN = norm(a);
  const bN = norm(b);
  if (aN === bN) return false;
  return aN.startsWith(bN) || bN.startsWith(aN);
}

export interface ValidationOptions {
  /** Skip on-disk existence checks (useful for save-then-create-folder UX). */
  skipExistenceCheck?: boolean;
}

export function validateJob(job: Job, opts: ValidationOptions = {}): string[] {
  const errors: string[] = [];
  if (!job.name) errors.push("Name is required.");
  if (!job.sideA) errors.push("Side A folder is required.");
  if (!job.sideB) errors.push("Side B folder is required.");

  if (job.sideA && !isAbsolute(job.sideA)) {
    errors.push("Side A must be an absolute path.");
  }
  if (job.sideB && !isAbsolute(job.sideB)) {
    errors.push("Side B must be an absolute path.");
  }

  if (job.sideA && job.sideB && isAbsolute(job.sideA) && isAbsolute(job.sideB)) {
    const a = resolve(job.sideA);
    const b = resolve(job.sideB);
    if (a.toLowerCase() === b.toLowerCase()) {
      errors.push("Side A and Side B must be different folders.");
    } else if (isNested(a, b)) {
      errors.push("Side A and Side B cannot be nested inside each other.");
    }
    if (!opts.skipExistenceCheck) {
      if (!existsSync(a)) errors.push(`Side A does not exist: ${a}`);
      if (!existsSync(b)) errors.push(`Side B does not exist: ${b}`);
    }
  }

  if (
    job.onConflict !== "newer-wins" &&
    job.onConflict !== "rename-both" &&
    job.onConflict !== "ask"
  ) {
    errors.push("Invalid conflict policy.");
  }

  if (
    !Number.isFinite(job.trash.retainDays) ||
    job.trash.retainDays < 0 ||
    job.trash.retainDays > 3650
  ) {
    errors.push("Trash retention must be between 0 and 3650 days.");
  }

  return errors;
}

async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, path);
}

export async function loadJobs(jobsPath: string): Promise<Job[]> {
  if (!existsSync(jobsPath)) return [];
  const text = await readFile(jobsPath, "utf8");
  if (!text.trim()) return [];
  const parsed: JobsFile = JSON.parse(text);
  if (!parsed || typeof parsed !== "object") return [];
  if (!Array.isArray(parsed.jobs)) return [];
  // Pass through applyJobDefaults so older files with missing fields still load.
  return parsed.jobs.map((j) => applyJobDefaults(j));
}

export async function saveJobs(jobsPath: string, jobs: Job[]): Promise<void> {
  const payload: JobsFile = { version: SCHEMA_VERSION, jobs };
  await atomicWriteJson(jobsPath, payload);
}

export async function upsertJob(
  jobsPath: string,
  input: Partial<Job>,
  opts: ValidationOptions = {},
): Promise<Job> {
  const jobs = await loadJobs(jobsPath);
  const job = applyJobDefaults(input);
  const errors = validateJob(job, opts);
  if (errors.length > 0) {
    throw new Error(`Invalid job:\n  - ${errors.join("\n  - ")}`);
  }
  const idx = jobs.findIndex((j) => j.id === job.id);
  if (idx >= 0) jobs[idx] = job;
  else jobs.push(job);
  await saveJobs(jobsPath, jobs);
  return job;
}

export async function deleteJob(jobsPath: string, id: string): Promise<void> {
  const jobs = await loadJobs(jobsPath);
  const next = jobs.filter((j) => j.id !== id);
  if (next.length === jobs.length) return; // no-op if not found
  await saveJobs(jobsPath, next);
}
