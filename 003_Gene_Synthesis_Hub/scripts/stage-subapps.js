#!/usr/bin/env node
/**
 * Stage the Python subapp source into `python-app/`.
 *
 * Normally you commit the subapp source under python-app/ directly. This
 * script is a convenience for cases where you want to refresh from the
 * upstream BBI_projects tree — e.g. when a subapp gets updated and you
 * want to pull the new version into the Electron app.
 *
 * Source root is resolved relative to the Electron_projects folder, so
 * the layout must match:
 *   .../Github_EdRey05/
 *     Electron_projects/003_Gene_Synthesis_Hub/
 *     BBI_projects/App_hub/Gene_Synthesis_hub/
 *
 * Usage:
 *   node scripts/stage-subapps.js
 */

const fs = require("fs");
const path = require("path");

const HUB_ROOT = path.resolve(__dirname, "..", "..", "..");
const SRC = path.join(HUB_ROOT, "BBI_projects", "App_hub", "Gene_Synthesis_hub");
const DST = path.resolve(__dirname, "..", "python-app");

const COPY_DIRS = ["Code", "Templates", "Databases"];
const COPY_FILES = ["default_directories.ini", "app_information.txt"];

function copyDir(src, dst) {
  if (!fs.existsSync(src)) throw new Error(`Source not found: ${src}`);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
  console.log(`✓ ${path.basename(src)}/`);
}

function copyFile(src, dst) {
  if (!fs.existsSync(src)) throw new Error(`Source not found: ${src}`);
  fs.copyFileSync(src, dst);
  console.log(`✓ ${path.basename(src)}`);
}

if (!fs.existsSync(SRC)) {
  console.error(`❌ Source hub not found at ${SRC}`);
  console.error("   Update HUB_ROOT in this script if your repo layout differs.");
  process.exit(1);
}

console.log(`Staging subapps from:\n  ${SRC}\ninto:\n  ${DST}\n`);
for (const d of COPY_DIRS) copyDir(path.join(SRC, d), path.join(DST, d));
for (const f of COPY_FILES) copyFile(path.join(SRC, f), path.join(DST, f));
console.log("\n✅ Done.");
