/**
 * Sequencing Reference Files — extraction logic.
 *
 * Mirrors `Sequencing_reference_files_app.py::_processing_thread`:
 *   1. Open the Primer Log .xlsx, find the `input addon` sheet.
 *   2. Read the header row, map column names to indices (case-insensitive).
 *      Fallback indices: JobID=A(0), Vector=E(4), Insert Seq=H(7), Final Vector=I(8).
 *   3. For each non-empty row:
 *      - Write `{JobID}.txt` with the Insert Seq (if non-empty).
 *      - Write `{JobID}+{Vector}.txt` with the Final Vector (if non-empty).
 */
import * as XLSX from "xlsx";

/**
 * Resolve column indices from a header row.
 * Returns { jobId, vector, insertSeq, finalVector }.
 */
export function resolveColumnIndices(headers) {
  const headerMap = {};
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (h == null) continue;
    headerMap[String(h).trim().toLowerCase()] = i;
  }
  // Try common header name variants; fall back to the positional defaults.
  const find = (...names) => {
    for (const n of names) {
      const idx = headerMap[n.toLowerCase()];
      if (idx !== undefined) return idx;
    }
    return null;
  };
  return {
    jobId: find("JobID", "Job Id", "Job_ID", "jobid") ?? 0,
    vector: find("Vector") ?? 4,
    insertSeq: find("Insert Seq", "InsertSeq", "insert seq") ?? 7,
    finalVector: find("Final Vector", "FinalVector", "final vector") ?? 8,
  };
}

/**
 * Strip a value to a trimmed string. Empty cells return "".
 */
function cleanCell(v) {
  if (v == null) return "";
  return String(v).trim();
}

/**
 * Extract sequences from a Primer Log File.
 * Returns { ok, sheetsFound, indices, rows: [{jobId, vector, insertSeq, finalVector}], error? }.
 */
export async function extractSequences(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const wanted = "input addon";
  if (!wb.SheetNames.includes(wanted)) {
    return { ok: false, error: `Sheet '${wanted}' not found in the workbook.` };
  }
  const sheet = wb.Sheets[wanted];
  const aoa = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    blankrows: false,
    raw: false,
  });
  if (aoa.length === 0) {
    return { ok: false, error: "Workbook has no rows." };
  }
  const headers = aoa[0].map((h) => (h == null ? "" : String(h)));
  const indices = resolveColumnIndices(headers);
  const rows = [];
  for (const row of aoa.slice(1)) {
    const jobId = cleanCell(row[indices.jobId]);
    if (!jobId) continue;
    rows.push({
      jobId,
      vector: cleanCell(row[indices.vector]),
      insertSeq: cleanCell(row[indices.insertSeq]),
      finalVector: cleanCell(row[indices.finalVector]),
    });
  }
  return { ok: true, indices, rows };
}

/**
 * Given an output folder + a row, compute the file paths that will be written.
 * Returns [{ name, contents }, ...].
 */
export function planOutputs(row) {
  const out = [];
  if (row.insertSeq) {
    out.push({ name: `${row.jobId}.txt`, contents: row.insertSeq });
  }
  if (row.finalVector) {
    out.push({ name: `${row.jobId}+${row.vector}.txt`, contents: row.finalVector });
  }
  return out;
}
