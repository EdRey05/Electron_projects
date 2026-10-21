/**
 * Ligation Layout — data extraction.
 *
 * Mirrors the data-loading sections of `ligation_layout_app.py`:
 *   - `extractVectorDbLookups` reads the Vector Database (.xlsx) and
 *     builds 3 lookup maps (resistance, length, digested vectors).
 *   - `extractJobLogInfo` reads the Job Log (sheet "Initiated") and
 *     returns the list of layout rows + jobs that need manual vector
 *     entry + jobs missing from the log.
 *   - `extractFragments` reads the Fragments file, picks sheets that
 *     match the current or previous month prefix (and the special
 *     "PCR Fragments" sheet), and consolidates them.
 *   - `generateSheetPrefixes` returns the [current, previous] month
 *     prefixes used for sheet matching (e.g. ["T07", "T06"]).
 *   - `generateOutputFilename` returns the suggested output filename.
 *
 * All functions are pure: input is parsed-workbook data (ArrayBuffer from
 * the renderer, already loaded via hub:readBinaryFile), output is plain
 * JS data.
 */

import * as XLSX from "xlsx";
import { buildHeaderMap, resolveColumn, resolveColumns, columnResolutionLog } from "../../ui/columns.js";

const DEFAULT_HOST = "TOP10";
const DEFAULT_TEMP = "37C";
const VECTOR_DB_FALLBACK_LENGTH = 3000; // from _write_fragments_to_layout

/**
 * Compute [current_month, previous_month] sheet name prefixes.
 * Mirrors `base_year = 2025, base_char_code = ord("T")`, year_char is
 * "T" + (year - 2025). E.g. 2026 -> "U", 2027 -> "V".
 */
export function generateSheetPrefixes(date = new Date()) {
  return [
    generateSheetPrefix(date),
    generateSheetPrefix(addMonths(date, -1)),
  ];
}

export function generateSheetPrefix(date) {
  const baseYear = 2025;
  const baseCharCode = "T".charCodeAt(0);
  const yearChar = String.fromCharCode(baseCharCode + (date.getFullYear() - baseYear));
  const monthStr = String(date.getMonth() + 1).padStart(2, "0");
  return `${yearChar}${monthStr}`;
}

function addMonths(date, delta) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + delta);
  return d;
}

/**
 * Build the suggested output filename.
 * Mirrors: `chr(ord("T") + (today.year - 2025))` + `today.strftime("%m%d")` + "-Ligation-FL.xlsx"
 * E.g. for 2026-08-23: "U0823-Ligation-FL.xlsx".
 */
export function generateOutputFilename(date = new Date()) {
  const baseYear = 2025;
  const baseCharCode = "T".charCodeAt(0);
  const yearChar = String.fromCharCode(baseCharCode + (date.getFullYear() - baseYear));
  const monthStr = String(date.getMonth() + 1).padStart(2, "0");
  const dayStr = String(date.getDate()).padStart(2, "0");
  return `${yearChar}${monthStr}${dayStr}-Ligation-FL.xlsx`;
}

/**
 * Extract vector DB lookups. Returns { resistance, length, digested }.
 *
 * resistance: { vectorName -> "Amp" | ... }
 * length:     { vectorName -> basePairLength (float) }
 * digested:   { (vectorName, enzyme) -> { lot, box_position, concentration } }
 */
