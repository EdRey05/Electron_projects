// Verification for the 5 behaviour-parity fixes (LIG-04/05/07/08, PRF-01/02/04).
// Runs the real module code against synthetic workbooks.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// Load a module's exports, stubbing its imports the way the existing
// scripts/test-ligation-layout.js does.
function loadExports(srcPath, exportsNeeded, globals = {}) {
  let src = readFileSync(srcPath, "utf8");
  // Strip import statements (single- and multi-line) and export keywords.
  src = src.replace(/^import\s+[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "");
  src = src.replace(/^import\s+["'][^"']+["'];?\s*$/gm, "");
  src = src.replace(/^export /gm, "");
  const names = Object.keys(globals);
  const fn = new Function(
    "globalThis",
    "XLSX",
    ...names,
    src + `\nreturn { ${exportsNeeded.join(", ")} };`
  );
  return fn(globalThis, XLSX, ...names.map((n) => globals[n]));
}

const columns = loadExports(resolve(ROOT, "src/ui/columns.js"), [
  "normHeader",
  "buildHeaderMap",
  "resolveColumn",
  "resolveColumns",
  "columnLetter",
  "columnResolutionLog",
]);

const lig = loadExports(
  resolve(ROOT, "src/subapps/LigationLayout/extractor.js"),
  [
    "buildLayoutRowsWithControls",
    "extractFragments",
    "extractFragmentsWithReport",
    "extractVectorDbLookups",
    "extractJobLogInfo",
  ],
  { ...columns }
);

const pfr = loadExports(
  resolve(ROOT, "src/subapps/PrimerFinder/excelReader.js"),
  ["resolveSheetColumns", "loadPrimerCandidatesFromFile"],
  { ...columns, isRelevantSheet: (n) => /^[STUV]/i.test(n || ""), isValidPrimer: (s) => !!s && s.length >= 10 && s.length <= 100 && /^[ATCGN]+$/.test(s) }
);

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`✓ ${name}`);
  else {
    console.log(`✗ ${name}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

function buildWb(sheets) {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  }
  return XLSX.write(wb, { bookType: "xlsx", type: "array" });
}

// =============================================================================
// BUG 1 (LIG-08): negative control Work No. must be "CK-<vector>-<enzyme>"
// =============================================================================
{
  const rows = [
    { job_id: "JOB-001", bbid: "B1", vector: "pUC19", enzyme: "EcoRI", length: "100", resistance: "Amp" },
    { job_id: "JOB-002", bbid: "B2", vector: "pUC19", enzyme: "EcoRI", length: "100", resistance: "Amp" },
    { job_id: "JOB-003", bbid: "B3", vector: "pET28", enzyme: "BamHI", length: "200", resistance: "Kan" },
  ];
  const layout = lig.buildLayoutRowsWithControls(rows);
  const neg = layout.filter((r) => r.job_id?.startsWith("CK-"));
  check("LIG-08: 2 negative controls emitted", neg.length === 2, JSON.stringify(neg.map(r => r.job_id)));
  check("LIG-08: no doubled hyphen anywhere", !layout.some((r) => String(r.job_id || "").includes("CK--")));
  check("LIG-08: 'CK-pUC19-EcoRI' present", neg.some((r) => r.job_id === "CK-pUC19-EcoRI"), JSON.stringify(neg.map(r => r.job_id)));
  check("LIG-08: 'CK-pET28-BamHI' present", neg.some((r) => r.job_id === "CK-pET28-BamHI"));
  check("LIG-08: positive control still 'CK+pUC19'", layout.some((r) => r.job_id === "CK+pUC19"));
  check("LIG-08: positive control is last", layout[layout.length - 1].job_id === "CK+pUC19");
  check("LIG-08: neg control carries vector/enzyme/resistance",
    neg[0].vector === "pUC19" && neg[0].enzyme === "EcoRI" && neg[0].resistance === "Amp");
  check("LIG-08: neg control host/temp defaults", neg[0].host === "TOP10" && neg[0].temperature === "37C");
}

// =============================================================================
// BUG 2 (LIG-04 + LIG-05): PCR Fragments insertLength = Sequence string length
// =============================================================================
{
  // "PCR Fragments" sheet with a "Sequence" column (the real layout:
  // A=Position, B=Gene Name, C=?, D=Purity Pass, E=Yield Pass, F=Sequence,
  // G=Concentration).
  const buf = buildWb({
    "PCR Fragments": [
      ["Position", "Gene Name", "Notes", "Purity Pass", "Yield Pass", "Sequence", "Concentration"],
      ["P1", "JOB-001", "x", "Pass", "Pass", "ATGCATGCATGCATGC", 50],
      ["P2", "JOB-002", "x", "Pass", "Fail", "GGGGCCCC", 10],
    ],
  });
  const frags = lig.extractFragments(buf, ["U08", "U07"]);
  check("LIG-04: 2 PCR rows extracted", frags.length === 2, JSON.stringify(frags));
  const f1 = frags.find((f) => f.geneName === "JOB-001");
  check("LIG-04: insertLength = Sequence length (16)", f1?.insertLength === 16, `got ${f1?.insertLength}`);
  const f2 = frags.find((f) => f.geneName === "JOB-002");
  check("LIG-04: insertLength = Sequence length (8)", f2?.insertLength === 8, `got ${f2?.insertLength}`);
  check("LIG-05: concentration read from col G (50)", f1?.concentration === 50, `got ${f1?.concentration}`);
  check("LIG-05: purity pass read", f1?.purityPass === "Pass");
  check("LIG-05: yield pass read", f1?.yieldPass === "Pass");
  check("LIG-05: position read", f1?.position === "P1");

  // A "PCR Fragments" sheet with the Sequence column SHIFTED right (a
  // plate-style sheet) must still resolve by header name.
  const shifted = buildWb({
    "PCR Fragments": [
      ["Wells", "Position", "Gene Name", "Purity Pass", "Yield Pass", "Sequence", "Concentration"],
      ["A1", "P1", "JOB-001", "Pass", "Pass", "ATGCATGC", 20],
    ],
  });
  const sf = lig.extractFragments(shifted, ["U08"]);
  check("LIG-04: name resolved by header on shifted sheet", sf[0]?.geneName === "JOB-001", JSON.stringify(sf));
  check("LIG-04: insertLength resolved by header on shifted sheet", sf[0]?.insertLength === 8, `got ${sf[0]?.insertLength}`);

  // No Sequence column at all -> insertLength 0 (the Python's else-branch).
  const noSeq = buildWb({
    "PCR Fragments": [
      ["Position", "Gene Name", "Purity Pass", "Yield Pass", "Concentration"],
      ["P1", "JOB-001", "Pass", "Pass", 50],
    ],
  });
  const nf = lig.extractFragments(noSeq, ["U08"]);
  check("LIG-04: no Sequence column -> insertLength 0", nf[0]?.insertLength === 0, `got ${nf[0]?.insertLength}`);
  const nfReport = lig.extractFragmentsWithReport(noSeq, ["U08"]);
  check("LIG-04: warning logged when Sequence missing",
    nfReport.logs.some((l) => l.includes("'Sequence' column not found")));

  // Monthly sheet: name-resolved Sequence, and concentration stays null.
  const mBuf = buildWb({
    U08: [
      ["Position", "Gene Name", "Purity Pass", "Yield Pass", "Sequence"],
      ["A1", "JOB-001A", "Pass", "Pass", "ATGCATGC"],
      ["A2", "JOB-001B", "Pass", "Pass", "GCATGCAT"],
    ],
  });
  const mf = lig.extractFragments(mBuf, ["U08", "U07"]);
  check("LIG-04: monthly insertLength from Sequence", mf[0]?.insertLength === 8, `got ${mf[0]?.insertLength}`);
  check("LIG-05: monthly concentration stays null", mf[0]?.concentration === null);
}

// =============================================================================
// BUG 3 (LIG-07): Vector DB read with raw values, not display formatting
// =============================================================================
{
  // Build a Vector sheet where the Size cell carries a "#,##0" display
  // format — with raw:false the value comes back as the string "2,710".
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ["Vector Name", "Size", "Resistance", "Sequence"],
    ["pUC19", 2710, "Amp", "ATGC"],
    ["pET28", 5369, "Kan", "ATGC"],
  ]);
  ws["B2"].z = "#,##0";
  ws["B3"].z = "#,##0";
  XLSX.utils.book_append_sheet(wb, ws, "Vector");
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["Box Position", "Vector", "Digestion", "Lot", "Concentration", "Vector length"],
      ["B5", "pUC19", "EcoRI", "L001", 100, ""],
    ]),
    "Digested_Vectors"
  );
  const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });

  // Sanity: raw:false really does produce the "2,710" string.
  const rawFalse = XLSX.utils.sheet_to_json(
    XLSX.read(buf, { type: "array" }).Sheets["Vector"],
    { header: 1, blankrows: false, raw: false }
  );
  check("LIG-07: precondition — raw:false yields '2,710'", rawFalse[1][1] === "2,710", String(rawFalse[1][1]));

  const lookups = lig.extractVectorDbLookups(buf);
  check("LIG-07: pUC19 length present (2710)", lookups.length["pUC19"] === 2710, `got ${lookups.length["pUC19"]}`);
  check("LIG-07: pET28 length present (5369)", lookups.length["pET28"] === 5369, `got ${lookups.length["pET28"]}`);
  check("LIG-07: 2 length entries (not dropped)", Object.keys(lookups.length).length === 2);
  check("LIG-07: resistance still read", lookups.resistance["pUC19"] === "Amp");
  check("LIG-07: digested lookup keyed by vector+enzyme",
    lookups.digested["pUC19\0EcoRI"]?.lot === "L001");
  check("LIG-07: concentration read", lookups.digested["pUC19\0EcoRI"]?.concentration === 100);
  // The blank "Vector length" cell in Digested_Vectors must NOT zero the size.
  check("LIG-07: blank length cell does not zero the vector size", lookups.length["pUC19"] === 2710);
}

// =============================================================================
// BUG 4 (PRF-01): per-sheet name-first column resolution
// =============================================================================
{
  // A plate-order sheet: "Wells" prepended, so Oligo Name is col B and
  // Sequence (5' to 3') is col C. Header lives on Excel row 34.
  const rows = [];
  for (let i = 0; i < 33; i++) rows.push([`filler ${i}`]);
  rows.push(["Wells", "Oligo Name", "Sequence (5' to 3')"]); // Excel row 34
  rows.push(["A1", "PRIMER-1", "ATGCATGCATGCATGC"]); // Excel row 35
  rows.push(["A2", "PRIMER-2", "GGGGCCCCATGCAT"]); // Excel row 36
  const buf = buildWb({ U0910: rows });

  const res = pfr.resolveSheetColumns(
    XLSX.read(buf, { type: "array" }).Sheets["U0910"],
    "U0910"
  );
  check("PRF-01: name column resolved to B (index 1)", res.nameIdx === 1, `got ${res.nameIdx}`);
  check("PRF-01: sequence column resolved to C (index 2)", res.seqIdx === 2, `got ${res.seqIdx}`);
  check("PRF-01: name path fired", res.byName === true);
  check("PRF-01: log line names both columns",
    res.log.includes("columns resolved by name") && res.log.includes("name=B") && res.log.includes("sequence=C"),
    res.log);

  // End-to-end through the loader: the well IDs must NOT become names.
  const fakeFile = {
    arrayBuffer: async () => {
      const b = new Uint8Array(buf);
      return b.buffer;
    },
  };
  const loaded = await pfr.loadPrimerCandidatesFromFile(fakeFile);
  check("PRF-01: 2 candidates read", loaded.candidates.length === 2, JSON.stringify(loaded.candidates));
  check("PRF-01: name is the oligo name, not the well ID",
    loaded.candidates[0]?.name === "PRIMER-1", `got ${loaded.candidates[0]?.name}`);
  check("PRF-01: sequence is the oligo sequence, not the well number",
    loaded.candidates[0]?.sequence === "ATGCATGCATGCATGC", `got ${loaded.candidates[0]?.sequence}`);
  check("PRF-01: per-sheet report returned", loaded.resolutions?.length === 1);
  check("PRF-01: report says the name path fired", loaded.resolutions?.[0]?.byName === true);

  // A sheet WITHOUT the formatted header row falls back to A:B.
  const legacyRows = [];
  for (let i = 0; i < 40; i++) legacyRows.push(i === 34 ? ["PRIMER-X", "ATGCATGCAT"] : ["x"]);
  const legacyBuf = buildWb({ S01: legacyRows });
  const legacyRes = pfr.resolveSheetColumns(
    XLSX.read(legacyBuf, { type: "array" }).Sheets["S01"],
    "S01"
  );
  check("PRF-01: legacy sheet falls back to A/B", legacyRes.nameIdx === 0 && legacyRes.seqIdx === 1);
  check("PRF-01: legacy sheet reports the fallback", legacyRes.byName === false);
  check("PRF-01: legacy log line mentions fixed columns",
    legacyRes.log.includes("falling back to fixed columns"), legacyRes.log);

  // A header with only the name token (no sequence token) must fall back
  // to A:B entirely — the Python requires BOTH to resolve.
  const halfBuf = buildWb({
    T01: (() => {
      const r = [];
      for (let i = 0; i < 33; i++) r.push(["filler"]);
      r.push(["Oligo Name", "Notes"]);
      r.push(["PRIMER-Q", "ATGCATGCAT"]);
      return r;
    })(),
  });
  const halfRes = pfr.resolveSheetColumns(
    XLSX.read(halfBuf, { type: "array" }).Sheets["T01"],
    "T01"
  );
  check("PRF-01: partial header falls back to A/B", halfRes.byName === false && halfRes.nameIdx === 0 && halfRes.seqIdx === 1);

  // The header token match must tolerate an embedded line break
  // ("Oligo \r\nName") — the live workbooks carry that.
  const crlfBuf = buildWb({
    V01: (() => {
      const r = [];
      for (let i = 0; i < 33; i++) r.push(["filler"]);
      r.push(["Oligo \r\nName", "Sequence (5' to 3')"]);
      r.push(["PRIMER-R", "ATGCATGCAT"]);
      return r;
    })(),
  });
  const crlfRes = pfr.resolveSheetColumns(
    XLSX.read(crlfBuf, { type: "array" }).Sheets["V01"],
    "V01"
  );
  check("PRF-01: embedded line break in header still resolves", crlfRes.byName === true, crlfRes.log);
}

// =============================================================================
// BUG 5 (PRF-02 + PRF-04): resolution report is returned; "no sheets" vs
// "no primers" are distinct.
// =============================================================================
{
  const rows = [];
  for (let i = 0; i < 33; i++) rows.push(["filler"]);
  rows.push(["Oligo Name", "Sequence (5' to 3')"]);
  rows.push(["PRIMER-1", "ATGCATGCATGCATGC"]);
  const buf = buildWb({ U0910: rows });
  const fakeFile = { arrayBuffer: async () => new Uint8Array(buf).buffer };
  const loaded = await pfr.loadPrimerCandidatesFromFile(fakeFile);
  check("PRF-02: logs array returned", Array.isArray(loaded.logs) && loaded.logs.length === 1);
  check("PRF-02: log line uses the house style",
    loaded.logs[0] === "'U0910': columns resolved by name (name=A, sequence=B)", loaded.logs[0]);
  check("PRF-04: sheetsScanned lists the sheet", loaded.sheetsScanned.length === 1);

  // A workbook with NO S/T/U/V sheet -> sheetsScanned empty.
  const noSheetsBuf = buildWb({ "input addon": [["Work No."], ["JOB-1"]] });
  const noSheets = await pfr.loadPrimerCandidatesFromFile({
    arrayBuffer: async () => new Uint8Array(noSheetsBuf).buffer,
  });
  check("PRF-04: no S/T/U/V sheet -> sheetsScanned empty", noSheets.sheetsScanned.length === 0);
  check("PRF-04: no S/T/U/V sheet -> no candidates", noSheets.candidates.length === 0);
  check("PRF-04: no S/T/U/V sheet -> no resolution lines", noSheets.logs.length === 0);

  // A sheet present but with no valid primer rows -> sheets present, no primers.
  const emptyBuf = buildWb({
    U0910: (() => {
      const r = [];
      for (let i = 0; i < 33; i++) r.push(["filler"]);
      r.push(["Oligo Name", "Sequence (5' to 3')"]);
      r.push(["PRIMER-1", "not-a-sequence"]);
      return r;
    })(),
  });
  const empty = await pfr.loadPrimerCandidatesFromFile({
    arrayBuffer: async () => new Uint8Array(emptyBuf).buffer,
  });
  check("PRF-04: sheet present, no valid primers", empty.sheetsScanned.length === 1 && empty.candidates.length === 0);
}

console.log(`\n${failed === 0 ? "All tests passed" : failed + " test(s) failed"}.`);
process.exit(failed === 0 ? 0 : 1);
