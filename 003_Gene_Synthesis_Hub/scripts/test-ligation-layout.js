// Smoke test for the Ligation Layout pure logic.
// Exercises the extractor, matcher, and workbook builder without I/O.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function loadExports(srcPath, exportsNeeded) {
  let src = readFileSync(srcPath, "utf8");
  src = src.replace(/^import .*?from\s+["'][^"']+["'];?\s*$/gm, "");
  src = src.replace(/^export /gm, "");
  const fn = new Function(
    "globalThis", "XLSX",
    src + `\nreturn { ${exportsNeeded.join(", ")} };`
  );
  return fn(globalThis, XLSX);
}
globalThis.XLSX = XLSX;

const {
  generateSheetPrefixes,
  generateOutputFilename,
  applyManualEntries,
  buildLayoutRowsWithControls,
  extractFragments,
  extractVectorDbLookups,
  extractJobLogInfo,
  getVectorDbFallbackLength,
} = loadExports(
  resolve(ROOT, "src/subapps/LigationLayout/extractor.js"),
  [
    "generateSheetPrefixes",
    "generateOutputFilename",
    "applyManualEntries",
    "buildLayoutRowsWithControls",
    "extractFragments",
    "extractVectorDbLookups",
    "extractJobLogInfo",
    "getVectorDbFallbackLength",
  ]
);
const { matchFragmentsToJobs } = loadExports(
  resolve(ROOT, "src/subapps/LigationLayout/matcher.js"),
  ["matchFragmentsToJobs"]
);
const { writeLayoutRows, writeFragmentsToLayout, serializeWorkbook } = loadExports(
  resolve(ROOT, "src/subapps/LigationLayout/workbookBuilder.js"),
  ["writeLayoutRows", "writeFragmentsToLayout", "serializeWorkbook"]
);

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`✓ ${name}`);
  else { console.log(`✗ ${name}${detail ? " — " + detail : ""}`); failed++; }
}

// =============================================================================
// Helper: build a tiny in-memory xlsx from a single sheet.
// =============================================================================
function buildSingleSheetXlsx(sheetName, aoa) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { bookType: "xlsx", type: "array" });
}

// =============================================================================
// generateSheetPrefixes / generateOutputFilename
// =============================================================================
{
  const d = new Date("2026-08-23T12:00:00Z");
  check("generateSheetPrefixes: 2 prefixes", generateSheetPrefixes(d).length === 2);
  // 2026 -> "U" (T=84, +1=85=U); 08 = "U08"
  check("generateSheetPrefixes: Aug 2026", generateSheetPrefixes(d)[0] === "U08");
  check("generateOutputFilename: format", generateOutputFilename(d) === "U0823-Ligation-FL.xlsx");
}

// =============================================================================
// extractVectorDbLookups
// =============================================================================
{
  // Build a minimal Vector DB with Vector + Digested_Vectors sheets.
  const vdbBuf = buildSingleSheetXlsx("Vector", [
    ["Vector Name", "Size", "Resistance", "Sequence"],
    ["pUC19", "2686", "Amp", "ATGC..."],
    ["pET28", "5369", "Kan", "ATGC..."],
  ]);
  const lookups = extractVectorDbLookups(vdbBuf);
  check("vdb: resistance lookup size", Object.keys(lookups.resistance).length === 2);
  check("vdb: resistance for pUC19", lookups.resistance["pUC19"] === "Amp");
  check("vdb: length map for pUC19", lookups.length["pUC19"] === 2686);
}

// =============================================================================
// extractJobLogInfo
// =============================================================================
{
  const jlBuf = buildSingleSheetXlsx("Initiated", [
    ["Work No.", "BBI ID", "Vector", "Cloning Site", "Resistance", "Length (bp)"],
    ["JOB-001", "B001", "pUC19", "EcoRI", "Amp", "100"],
    ["JOB-002", "B002", "DNA Fragment - No Vector", "", "", "200"],
    ["JOB-003", "B003", "pET28", "BamHI", "Kan", "300"],
  ]);
  const jobIds = ["JOB-001", "JOB-002", "JOB-003", "JOB-999"];
  const ext = extractJobLogInfo(jlBuf, jobIds);
  check("jl: 3 jobs found in log", Object.keys(ext.rows).length === 3);
  check("jl: JOB-001 found with vector", ext.rows["JOB-001"]?.vector === "pUC19");
  check("jl: JOB-002 flagged for manual", ext.jobs_needing_manual_entry.includes("JOB-002"));
  check("jl: JOB-999 missing from log", ext.missing_from_log.includes("JOB-999"));
  check("jl: JOB-001 not flagged", !ext.jobs_needing_manual_entry.includes("JOB-001"));
}

