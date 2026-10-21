// Smoke test for the Colony PCR Layout pure logic.
// Exercises the plate placement algorithm + workbook builder + extract
// helpers without a UI or Excel.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import ExcelJS from "exceljs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// The Colony PCR template — the workbook is built FROM it, so the harness
// needs the real file.
const TEMPLATE_BYTES = readFileSync(
  resolve(ROOT, "python-app/Templates/ColonyPCR_layout_v3.xlsx")
);

/**
 * Load a CommonJS-friendly export from an ES module source by stripping
 * the `export ` prefix + `import ... from "..."` statements and
 * evaluating inside a Function whose globals include `XLSX`.
 */
function loadExports(srcPath, exportsNeeded) {
  let src = readFileSync(srcPath, "utf8");
  // Strip `import ... from "..."` lines.
  src = src.replace(/^import .*?from\s+["'][^"']+["'];?\s*$/gm, "");
  // Strip `export ` keyword from declarations.
  src = src.replace(/^export /gm, "");
  const fn = new Function(
    "globalThis", "XLSX", "ExcelJS",
    src + `\nreturn { ${exportsNeeded.join(", ")} };`
  );
  return fn(globalThis, XLSX, ExcelJS);
}

const { planPlates } = loadExports(
  resolve(ROOT, "src/subapps/ColonyPCRLayout/platePlanner.js"),
  ["planPlates"]
);
const {
  buildPlateHeader,
  buildOutputFilename,
  buildWorkbookBytes,
} = loadExports(
  resolve(ROOT, "src/subapps/ColonyPCRLayout/workbookBuilder.js"),
  ["buildPlateHeader", "buildOutputFilename", "buildWorkbookBytes"]
);
const { readLigationLayout, readPrimerLog, buildSummary, uniqueJobDetails } = loadExports(
  resolve(ROOT, "src/subapps/ColonyPCRLayout/extractor.js"),
  ["readLigationLayout", "readPrimerLog", "buildSummary", "uniqueJobDetails"]
);

// Make xlsx available globally so stripped source code can find it.
globalThis.XLSX = XLSX;

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`✓ ${name}`);
  else { console.log(`✗ ${name}${detail ? " — " + detail : ""}`); failed++; }
}

// =============================================================================
// Header / filename
// =============================================================================
{
  // Aug 23, 2026: yearChar = 2026-1941 = 85 -> 'U'
  const d = new Date("2026-08-23T12:00:00Z");
  check("plateHeader: format", buildPlateHeader(d, 1) === "U0823ColonyPCR-P1");
  check("plateHeader: plate 2", buildPlateHeader(d, 2) === "U0823ColonyPCR-P2");
  check("outputFilename: format", buildOutputFilename(d) === "U0823-ColonyPCR-FL.xlsx");
}

// =============================================================================
// planPlates
// =============================================================================
{
  // Simple case: 3 jobs in same vector, each with 2 clones. All fit in one plate.
  const data = [
    { "Work No.": "JOB-001", Vector: "pUC19", Primers: "M13F", SourceFile: "lig.xlsx" },
    { "Work No.": "JOB-002", Vector: "pUC19", Primers: "M13F", SourceFile: "lig.xlsx" },
    { "Work No.": "JOB-003", Vector: "pUC19", Primers: "M13F", SourceFile: "lig.xlsx" },
  ];
  const counts = new Map([
    ["JOB-001\0lig.xlsx", 2],
    ["JOB-002\0lig.xlsx", 2],
    ["JOB-003\0lig.xlsx", 2],
  ]);
  const { plates } = planPlates(data, counts);
  check("planPlates: 1 plate when fits", plates.length === 1);
  check("planPlates: 6 jobs on plate", plates[0].jobs.length === 6);
  check("planPlates: same primers in same col", plates[0].jobs.every((j) => j.col === 0));
  check("planPlates: labels correct", plates[0].jobs[0].label === "JOB-001-Clone1");
}

{
  // Same vector, different primers -> new column on same plate.
  const data = [
    { "Work No.": "JOB-001", Vector: "pUC19", Primers: "M13F", SourceFile: "lig.xlsx" },
    { "Work No.": "JOB-002", Vector: "pUC19", Primers: "M13R", SourceFile: "lig.xlsx" },
  ];
  const counts = new Map([
    ["JOB-001\0lig.xlsx", 4],
    ["JOB-002\0lig.xlsx", 4],
  ]);
  const { plates } = planPlates(data, counts);
  check("planPlates: 1 plate still", plates.length === 1);
  check("planPlates: jobs span 2 cols", plates[0].jobs[0].col === 0 && plates[0].jobs[4].col === 1);
}