export function extractVectorDbLookups(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: "array" });
  const result = {
    resistance: {},
    length: {},
    digested: {},
  };

  // --- Vector sheet (cols A=Name, B=Size, C=Resistance) ---
  // `raw: true` so numeric cells stay NUMBERS. The Python reads the sheet
  // with openpyxl's `iter_rows(values_only=True)` — raw values, no display
  // formatting. With `raw: false` a size of 2710 formatted as "#,##0" comes
  // back as the string "2,710", `Number("2,710")` is NaN, and the vector is
  // silently DROPPED from the length map.
  const vectorSheet = wb.Sheets["Vector"];
  if (vectorSheet) {
    const aoa = XLSX.utils.sheet_to_json(vectorSheet, { header: 1, blankrows: false, raw: true });
    for (let i = 1; i < aoa.length; i++) {
      const r = aoa[i] || [];
      const rawVname = r[0];
      if (!rawVname) continue;
      const vname = String(rawVname).trim();

      // Resistance
      const rawResist = r[2];
      if (rawResist != null) {
        result.resistance[vname] = String(rawResist).trim();
      }
      // Length
      const rawSize = r[1];
      if (rawSize != null && rawSize !== "") {
        const sizeNum = Number(rawSize);
        if (Number.isFinite(sizeNum)) {
          result.length[vname] = sizeNum;
        }
      }
    }
  }

  // --- Digested_Vectors sheet (cols A=Box, B=Name, C=Enzymes, D=Lot, E=Conc, F=Length) ---
  const digSheet = wb.Sheets["Digested_Vectors"];
  if (digSheet) {
    const aoa = XLSX.utils.sheet_to_json(digSheet, { header: 1, blankrows: false, raw: true });
    for (let i = 1; i < aoa.length; i++) {
      const r = aoa[i] || [];
      const rawName = r[1];
      if (!rawName) continue;
      const vectorName = String(rawName).trim();
      const enzyme = r[2] != null ? String(r[2]).trim() : "";
      const box = r[0] != null ? String(r[0]).trim() : "";
      const lot = r[3] != null ? String(r[3]).trim() : "";
      const rawConc = r[4];
      let concNum = NaN;
      if (rawConc != null && rawConc !== "") {
        const n = Number(rawConc);
        if (Number.isFinite(n)) concNum = n;
      }
      result.digested[`${vectorName}\0${enzyme}`] = {
        lot,
        box_position: box,
        concentration: Number.isFinite(concNum) ? concNum : null,
      };
      // Overwrite length with the lot-specific length if present.
      //
      // Guard against a BLANK cell: `Number("")` is 0, and 0 IS finite, so
      // a naive check would write a 0 length and DESTROY the vector's true
      // size (5 of the 83 rows in the real Vector_database.xlsx have a blank
      // "Vector length" cell). The Python reads the cell as None there and
      // leaves the previous length alone. We only override when the cell
      // actually holds a number.
      const rawLen = r[5];
      if (rawLen != null && rawLen !== "") {
        const lenNum = Number(rawLen);
        if (Number.isFinite(lenNum) && lenNum > 0) {
          result.length[vectorName] = lenNum;
        }
      }
    }
  }

  return result;
}

/**
 * Extract job info from the Job Log (sheet "Initiated"). Returns:
 *   {
 *     rows: [ { job_id, bbid, vector, enzyme, length, resistance }, ... ],
 *     missing_from_log: [ jobIds that were provided but not in the log ],
 *     jobs_needing_manual_entry: [ jobIds that exist but have placeholder vector ],
 *   }
 *
 * Column resolution: the Python source reads the Job Log with pandas and
 * names the columns directly ("Work No.", "BBI ID", "Vector", "Cloning
 * Site", "Resistance", "Length (bp)"). We resolve them the same way, but
 * tolerate the legacy spellings and fall back to the historic positions so
 * an older workbook copy still loads.
 *
 * Caller must prompt for manual entries via the modal, then call
 * `applyManualEntries(extractionResult, manualResults)` to get the
 * final rows.
 */
