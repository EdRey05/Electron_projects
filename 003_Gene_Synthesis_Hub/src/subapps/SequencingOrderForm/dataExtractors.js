/**
 * Pure data extraction for Sequencing Order Form.
 *
 * Mirrors `get_primer_info` + `get_sequence_sample_ID` from the Python
 * source. These are pure functions: input File objects, output plain JS
 * arrays/dicts.
 *
 * Both reads use the Oct 2026 two-step column pass:
 *   1. Resolve the column by header NAME (canonical first, legacy spelling
 *      tolerated), whitespace normalized on BOTH sides.
 *   2. Only when the header row is not recognized, fall back to the historic
 *      fixed positions.
 *
 * The Python logs which path fired; we return the same log lines so the
 * app's log panel shows the resolution provenance.
 */

import * as XLSX from "xlsx";
import { buildHeaderMap, columnLetter } from "../../ui/columns.js";

/**
 * Pulls every primer from the Primer Log's `input addon` sheet for the given
 * Work Nos.
 *
 * Name-first: the Work No. column is resolved by header name, and the
 * primer block starts at the column AFTER the "Amplification primers" group
 * header. Fallback: Work No.=A (index 0), primers from col Q (index 16).
 *
 * Returns: { workNo -> [primer, primer, ...], log: string }
 */
export async function getPrimerInfo(primerLogFile, workNos) {
  const buf = await primerLogFile.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const sheet = wb.Sheets["input addon"];
  if (!sheet) {
    throw new Error("Sheet 'input addon' not found in Primer Log.");
  }
  const workNoSet = new Set(workNos.map((w) => String(w).trim()));
  const primers = Object.create(null);
  for (const w of workNos) primers[String(w).trim()] = [];

  const aoa = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    blankrows: false,
    raw: false,
  });
  const headers = (aoa[0] || []).map((h) => (h == null ? "" : String(h)));
  const headerMap = buildHeaderMap(headers);

  // Work No. column: canonical first, legacy spellings tolerated.
  let workIdx = null;
  for (const cand of ["work no.", "jobid", "job id", "job_id"]) {
    if (cand in headerMap) {
      workIdx = headerMap[cand];
      break;
    }
  }
  // The primer block is the set of individual primer columns that follow the
  // "Amplification primers" group header.
  let ampIdx = null;
  for (const key of Object.keys(headerMap)) {
    if (key.includes("amplification primers")) {
      ampIdx = headerMap[key];
      break;
    }
  }

  let log;
  let primerStart;
  if (workIdx !== null && ampIdx !== null) {
    primerStart = ampIdx + 1; // individual primers follow the group header
    log =
      `'input addon': columns resolved by name (Work No.=${columnLetter(workIdx + 1)}, ` +
      `primer block from ${columnLetter(primerStart + 1)} after 'Amplification primers')`;
  } else {
    workIdx = 0;
    primerStart = 16; // historic: Work No.=A, primers from col Q
    log =
      "'input addon': header row not recognized; falling back to fixed columns " +
      `(Work No.=A, primers from ${columnLetter(primerStart + 1)})`;
  }

  // Skip header (row 0). Start from row 1.
  for (let i = 1; i < aoa.length; i++) {
    const row = aoa[i] || [];
    const cell = row[workIdx];
    if (cell == null || cell === "") continue;
    const workNo = String(cell).trim();
    if (!workNoSet.has(workNo)) continue;
    for (let c = primerStart; c < row.length; c++) {
      const val = row[c];
      if (val != null && val !== "") {
        primers[workNo].push(String(val));
      }
    }
  }
  return { primers, log };
}

/**
 * The last EXCEL row the Python reads from the Sequencing Pending sheet.
 *
 * `sequencing_order_form_app.py:96` and `:783-784`:
 *
 *     for row in sequencing_sheet.iter_rows(min_row=2, max_row=98, ...):
 *
 * so the cap is EXCEL ROW 98 — blanks included. It is NOT a cap on the
 * number of populated rows.
 */
export const SEQUENCE_PENDING_MAX_EXCEL_ROW = 98;

/**
 * Pulls the Sample ID (column D, index 3) for every row in the Sequencing
 * Pending sheet whose Work No. (column A, index 0) is in the requested set.
 *
 * The Python appends ONE TUPLE PER MATCHING ROW — it does not dedupe. A
 * Work No. that appears on several rows yields several order-form rows.
 * (The *unique* Work No. list used for the primer lookup is deduped
 * separately — see `extractUniqueJobIds`.)
 *
 * Returns: ordered list of [workNo, sampleId] tuples in sheet order.
 */
export async function getSequenceSampleId(seqValidationFile, workNos) {
  const buf = await seqValidationFile.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const sheet = wb.Sheets["Sequencing Pending"];
  if (!sheet) {
    throw new Error("Sheet 'Sequencing Pending' not found in Sequencing Validation file.");
  }
  const workNoSet = workNos ? new Set(workNos.map((w) => String(w).trim())) : null;
  // `blankrows: true` keeps the ROW POSITIONS, so index i in the array is
  // EXCEL row i+1. With `blankrows: false` the blank rows are collapsed and
  // the index no longer maps to the Excel row — which would turn the
  // Python's "max_row=98" (an EXCEL row number) into "the 98th populated
  // row" and read a different set of rows entirely.
  const aoa = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    blankrows: true,
    raw: false,
  });
  const ordered = [];
  // Excel rows 2..98 inclusive. xlsx is 0-indexed, so Excel row 2 is index
  // 1 and Excel row 98 is index 97.
  const lastIdx = SEQUENCE_PENDING_MAX_EXCEL_ROW - 1; // 97
  for (let i = 1; i <= lastIdx && i < aoa.length; i++) {
    const row = aoa[i] || [];
    const cell = row[0];
    if (!cell) continue;
    const workNo = String(cell).trim();
    if (workNoSet && !workNoSet.has(workNo)) continue;
    const sampleId = row[3] != null ? String(row[3]).trim() : "";
    // No dedupe: one tuple per matching row, exactly like the Python.
    ordered.push([workNo, sampleId]);
  }
  return ordered;
}

/**
 * Extract the unique Work Nos from the Sequencing Validation file, in sheet
 * order, deduped. This list feeds the primer lookup (which keys a dict by
 * Work No., so a repeated Work No. must appear once).
 */
export async function extractUniqueJobIds(seqValidationFile) {
  const samples = await getSequenceSampleId(seqValidationFile, null);
  const seen = new Set();
  const out = [];
  for (const [workNo] of samples) {
    if (seen.has(workNo)) continue;
    seen.add(workNo);
    out.push(workNo);
  }
  return out;
}
