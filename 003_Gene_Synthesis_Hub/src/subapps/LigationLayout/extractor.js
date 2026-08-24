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
  const vectorSheet = wb.Sheets["Vector"];
  if (vectorSheet) {
    const aoa = XLSX.utils.sheet_to_json(vectorSheet, { header: 1, blankrows: false, raw: false });
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
      const sizeNum = Number(rawSize);
      if (Number.isFinite(sizeNum)) {
        result.length[vname] = sizeNum;
      }
    }
  }

  // --- Digested_Vectors sheet (cols A=Box, B=Name, C=Enzymes, D=Lot, E=Conc, F=Length) ---
  const digSheet = wb.Sheets["Digested_Vectors"];
  if (digSheet) {
    const aoa = XLSX.utils.sheet_to_json(digSheet, { header: 1, blankrows: false, raw: false });
    for (let i = 1; i < aoa.length; i++) {
      const r = aoa[i] || [];
      const rawName = r[1];
      if (!rawName) continue;
      const vectorName = String(rawName).trim();
      const enzyme = r[2] != null ? String(r[2]).trim() : "";
      const box = r[0] != null ? String(r[0]).trim() : "";
      const lot = r[3] != null ? String(r[3]).trim() : "";
      const concNum = Number(r[4]);
      result.digested[`${vectorName}\0${enzyme}`] = {
        lot,
        box_position: box,
        concentration: Number.isFinite(concNum) ? concNum : null,
      };
      // Overwrite length with the lot-specific length if present.
      const lenNum = Number(r[5]);
      if (Number.isFinite(lenNum)) result.length[vectorName] = lenNum;
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
 * Caller must prompt for manual entries via the modal, then call
 * `applyManualEntries(extractionResult, manualResults)` to get the
 * final rows.
 */
export function extractJobLogInfo(arrayBuffer, jobIds) {
  const wb = XLSX.read(arrayBuffer, { type: "array" });
  const sheet = wb.Sheets["Initiated"];
  if (!sheet) throw new Error("Sheet 'Initiated' not found in Job Log");
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, raw: false });

  // First row is the header. Build a column-index map from header names.
  const headers = (aoa[0] || []).map((h) => String(h || "").trim());
  const col = (name) => headers.indexOf(name);
  const COL_JOB_ID = col("Work No.");
  const COL_BBID = col("BBI ID");
  const COL_VECTOR = col("Vector");
  const COL_ENZYME = col("Cloning Site");
  const COL_RESISTANCE = col("Resistance");
  const COL_LENGTH = col("Length (bp)");

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
        // Emit CK- for the previous group
        out.push(buildControlRow(currentGroup.rows[0], "-"));
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
    out.push(buildControlRow(currentGroup.rows[0], "-"));
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

function buildControlRow(templateRow, prefix) {
  return {
    job_id: `CK${prefix}-${templateRow.vector}-${templateRow.enzyme}`,
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
 * Read fragments file, pick relevant sheets (current/previous month
 * prefix + the special "PCR Fragments" sheet), consolidate them.
 *
 * Returns: { rows: [{ sheetName, position, geneName, purityPass, insertLength, concentration? }] }
 */
export function extractFragments(arrayBuffer, sheetPrefixes = generateSheetPrefixes()) {
  const wb = XLSX.read(arrayBuffer, { type: "array" });
  const allSheets = wb.SheetNames;
  const out = [];

  // Special "PCR Fragments" sheet has priority.
  if (allSheets.includes("PCR Fragments")) {
    const sheet = wb.Sheets["PCR Fragments"];
    const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, raw: false });
    for (let i = 1; i < aoa.length; i++) {
      const r = aoa[i] || [];
      if (r[1] == null) continue; // Gene Name in column B (index 1)
      out.push({
        sheetName: "PCR Fragments",
        position: r[0] != null ? String(r[0]) : "",
        geneName: String(r[1]),
        purityPass: r[3] != null ? String(r[3]) : "",
        yieldPass: r[4] != null ? String(r[4]) : "",
        insertLength: 0, // computed from Sequence column if present
        concentration: r[6] != null ? Number(r[6]) : null,
      });
    }
  }

  // Monthly sheets
  const monthlySheets = allSheets
    .filter((name) => sheetPrefixes.some((p) => name.startsWith(p)))
    .sort()
    .reverse(); // newest first
  for (const sheetName of monthlySheets) {
    const sheet = wb.Sheets[sheetName];
    const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, raw: false });
    // Build column map from header row
    const headers = (aoa[0] || []).map((h) => String(h || "").trim());
    const colPos = headers.indexOf("Position");
    const colGene = headers.indexOf("Gene Name");
    const colPurity = headers.indexOf("Purity Pass");
    const colYield = headers.indexOf("Yield Pass");
    const colSeq = headers.indexOf("Sequence");
    for (let i = 1; i < aoa.length; i++) {
      const r = aoa[i] || [];
      if (r[colGene] == null) continue;
      const seq = colSeq >= 0 && r[colSeq] != null ? String(r[colSeq]) : "";
      out.push({
        sheetName,
        position: colPos >= 0 && r[colPos] != null ? String(r[colPos]) : "",
        geneName: String(r[colGene]),
        purityPass: colPurity >= 0 && r[colPurity] != null ? String(r[colPurity]) : "",
        yieldPass: colYield >= 0 && r[colYield] != null ? String(r[colYield]) : "",
        insertLength: seq ? seq.length : 0,
        concentration: null, // monthly sheets don't carry concentration
      });
    }
  }

  return out;
}

export function getDefaultHost() { return DEFAULT_HOST; }
export function getDefaultTemp() { return DEFAULT_TEMP; }
export function getVectorDbFallbackLength() { return VECTOR_DB_FALLBACK_LENGTH; }