export function extractJobLogInfo(arrayBuffer, jobIds) {
  const wb = XLSX.read(arrayBuffer, { type: "array" });
  const sheet = wb.Sheets["Initiated"];
  if (!sheet) throw new Error("Sheet 'Initiated' not found in Job Log");
  // `raw: true` so numeric cells stay NUMBERS. With `raw: false` a cell
  // formatted as `#,##0` comes back as the string "2,686" and a cell
  // formatted `0.0` as "2686.5" — the Python (pandas) yields the number
  // 2686 / 2686.5, and the layout's Length (bp) column is then written as
  // a text cell instead of a number.
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, raw: true });

  // First row is the header. Build a column-index map from header names.
  const headers = (aoa[0] || []).map((h) => (h == null ? "" : String(h)));
  const headerMap = buildHeaderMap(headers);
  const find = (candidates) => {
    for (const c of candidates) {
      if (c in headerMap) return headerMap[c];
    }
    return null;
  };
  // Historic positional fallbacks: Work No.=A(0), BBI ID=B(1), Vector=C(2),
  // Cloning Site=D(3), Resistance=E(4), Length (bp)=F(5).
  const COL_JOB_ID = find(["work no.", "jobid", "job id", "job_id"]) ?? 0;
  const COL_BBID = find(["bbi id", "bbid"]) ?? 1;
  const COL_VECTOR = find(["vector"]) ?? 2;
  const COL_ENZYME = find(["cloning site", "cloningsite", "enzyme", "enzymes"]) ?? 3;
  const COL_RESISTANCE = find(["resistance", "antibiotic"]) ?? 4;
  const COL_LENGTH = find(["length (bp)", "length"]) ?? 5;

  // Provenance report: which path fired for each column (name vs fixed
  // fallback), using the shared helper so the wording matches the rest of
  // the hub.
  const resolution = resolveColumns(headers, [
    { key: "workNo", label: "Work No.", candidates: ["Work No.", "JobID", "Job ID", "Job_ID"], fallback: 0 },
    { key: "bbiId", label: "BBI ID", candidates: ["BBI ID", "BBID"], fallback: 1 },
    { key: "vector", label: "Vector", candidates: ["Vector"], fallback: 2 },
    { key: "cloningSite", label: "Cloning Site", candidates: ["Cloning Site", "CloningSite", "Enzyme", "Enzymes"], fallback: 3 },
    { key: "resistance", label: "Resistance", candidates: ["Resistance", "Antibiotic"], fallback: 4 },
    { key: "length", label: "Length (bp)", candidates: ["Length (bp)", "Length"], fallback: 5 },
  ]);
  const resolutionLog = columnResolutionLog("Initiated", resolution);

  const jobRows = {};
  const missing_from_log = [];
  const jobs_needing_manual_entry = [];

  for (let i = 1; i < aoa.length; i++) {
    const r = aoa[i] || [];
    const jobIdVal = r[COL_JOB_ID];
    if (jobIdVal == null) continue;
    const jobId = String(jobIdVal).trim();
    if (!jobId || !jobIds.includes(jobId)) continue;
    const data = {
      job_id: jobId,
      bbid: r[COL_BBID] != null ? String(r[COL_BBID]).trim() : "",
      vector: r[COL_VECTOR] != null ? String(r[COL_VECTOR]).trim() : "",
      enzyme: r[COL_ENZYME] != null ? String(r[COL_ENZYME]).trim() : "",
      length: r[COL_LENGTH] != null ? r[COL_LENGTH] : "",
      resistance: r[COL_RESISTANCE] != null ? String(r[COL_RESISTANCE]).trim() : "",
    };
    jobRows[jobId] = data;
    if (data.vector === "DNA Fragment - No Vector") {
      jobs_needing_manual_entry.push(jobId);
    }
  }

  for (const jid of jobIds) {
    if (!jobRows[jid]) missing_from_log.push(jid);
  }

  return {
    rows: jobRows,
    missing_from_log,
    jobs_needing_manual_entry,
    columns: { COL_JOB_ID, COL_BBID, COL_VECTOR, COL_ENZYME, COL_RESISTANCE, COL_LENGTH },
    resolutionLog,
  };
}

/**
 * Apply manual vector entry results on top of an `extractJobLogInfo`
 * result. Returns the rows in display order.
 *
 * The user provides manual_results = { jobId: { vector, enzyme, resistance } }
 * for each missing-from-log or placeholder job.
 */
export function applyManualEntries(jobExtraction, manualResults = {}) {
  const { rows, missing_from_log } = jobExtraction;
  const finalRows = [];

  // Process every requested job ID (in the same order the user gave).
  for (const jobId of jobExtraction.jobs_needing_manual_entry.concat(missing_from_log)) {
    const existing = rows[jobId] || { job_id: jobId, bbid: "", vector: "", enzyme: "", length: "", resistance: "" };
    const manual = manualResults[jobId];
    if (!manual) continue; // user cancelled this one
    finalRows.push({
      job_id: jobId,
      bbid: existing.bbid || "",
      vector: manual.vector,
      enzyme: manual.enzyme,
      length: existing.length || "",
      resistance: manual.resistance,
      is_manual: true,
    });
  }

  // Add found jobs that already had real vectors.
  for (const jobId of Object.keys(rows)) {
    const r = rows[jobId];
    if (r.vector && r.vector !== "DNA Fragment - No Vector") {
      finalRows.push({
        job_id: jobId,
        bbid: r.bbid,
        vector: r.vector,
        enzyme: r.enzyme,
        length: r.length,
        resistance: r.resistance,
        is_manual: false,
      });
    }
  }

  // Sort by (vector, enzyme, job_id)
  finalRows.sort((a, b) => {
    const va = String(a.vector);
    const vb = String(b.vector);
    if (va !== vb) return va < vb ? -1 : 1;
    const ea = String(a.enzyme);
    const eb = String(b.enzyme);
    if (ea !== eb) return ea < eb ? -1 : 1;
    return String(a.job_id) < String(b.job_id) ? -1 : 1;
  });

  return finalRows;
}

/**
 * Group rows by (vector, enzyme) and insert a negative control (CK-...)
 * after each group. Also append a positive control (CK+pUC19) at the end.
 * Returns the ordered list of layout rows (each with host + temperature
 * fields populated using default or special conditions).
 */