// =============================================================================
// applyManualEntries + buildLayoutRowsWithControls
// =============================================================================
{
  const jlBuf = buildSingleSheetXlsx("Initiated", [
    ["Work No.", "BBI ID", "Vector", "Cloning Site", "Resistance", "Length (bp)"],
    ["JOB-001", "B001", "pUC19", "EcoRI", "Amp", "100"],
  ]);
  const ext = extractJobLogInfo(jlBuf, ["JOB-001", "JOB-002"]);
  const manual = { "JOB-002": { vector: "pET28", enzyme: "BamHI", resistance: "Kan" } };
  const final = applyManualEntries(ext, manual);
  check("apply: 2 rows", final.length === 2);
  const j002 = final.find((r) => r.job_id === "JOB-002");
  check("apply: JOB-002 has manual vector", j002?.vector === "pET28");
  check("apply: JOB-002 is_manual=true", j002?.is_manual === true);

  // Build layout with controls. JOB-001 (pUC19) and JOB-002 (pET28) are
  // different vectors, so we get 2 groups -> 2 CK- rows. Plus the CK+ row.
  // Total = 2 jobs + 2 CK- + 1 CK+ = 5.
  const layout = buildLayoutRowsWithControls(final);
  check("layout: 5 rows (2 jobs + 2 CK- + 1 CK+)", layout.length === 5);
  const ckp = layout.find((r) => r.job_id === "CK+pUC19");
  check("layout: CK+pUC19 last", ckp != null);
  const ckneg = layout.find((r) => r.job_id?.startsWith("CK-"));
  check("layout: CK- present", ckneg != null);
  check("layout: 2 CK- rows (one per vector)", layout.filter((r) => r.job_id?.startsWith("CK-")).length === 2);

  // Special conditions: override JOB-001 to a different host/temp
  const layout2 = buildLayoutRowsWithControls(final, {
    "JOB-001": { host: "BL21", temperature: "30C" },
  });
  const j001 = layout2.find((r) => r.job_id === "JOB-001");
  check("layout: special conditions applied", j001?.host === "BL21" && j001?.temperature === "30C");
}

// =============================================================================
// extractFragments
// =============================================================================
{
  const fBuf = buildSingleSheetXlsx("U08", [
    ["Position", "Gene Name", "Purity Pass", "Yield Pass", "Sequence"],
    ["A1", "JOB-001A", "Pass", "Pass", "ATGCATGC"],
    ["A2", "JOB-001B", "Pass", "Pass", "GCATGCAT"],
    ["A3", "JOB-002", "Fail", "Pass", "TTTT"],
  ]);
  const prefixes = ["U08", "U07"];
  const frags = extractFragments(fBuf, prefixes);
  check("fragments: 3 rows from U08", frags.length === 3);
  const j001a = frags.find((f) => f.geneName === "JOB-001A");
  check("fragments: insertLength computed from Sequence", j001a?.insertLength === 8);
  check("fragments: sheetName tagged", j001a?.sheetName === "U08");
}

// =============================================================================
// matchFragmentsToJobs
// =============================================================================
{
  // Monthly fragments: JOB-001 has A, B; JOB-002 has just JOB-002 (no A/B).
  const fragments = [
    { sheetName: "U08", position: "A1", geneName: "JOB-001A", purityPass: "Pass", insertLength: 100 },
    { sheetName: "U08", position: "A2", geneName: "JOB-001B", purityPass: "Pass", insertLength: 200 },
    { sheetName: "U08", position: "A3", geneName: "JOB-002",   purityPass: "Pass", insertLength: 300 },
    { sheetName: "U08", position: "A4", geneName: "JOB-003A", purityPass: "Fail", insertLength: 999 },
  ];
  const layout = [
    { job_id: "JOB-001" },
    { job_id: "JOB-002" },
    { job_id: "JOB-003" },
    { job_id: "CK+pUC19" },
  ];
  const matched = matchFragmentsToJobs(layout, fragments);
  check("match: 2 jobs matched (JOB-003 filtered by Purity Fail)", Object.keys(matched).length === 2);
  check("match: JOB-001 has 2 frags (A+B)", matched["JOB-001"].length === 2);
  check("match: JOB-001 frag names correct",
    matched["JOB-001"][0].name === "JOB-001A" && matched["JOB-001"][1].name === "JOB-001B");
  check("match: JOB-002 has 1 frag", matched["JOB-002"].length === 1);
  check("match: JOB-003 skipped (Purity Fail)", matched["JOB-003"] === undefined);
  check("match: CK+pUC19 skipped (control)", !("CK+pUC19" in matched));

  // PCR Fragments priority
  const fragments2 = [
    { sheetName: "PCR Fragments", position: "P1", geneName: "JOB-001", purityPass: "Pass", insertLength: 500, concentration: 50 },
    ...fragments,
  ];
  const matched2 = matchFragmentsToJobs(layout, fragments2);
  // The first fragment is the PCR one (insertLength 500)
  check("match: PCR fragment used", matched2["JOB-001"][0].length === 500);
  check("match: PCR concentration captured", matched2["JOB-001"][0].concentration === 50);
}

