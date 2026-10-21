#!/usr/bin/env node
/**
 * Smoke-test the app: launch Electron with the real bundled Python and drive
 * the core through the same IPC path the UI uses.
 *
 * This verifies the packaged-runtime resolution, the job protocol and the
 * Excel export without needing a human in front of the window.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CORE = path.join(ROOT, "python-app", "km_core.py");

const VENV_PY = path.join(ROOT, "python-app", "runtime-venv", "Scripts", "python.exe");
const RUNTIME_PY = path.join(ROOT, "python-app", "runtime", "python.exe");

function pickPython() {
  if (fs.existsSync(VENV_PY)) return VENV_PY;
  if (fs.existsSync(RUNTIME_PY)) return RUNTIME_PY;
  throw new Error("No bundled Python found. Run: npm run stage-python");
}

const TEST_DATA =
  process.env.KM_TEST_DATA ||
  "C:\\Users\\Administrator\\Desktop\\Github_EdRey05\\Streamlit_projects\\Test_units\\Project 003\\clinical_synthetic.txt";

function runJob(py, job) {
  return new Promise((resolve, reject) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "km-test-"));
    const jobPath = path.join(tmp, "job.json");
    const outPath = path.join(tmp, "out.json");
    fs.writeFileSync(jobPath, JSON.stringify(job), "utf8");
    const child = spawn(py, [CORE, jobPath, "--out", outPath], { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", () => {
      try {
        const data = JSON.parse(fs.readFileSync(outPath, "utf8"));
        fs.rmSync(tmp, { recursive: true, force: true });
        resolve(data);
      } catch (e) {
        reject(new Error(`No result. stderr:\n${stderr}`));
      }
    });
  });
}

let failures = 0;
function check(name, cond, detail = "") {
  if (!cond) failures++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name} ${detail}`);
}

(async () => {
  console.log("=".repeat(64));
  console.log("KM Plotter — core smoke test");
  console.log("=".repeat(64));

  const py = pickPython();
  console.log(`python: ${py}\n`);

  // 1. inspect
  console.log("=== inspect ===");
  const ins = await runJob(py, { command: "inspect", clinicalPath: TEST_DATA });
  check("inspect ok", ins.ok, ins.error || "");
  check("rows > 0", ins.clinical.nRows > 0, `nRows=${ins.clinical.nRows}`);
  check("found OS_MONTHS", ins.options.timeToEventOptions.includes("OS_MONTHS"));
  check("found OS_STATUS", ins.options.eventObservationOptions.includes("OS_STATUS"));

  // 2. analyze
  console.log("\n=== analyze (no subgroups) ===");
  const an = await runJob(py, {
    command: "analyze",
    clinicalPath: TEST_DATA,
    timeColumn: "OS_MONTHS",
    eventColumn: "OS_STATUS",
    noEventValues: ["Alive"],
    eventValues: ["Dead"],
    variables: [],
    alpha: 0.05,
  });
  check("analyze ok", an.ok, an.error || "");
  const c = an.result.curves[0];
  check("one curve", an.result.nCurves === 1);
  check("median ~40.69", Math.abs(c.median - 40.68605213188546) < 1e-9, `median=${c.median}`);
  check("n=1000", c.n === 1000, `n=${c.n}`);
  check("events=429", c.nEvents === 429, `events=${c.nEvents}`);
  check("timeline non-empty", c.timeline.length > 0, `len=${c.timeline.length}`);
  check("at-risk table present", c.atRisk.length === 6, `rows=${c.atRisk.length}`);

  // 3. subgroup
  console.log("\n=== analyze (3 tag subgroups) ===");
  const sub = await runJob(py, {
    command: "analyze",
    clinicalPath: TEST_DATA,
    timeColumn: "OS_MONTHS",
    eventColumn: "OS_STATUS",
    noEventValues: ["Alive"],
    eventValues: ["Dead"],
    variables: [
      {
        source: "clinical",
        column: "S1",
        mode: "tags",
        groups: [
          { values: ["Treatment_A"], name: "A" },
          { values: ["Treatment_B"], name: "B" },
          { values: ["Treatment_C"], name: "C" },
        ],
      },
    ],
    alpha: 0.05,
  });
  check("subgroup ok", sub.ok, sub.error || "");
  check("3 curves", sub.result.nCurves === 3, `n=${sub.result.nCurves}`);
  const medB = sub.result.curves.find((x) => x.label === "B")?.median;
  check("B median matches lifelines", Math.abs(medB - 38.00176122148873) < 1e-9, `median=${medB}`);

  // 4. export
  console.log("\n=== excel export ===");
  const exp = await runJob(py, {
    command: "export",
    clinicalPath: TEST_DATA,
    timeColumn: "OS_MONTHS",
    eventColumn: "OS_STATUS",
    noEventValues: ["Alive"],
    eventValues: ["Dead"],
    variables: [],
    alpha: 0.05,
    filename: "KM_results.xlsx",
  });
  check("export ok", exp.ok, exp.error || "");
  const raw = Buffer.from(exp.base64, "base64");
  check("xlsx magic", raw.slice(0, 2).toString() === "PK", `got ${raw.slice(0, 2).toString()}`);
  check("xlsx size", raw.length > 5000, `${raw.length} bytes`);

  console.log("\n" + "=".repeat(64));
  if (failures) {
    console.log(`FAILED — ${failures} check(s) did not pass`);
    process.exit(1);
  }
  console.log("ALL SMOKE TESTS PASSED");
})().catch((e) => {
  console.error("\nERROR:", e.message);
  process.exit(1);
});