{
  // 13 jobs x 4 clones = 52 cells. Fits in 1 plate (96). Different primers -> new col.
  const data = Array.from({ length: 13 }, (_, i) => ({
    "Work No.": `JOB-${String(i + 1).padStart(3, "0")}`,
    Vector: "pUC19",
    Primers: `M${i}`, // unique primer per job -> one column per job
    SourceFile: "lig.xlsx",
  }));
  const counts = new Map();
  data.forEach((d) => counts.set(`${d["Work No."]}\0lig.xlsx`, 4));
  const { plates } = planPlates(data, counts);
  // 13 jobs x 1 col each = 13 cols -> overflows 12-col plate -> 2 plates
  check("planPlates: 2 plates when overflow", plates.length >= 2, "got " + plates.length);
}

{
  // 100 jobs x 1 clone = 100 cells. Each job has 1 clone so each job fits
  // in a single column row. With wrapped primers (12 unique), we expect
  // many columns and therefore multiple plates. The test only checks the
  // boundary: total clones placed = 100 + controls.
  const data = Array.from({ length: 100 }, (_, i) => ({
    "Work No.": `JOB-${String(i + 1).padStart(3, "0")}`,
    Vector: "pUC19",
    Primers: `M${i}`, // each job has a unique primer -> each column starts new
    SourceFile: "lig.xlsx",
  }));
  const counts = new Map();
  data.forEach((d) => counts.set(`${d["Work No."]}\0lig.xlsx`, 1));
  const { plates } = planPlates(data, counts);
  const totalJobs = plates.reduce((acc, p) => acc + p.jobs.length, 0);
  const totalControls = plates.reduce((acc, p) => acc + p.controls.length, 0);
  check("planPlates: all 100 clones placed", totalJobs === 100, "got " + totalJobs);
  check("planPlates: 2 controls (CK+ + CK-)", totalControls === 2);
  check("planPlates: controls on the last plate", plates[plates.length - 1].controls.length === 2);
  check("planPlates: CK+ first", plates[plates.length - 1].controls[0].label === "CK+");
  check("planPlates: CK- second", plates[plates.length - 1].controls[1].label === "CK-");
}

{
  // Filter by Vector (sort by vector), and ignore 0-clone jobs.
  // Note: alphabetical sort puts "pET28" (E=69) before "pUC19" (U=85).
  const data = [
    { "Work No.": "Z", Vector: "pET28", Primers: "T7", SourceFile: "lig.xlsx" },
    { "Work No.": "A", Vector: "pUC19", Primers: "M13F", SourceFile: "lig.xlsx" },
    { "Work No.": "skip", Vector: "pUC19", Primers: "M13F", SourceFile: "lig.xlsx" },
  ];
  const counts = new Map([
    ["Z\0lig.xlsx", 2],
    ["A\0lig.xlsx", 2],
    ["skip\0lig.xlsx", 0], // ignored
  ]);
  const { plates } = planPlates(data, counts);
  check("planPlates: 0-clone filtered", plates[0].jobs.every((j) => j.jobId !== "skip"));
  // pET28 sorts BEFORE pUC19 (E < U)
  check("planPlates: sort by vector (pET28 first)", plates[0].jobs[0].jobId === "Z");
  check("planPlates: pUC19 second", plates[0].jobs[2].jobId === "A");
}

// =============================================================================
// buildWorkbook
// =============================================================================
{
  const data = [
    { "Work No.": "JOB-001", "BBI ID": "B001", Vector: "pUC19", Resistance: "Amp", Primers: "M13F", "Length (bp)": 100, Host: "DH5a", Temperature: 37, SourceFile: "lig.xlsx" },
  ];
  const counts = new Map([["JOB-001\0lig.xlsx", 4]]);
  const plan = planPlates(data, counts);
  const bytes = await buildWorkbookBytes(plan, data, counts, TEMPLATE_BYTES);
  check("buildWorkbookBytes: produces non-empty bytes", bytes.byteLength > 1000);

  // Read the output back with ExcelJS — the builder is template-based now,
  // so the workbook is a real .xlsx rather than a SheetJS object.
  const outWb = new ExcelJS.Workbook();
  await outWb.xlsx.load(bytes);
  const names = outWb.worksheets.map((w) => w.name);
  check("buildWorkbookBytes: 2 sheets (Plate + Label)", names.length === 2, names.join(","));
  check("buildWorkbookBytes: Plate 1 first", names[0] === "Plate 1", names.join(","));
  check("buildWorkbookBytes: Label last", names[names.length - 1] === "Label", names.join(","));

  const plate1 = outWb.getWorksheet("Plate 1");
  check("buildWorkbookBytes: plate header at A1", String(plate1.getCell("A1").value).startsWith("U"), String(plate1.getCell("A1").value));
  // First clone is at plate (row=0, col=0) -> Excel cell column 0+2=2 ("B"), row 0+3=3 -> B3.
  check("buildWorkbookBytes: first clone at B3", plate1.getCell("B3").value === "JOB-001-Clone1", String(plate1.getCell("B3").value));
  check("buildWorkbookBytes: sample table header at B13", plate1.getCell("B13").value === "Work No.", String(plate1.getCell("B13").value));
  check("buildWorkbookBytes: first sample row at B14", plate1.getCell("B14").value === "JOB-001", String(plate1.getCell("B14").value));
  // The template's plate frame must survive.
  check("buildWorkbookBytes: template row letters preserved", plate1.getCell("A3").value === "A", String(plate1.getCell("A3").value));
  check("buildWorkbookBytes: template column numbers preserved", plate1.getCell("B2").value === 1, String(plate1.getCell("B2").value));
}

