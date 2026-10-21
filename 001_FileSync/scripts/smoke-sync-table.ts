/**
 * Manual smoke test for the v0.0.6 sync table.
 *
 * Runs the engine exactly the way the Workspace screen does — analyze, apply
 * the user's per-item overrides, apply — against two real folders on disk.
 * Prints the table rows so the output can be eyeballed.
 *
 * Usage: node --experimental-strip-types scripts/smoke-sync-table.ts
 *   (or: npx tsx scripts/smoke-sync-table.ts <sideA> <sideB>)
 */
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dryRun } from "../src/main/engine/runner";
import { apply } from "../src/main/engine/applier";
import type { ItemAction } from "../src/shared/types";

async function main(): Promise<void> {
  const [sideA, sideB] = process.argv.slice(2);
  if (!sideA || !sideB) {
    console.error("usage: smoke-sync-table.ts <sideA> <sideB>");
    process.exit(1);
  }

  const jobDir = mkdtempSync(join(tmpdir(), "filesync-smoke-"));
  const dbPath = join(jobDir, "job.sqlite");

  const r = await dryRun({
    jobId: "smoke",
    sideA,
    sideB,
    stateDbPath: dbPath,
    direction: "a-to-b",
  });

  console.log("\n=== SYNC TABLE ===");
  console.log(
    "path".padEnd(28),
    "A".padStart(10),
    "B".padStart(10),
    "planned".padEnd(14),
    "status",
  );
  for (const item of r.inventory) {
    console.log(
      (item.isDirectory ? item.path + "/" : item.path).padEnd(28),
      (item.aExists ? String(item.aSize) : "-").padStart(10),
      (item.bExists ? String(item.bSize) : "-").padStart(10),
      item.plannedKind.padEnd(14),
      item.inSync ? "in sync" : item.reason,
    );
  }

  console.log("\n=== SUMMARY ===");
  console.log(r.plan.summary);

  // Apply a per-item override the way the table would.
  const overrides: Record<string, ItemAction> = {};
  const firstFolder = r.inventory.find((i) => i.isDirectory);
  if (firstFolder) {
    overrides[firstFolder.path] = "skip";
    console.log(`\nApplying override: ${firstFolder.path} -> skip`);
  }

  const r2 = await dryRun({
    jobId: "smoke",
    sideA,
    sideB,
    stateDbPath: dbPath,
    direction: "a-to-b",
    overrides,
  });
  console.log("Summary after override:", r2.plan.summary);

  const result = await apply({
    jobId: "smoke",
    sideA,
    sideB,
    stateDbPath: dbPath,
    plan: r2.plan,
    trash: { enabled: true, retainDays: 30 },
    preserveTimestamps: true,
  });
  console.log("\n=== APPLY RESULT ===");
  console.log({
    status: result.status,
    filesCopied: result.filesCopied,
    filesDeleted: result.filesDeleted,
    bytesTransferred: result.bytesTransferred,
    errors: result.errors,
  });

  // Re-analyze: the idempotency invariant.
  const r3 = await dryRun({
    jobId: "smoke",
    sideA,
    sideB,
    stateDbPath: dbPath,
    direction: "a-to-b",
    overrides,
  });
  const remaining = r3.plan.actions.filter(
    (a) => a.kind !== "noop" && a.kind !== "drop-from-state",
  );
  console.log("\n=== IDEMPOTENCY ===");
  console.log("remaining actionable after apply:", remaining.length);
  for (const a of remaining) console.log("  ", a.path, a.kind, a.reason);

  rmSync(jobDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Keep the imports referenced so the linter does not strip them.
void existsSync;
void readFileSync;
void readdirSync;