// =============================================================================
// writeLayoutRows + writeFragmentsToLayout
// =============================================================================
{
  // Build a minimal template with a "Layout" sheet and Insert 1/2/3 columns.
  const layoutAOA = [
    ["A", "Job ID", "C", "Vector", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "Length", "U Resistance", "V Host", "W Temp", "X", "Insert 1", "Insert 2", "Insert 3"],
    ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
  ];
  const tplBuf = buildSingleSheetXlsx("Layout", layoutAOA);
  const wb = XLSX.read(tplBuf, { type: "array" });

  const lookups = {
    resistance: { "pUC19": "Amp" },
    length: { "pUC19": 2686 },
    digested: { "pUC19\0EcoRI": { lot: "L001", box_position: "B5", concentration: 100 } },
  };
  const layoutRows = [
    { job_id: "JOB-001", bbid: "B001", vector: "pUC19", enzyme: "EcoRI", length: "100", resistance: "Amp", host: "TOP10", temperature: "37C" },
    { job_id: "CK+pUC19", bbid: "", vector: "pUC19", enzyme: "", length: "", resistance: "Amp", host: "TOP10", temperature: "37C" },
  ];
  const { insertColumns } = writeLayoutRows(wb, layoutRows, lookups);
  check("writeLayout: B2 has JOB-001", wb.Sheets["Layout"]["B2"]?.v === "JOB-001");
  check("writeLayout: D2 has pUC19", wb.Sheets["Layout"]["D2"]?.v === "pUC19");
  check("writeLayout: F2 has lot L001", wb.Sheets["Layout"]["F2"]?.v === "L001");
  check("writeLayout: G2 has box B5", wb.Sheets["Layout"]["G2"]?.v === "B5");
  // CEILING(40 / 100 / 0.5) * 0.5 = CEILING(0.8) * 0.5 = 1 * 0.5 = 0.5
  check("writeLayout: H2 volume = 0.5", wb.Sheets["Layout"]["H2"]?.v === 0.5);
  check("writeLayout: U2 has Amp resistance", wb.Sheets["Layout"]["U2"]?.v === "Amp");
  check("writeLayout: Insert 1 col found", "Insert 1" in insertColumns);

  // Write fragments
  const fragmentsToWrite = {
    "JOB-001": [{ name: "JOB-001A", location: "U08-A1", length: 100 }],
  };
  const manualIds = new Set();
  const r = writeFragmentsToLayout(wb, insertColumns, fragmentsToWrite, manualIds, lookups.length);
  check("writeFragments: 1 entry written", r.written.length === 1);
  // In this test layout, "Insert 1" is the 25th header entry -> Excel col Y.
  // So Insert 1 = Y, location = Z (26), volume = AA (27).
  check("writeFragments: Y2 has JOB-001A", wb.Sheets["Layout"]["Y2"]?.v === "JOB-001A");
  check("writeFragments: Z2 has location", wb.Sheets["Layout"]["Z2"]?.v === "U08-A1");
  // (insert_length / vector_length) * 12 = (100 / 2686) * 12 = 0.4468... -> rounded 0.45
  check("writeFragments: AA2 volume computed", Math.abs((wb.Sheets["Layout"]["AA2"]?.v || 0) - 0.45) < 0.01);

  // Serialize
  const bytes = serializeWorkbook(wb);
  check("serializeWorkbook: non-empty bytes", bytes.byteLength > 1000);
}

// =============================================================================
// Vector length fallback
// =============================================================================
{
  check("fallback length = 3000bp", getVectorDbFallbackLength() === 3000);
}

console.log(`\n${failed === 0 ? "All tests passed" : failed + " test(s) failed"}.`);
process.exit(failed === 0 ? 0 : 1);