{
  // Multi-plate workbook
  const data = Array.from({ length: 14 }, (_, i) => ({
    "Work No.": `JOB-${String(i + 1).padStart(3, "0")}`,
    Vector: "pUC19",
    Primers: `M${i}`, // 14 unique primer groups -> > 12 cols
    SourceFile: "lig.xlsx",
  }));
  const counts = new Map();
  data.forEach((d) => counts.set(`${d["Work No."]}\0lig.xlsx`, 4));
  const plan = planPlates(data, counts);
  check("planPlates: 2 plates when 14 primer groups", plan.plates.length === 2);
  const bytes = await buildWorkbookBytes(plan, data, counts, TEMPLATE_BYTES);
  const outWb = new ExcelJS.Workbook();
  await outWb.xlsx.load(bytes);
  const names = outWb.worksheets.map((w) => w.name);
  check("buildWorkbookBytes: 3 sheets (Plate 1, Plate 2, Label)", names.length === 3, names.join(","));
  // The cloned plate must carry the template frame too.
  const p2 = outWb.getWorksheet("Plate 2");
  check("buildWorkbookBytes: Plate 2 keeps the row letters", p2 && p2.getCell("A3").value === "A", p2 ? String(p2.getCell("A3").value) : "no sheet");
}

// =============================================================================
// buildSummary / readLigationLayout / readPrimerLog
// =============================================================================
{
  // buildSummary with mixed rows
  const ligationRows = [
    { Name: "JOB-001", BBID: "B1", Vector: "pUC19", SourceFile: "lig.xlsx" },
    { Name: "CK+", BBID: "", Vector: "", SourceFile: "lig.xlsx" },
    { Name: "CK-", BBID: "", Vector: "", SourceFile: "lig.xlsx" },
    { Name: "JOB-002", BBID: "B2", Vector: "pET28", SourceFile: "lig.xlsx" },
    { Name: "", BBID: "", Vector: "", SourceFile: "lig.xlsx" }, // dropped: empty Name
  ];
  const primerMap = {
    "JOB-001": "M13F",
    "JOB-002": "T7",
  };
  const { rows, warnings } = buildSummary(ligationRows, primerMap);
  check("buildSummary: drops empty Name", rows.length === 2);
  check("buildSummary: drops CK controls", rows.every((r) => !r["Work No."].startsWith("CK")));
  // The Python renames the "Name" column to the canonical "Work No."
  // (ColonyPCR_layout_app.py:814) as part of the Oct 2026 naming standard.
  check("buildSummary: renames Name -> Work No.", rows[0]["Work No."] === "JOB-001");
  check("buildSummary: warns about CK filter", warnings.some((w) => w.includes("CK")));
  check("buildSummary: joins primers", rows[0].Primers === "M13F");
}

{
  // uniqueJobDetails
  const rows = [
    { "Work No.": "A", SourceFile: "f1.xlsx" },
    { "Work No.": "A", SourceFile: "f1.xlsx" }, // dup
    { "Work No.": "A", SourceFile: "f2.xlsx" }, // same Job, different source
    { "Work No.": "B", SourceFile: "f1.xlsx" },
  ];
  const u = uniqueJobDetails(rows);
  check("uniqueJobDetails: dedupes (job+source)", u.length === 3);
}

console.log(`\n${failed === 0 ? "All tests passed" : failed + " test(s) failed"}.`);
process.exit(failed === 0 ? 0 : 1);