export function buildLayoutRowsWithControls(finalRows, specialConditions = {}) {
  // Group by (vector, enzyme), preserving order.
  const out = [];
  let currentGroup = null;
  for (const row of finalRows) {
    const key = `${row.vector}\0${row.enzyme}`;
    if (!currentGroup || currentGroup.key !== key) {
      if (currentGroup) {
        // Emit the negative control for the previous group
        out.push(buildNegativeControlRow(currentGroup.rows[0]));
      }
      currentGroup = { key, rows: [] };
    }
    // Add host + temperature based on special conditions or defaults.
    const cond = specialConditions[row.job_id];
    out.push({
      ...row,
      host: cond?.host || DEFAULT_HOST,
      temperature: cond?.temperature || DEFAULT_TEMP,
    });
    currentGroup.rows.push(row);
  }
  if (currentGroup) {
    out.push(buildNegativeControlRow(currentGroup.rows[0]));
  }
  // Positive control at end
  out.push({
    job_id: "CK+pUC19",
    bbid: "",
    vector: "pUC19",
    enzyme: "",
    length: "",
    resistance: "Amp",
    host: DEFAULT_HOST,
    temperature: DEFAULT_TEMP,
  });
  return out;
}

/**
 * Build the NEGATIVE control row for a (vector, enzyme) group.
 *
 * The Python (`ligation_layout_app.py:1725-1734`) writes the Work No. as
 *   f"CK-{vector}-{cloning_site}"   ->   "CK-pUC19-EcoRI"
 * with a SINGLE hyphen. The old React template
 * (`CK${prefix}-${vector}-${enzyme}` with prefix="-") produced
 * "CK--pUC19-EcoRI" — a doubled hyphen that does not match the Python's
 * output value. Consumers that pattern-match "CK" (Colony PCR Layout drops
 * control rows via `Name.startsWith("CK")`, and the Python's own
 * `work_no.startswith("CK-")` control check) still work, but the Work No.
 * written into the Layout sheet was wrong.
 */
function buildNegativeControlRow(templateRow) {
  return {
    job_id: `CK-${templateRow.vector}-${templateRow.enzyme}`,
    bbid: "",
    vector: templateRow.vector,
    enzyme: templateRow.enzyme,
    length: "",
    resistance: templateRow.resistance,
    host: DEFAULT_HOST,
    temperature: DEFAULT_TEMP,
  };
}

/**
 * Fragment column resolution.
 *
 * The Python reads the fragments workbook with pandas (`read_excel`), so
 * the data columns are addressed BY NAME ("Position", "Gene Name",
 * "Purity Pass", "Yield Pass", "Sequence"). The one exception is the
 * "PCR Fragments" sheet's Concentration, which the Python takes
 * positionally (`df_pcr_filtered.iloc[:, 6]`).
 *
 * We resolve each column by header name first (whitespace collapsed,
 * lowercased — see `src/ui/columns.js`) and fall back to the historic
 * positional index when the header is not present. "Sequence" has NO
 * positional fallback: without it the Python's else-branch sets
 * "Insert Length" to 0 for every row.
 */
const FRAGMENT_COLUMNS = {
  position: { candidates: ["Position"], fallback: 0 },
  geneName: { candidates: ["Gene Name", "GeneName"], fallback: 1 },
  purityPass: { candidates: ["Purity Pass", "PurityPass"], fallback: 3 },
  yieldPass: { candidates: ["Yield Pass", "YieldPass"], fallback: 4 },
  sequence: { candidates: ["Sequence"], fallback: -1 },
  concentration: { candidates: ["Concentration"], fallback: 6 },
};

/**
 * Resolve the fragment columns of one sheet.
 * Returns { position, geneName, purityPass, yieldPass, sequence,
 *           concentration, <key>ByName }.
 */
function resolveFragmentColumns(headers) {
  const headerMap = buildHeaderMap(headers);
  const out = {};
  for (const [key, spec] of Object.entries(FRAGMENT_COLUMNS)) {
    const r = resolveColumn(headerMap, spec.candidates, spec.fallback);
    out[key] = r.idx;
    out[`${key}ByName`] = r.byName;
  }
  return out;
}

/**
 * Turn one sheet row into a fragment row, or null when the row has no
 * Gene Name (the Python's `dropna(subset=["Gene Name"])`).
 */
