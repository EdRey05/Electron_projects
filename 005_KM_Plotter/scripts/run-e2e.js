#!/usr/bin/env node
/**
 * Run the end-to-end suite against a built app.
 *
 *   node scripts/run-e2e.js [portable|win-unpacked]
 *
 * Why a script instead of a shell one-liner: the packaged Electron app is a
 * GUI-subsystem binary, so its stdout never reaches a pipe and its exit code
 * is meaningless. The only reliable signal is the JSON report the harness
 * writes. This script waits for that report, validates it, and exits 0/1.
 *
 * The portable target unpacks the whole app (Python runtime + venv, ~15k
 * files) into a fresh %TEMP% folder on every launch, so the first run takes
 * several minutes. That is expected, not a hang.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const RELEASE = path.join(ROOT, "release");
const EVIDENCE = path.join(RELEASE, "e2e-evidence");

const DEFAULT_CLINICAL =
  path.join(ROOT, "tests", "fixtures", "clinical_synthetic.tsv");
const pkg = require(path.join(ROOT, "package.json"));

const target = process.argv[2] || "portable";
const clinical = process.env.KM_TEST_DATA || DEFAULT_CLINICAL;

let exePath;
if (target === "win-unpacked") {
  exePath = path.join(RELEASE, "win-unpacked", "KM Plotter.exe");
} else if (target === "portable") {
  exePath = path.join(RELEASE, `${pkg.name}-${pkg.version}-win-x64-portable.exe`);
} else {
  console.error(`Unknown target: ${target}. Use "portable" or "win-unpacked".`);
  process.exit(2);
}

if (!fs.existsSync(exePath)) {
  console.error(`Not found: ${exePath}\nRun: npm run package:portable`);
  process.exit(2);
}

fs.mkdirSync(EVIDENCE, { recursive: true });

const reportPath = path.join(EVIDENCE, "km_report_final.json");
const xlsxPath = path.join(EVIDENCE, "km_out_final.xlsx");
const pickPath = path.join(EVIDENCE, "km_pick_final.json");

// The pick queue is *consumed* by the app, so it must be rewritten each run.
fs.writeFileSync(pickPath, JSON.stringify([clinical]), "utf8");
for (const f of [reportPath, xlsxPath]) {
  if (fs.existsSync(f)) fs.rmSync(f);
}

console.log(`target:   ${target}`);
console.log(`exe:      ${exePath}`);
console.log(`clinical: ${clinical}`);
console.log(`report:   ${reportPath}\n`);

const child = spawn(exePath, [], {
  windowsHide: true,
  env: {
    ...process.env,
    KM_E2E_TEST: "1",
    KM_TEST_DATA: clinical,
    KM_E2E_REPORT: reportPath,
    KM_E2E_SAVE_PATH: xlsxPath,
    KM_E2E_PICK_FILES: pickPath,
  },
});

let exited = false;
child.on("error", (e) => {
  console.error(`Failed to launch: ${e.message}`);
  process.exit(1);
});
child.on("close", () => {
  exited = true;
});

// Poll for the report — the portable target extracts before it runs.
const started = Date.now();
const TIMEOUT_MS = 15 * 60 * 1000;
const poll = setInterval(() => {
  if (fs.existsSync(reportPath)) {
    clearInterval(poll);
    if (!exited) child.kill();
    finish();
    return;
  }
  const secs = Math.round((Date.now() - started) / 1000);
  if (secs % 30 === 0) console.log(`  ... waiting for the report (${secs}s)`);
  if (Date.now() - started > TIMEOUT_MS) {
    clearInterval(poll);
    console.error(`\nTimed out after ${TIMEOUT_MS / 60000} min waiting for the report.`);
    process.exit(1);
  }
}, 1000);

function finish() {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  } catch (e) {
    console.error(`\nCould not read the report: ${e.message}`);
    process.exit(1);
  }

  const failed = report.checks.filter((c) => !c.pass);
  console.log("");
  for (const c of report.checks) {
    console.log(`  [${c.pass ? "PASS" : "FAIL"}] ${c.name} ${c.detail}`);
  }
  console.log(`\n${report.checks.length - failed.length}/${report.checks.length} checks passed`);

  if (fs.existsSync(xlsxPath)) {
    const size = fs.statSync(xlsxPath).size;
    const head = fs.readFileSync(xlsxPath).slice(0, 2).toString();
    console.log(`export:   ${xlsxPath} (${size} bytes, magic=${JSON.stringify(head)})`);
  }

  if (failed.length || !report.ok) {
    console.error(`\nFAILED: ${failed.map((c) => c.name).join(", ") || "report not ok"}`);
    process.exit(1);
  }
  console.log("\nE2E PASSED");
  process.exit(0);
}