function readFragmentRow(r, cols, sheetName) {
  const geneCell = cols.geneName >= 0 ? r[cols.geneName] : null;
  // pandas' `dropna(subset=["Gene Name"])` treats an EMPTY STRING as NA
  // too ("" is in pandas' default NA list), so an empty cell drops the
  // row exactly like a missing one.
  if (geneCell == null || geneCell === "") return null;

  // Insert Length is the LENGTH OF THE SEQUENCE STRING — the Python does
  //   df["Insert Length"] = df["Sequence"].fillna("").astype(str).str.len()
  // and then drops the Sequence column. A missing Sequence column (or a
  // missing cell) yields 0.
  const seqCell = cols.sequence >= 0 ? r[cols.sequence] : null;
  const seq = seqCell != null ? String(seqCell) : "";

  let concentration = null;
  if (cols.concentration >= 0) {
    const rawConc = r[cols.concentration];
    if (rawConc != null && rawConc !== "") {
      const n = Number(rawConc);
      if (Number.isFinite(n)) concentration = n;
    }
  }

  return {
    sheetName,
    position: cols.position >= 0 && r[cols.position] != null ? String(r[cols.position]) : "",
    geneName: String(geneCell),
    purityPass: cols.purityPass >= 0 && r[cols.purityPass] != null ? String(r[cols.purityPass]) : "",
    yieldPass: cols.yieldPass >= 0 && r[cols.yieldPass] != null ? String(r[cols.yieldPass]) : "",
    insertLength: seq.length,
    concentration,
  };
}

/**
 * Read fragments file, pick relevant sheets (current/previous month
 * prefix + the special "PCR Fragments" sheet), consolidate them.
 *
 * Returns: { rows: [{ sheetName, position, geneName, purityPass, insertLength, concentration? }] }
 */
export function extractFragments(arrayBuffer, sheetPrefixes = generateSheetPrefixes()) {
  return extractFragmentsWithReport(arrayBuffer, sheetPrefixes).rows;
}

/**
 * Same as `extractFragments`, but also returns the Python's log lines so
 * the UI can show the provenance (which sheets were read, whether the
 * "Sequence" column was found, …).
 *
 * Returns: { rows: [...], logs: [string, ...] }
 */
export function extractFragmentsWithReport(
  arrayBuffer,
  sheetPrefixes = generateSheetPrefixes()
) {
  const wb = XLSX.read(arrayBuffer, { type: "array" });
  const allSheets = wb.SheetNames;
  const out = [];
  const logs = [];
  let anySequenceColumn = false;

  // Special "PCR Fragments" sheet has priority.
  if (allSheets.includes("PCR Fragments")) {
    const sheet = wb.Sheets["PCR Fragments"];
    const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, raw: false });
    const headers = (aoa[0] || []).map((h) => (h == null ? "" : String(h)));
    const cols = resolveFragmentColumns(headers);
    logs.push("    - Checking special sheet 'PCR Fragments'...");
    let pcrCount = 0;
    for (let i = 1; i < aoa.length; i++) {
      const row = readFragmentRow(aoa[i] || [], cols, "PCR Fragments");
      if (!row) continue;
      out.push(row);
      pcrCount++;
    }
    if (cols.sequenceByName) anySequenceColumn = true;
    logs.push(`      > Found ${pcrCount} PCR fragments.`);
  }

  // Monthly sheets
  const monthlySheets = allSheets
    .filter((name) => sheetPrefixes.some((p) => name.startsWith(p)))
    .sort()
    .reverse(); // newest first
  if (monthlySheets.length > 0) {
    logs.push(
      `  > Found ${monthlySheets.length} matching monthly sheets ` +
        `(sorted newest to oldest): [${monthlySheets.join(", ")}]`
    );
  }
  for (const sheetName of monthlySheets) {
    const sheet = wb.Sheets[sheetName];
    const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, raw: false });
    // Build column map from header row
    const headers = (aoa[0] || []).map((h) => (h == null ? "" : String(h)));
    const cols = resolveFragmentColumns(headers);
    if (cols.sequenceByName) anySequenceColumn = true;
    let sheetCount = 0;
    for (let i = 1; i < aoa.length; i++) {
      const row = readFragmentRow(aoa[i] || [], cols, sheetName);
      if (!row) continue;
      // Monthly sheets don't carry a Concentration column (the Python only
      // fills it in for the "PCR Fragments" sheet).
      out.push({ ...row, concentration: null });
      sheetCount++;
    }
    logs.push(`    - Processing sheet '${sheetName}'...`);
    logs.push(`      > Rows with Gene Name: ${sheetCount}`);
  }

  if (anySequenceColumn) {
    logs.push("  > Calculating insert length from 'Sequence' column...");
  } else {
    logs.push(
      "  > WARNING: 'Sequence' column not found. 'Insert Length' will be set to 0."
    );
  }

  return { rows: out, logs };
}

export function getDefaultHost() { return DEFAULT_HOST; }
export function getDefaultTemp() { return DEFAULT_TEMP; }
export function getVectorDbFallbackLength() { return VECTOR_DB_FALLBACK_LENGTH; }
