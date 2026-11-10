/**
 * Sequencing Reference Files — extraction logic.
 *
 * Mirrors `Sequencing_reference_files_app.py::_processing_thread`:
 *   1. Open the Primer Log .xlsx, find the `input addon` sheet.
 *   2. Read the header row, resolve the columns (canonical header name
 *      first, legacy spelling second, historic positional index last).
 *      Fallback indices: Work No.=A(0), Vector=E(4), Insert Sequence=H(7),
 *      Final Vector Sequence=I(8).
 *   3. For each non-empty row:
 *      - Write `{Work No.}.txt` with the Insert Sequence (if non-empty).
 *      - Write `{Work No.}+{Vector}.txt` with the Final Vector Sequence.
 */
import * as XLSX from "xlsx";
import { resolveColumns, columnResolutionLog, normHeader } from "../../ui/columns.js";

/**
 * Resolve column indices from a header row.
 * Returns the indices plus the per-column provenance (byName) so the caller
 * can log which resolution path fired.
 */
export function resolveColumnIndices(headers) {
  // Local spec set: this app's upstream resolves these four columns with
  // exactly these candidates and fallbacks A/E/H/I — no extra aliases.
  const { indices, byName, report, mode } = resolveColumns(headers, [
    { key: "workNo", label: "Work No.", candidates: ["Work No.", "JobID", "Job ID"], fallback: 0 },
    { key: "vector", label: "Vector", candidates: ["Vector"], fallback: 4 },
    { key: "insertSequence", label: "Insert Sequence", candidates: ["Insert Sequence", "Insert Seq"], fallback: 7 },
    { key: "finalVectorSequence", label: "Final Vector Sequence", candidates: ["Final Vector Sequence", "Final Vector"], fallback: 8 },
  ]);
  return {
    // Legacy key names kept so the existing callers keep working.
    jobId: indices.workNo,
    vector: indices.vector,
    insertSeq: indices.insertSequence,
    finalVector: indices.finalVectorSequence,
    workNo: indices.workNo,
    insertSequence: indices.insertSequence,
    finalVectorSequence: indices.finalVectorSequence,
    byName,
    report,
    mode,
  };
}

/** The log line the Python app emits for the resolved column set. */
export function columnLog(headers) {
  const r = resolveColumnIndices(headers);
  return columnResolutionLog("input addon", r);
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
  const hints=['work no','jobid','job id','vector','insert','final'];
  const headerless=!Object.values(indices.byName).some(Boolean)&&
    !headers.some(h=>hints.some(hint=>normHeader(h).includes(hint)))&&
    headers.some(h=>{const seq=h.toUpperCase().replace(/[\s-]+/g,'');return seq.length>=40&&/^[ACGTUN]+$/.test(seq);});
  for (const row of headerless?aoa:aoa.slice(1)) {
    const jobId = cleanCell(row[indices.workNo]);
    if (!jobId) continue;
    rows.push({
      jobId,
      workNo: jobId,
      vector: cleanCell(row[indices.vector]),
      insertSeq: cleanCell(row[indices.insertSequence]),
      finalVector: cleanCell(row[indices.finalVectorSequence]),
    });
  }
  return {
    ok: true,
    indices,
    rows,
    resolutionLog: columnResolutionLog("input addon", indices)+(headerless?" Row 1 contains sequence data and was included.":""),
  };
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
    if (row.vector) {
      out.push({ name: `${row.jobId}+${row.vector}.txt`, contents: row.finalVector });
    } else {
      // The combined name needs a vector: the Tk app counts and logs the skip.
      out.push({ name: `${row.jobId}+${row.vector}.txt`, skipped: true });
    }
  }
  for (const file of out) {
    if (file.skipped) continue;
    if (/[<>:"/\\|?*\x00-\x1f]/.test(file.name) || /[. ]$/.test(file.name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(file.name)) {
      throw new Error(`Invalid output filename: ${file.name}. Correct the Work No. or Vector in the workbook.`);
    }
  }
  return out;
}

export function planWorkbookOutputs(rows) {
  const files=new Map();
  for(const row of rows)for(const file of planOutputs(row)) {
    const key=file.name.toLowerCase();
    const previous=files.get(key);
    if(previous && previous.contents!==file.contents)throw new Error(`Conflicting sequences for ${file.name}; no files were written.`);
    files.set(key,file);
  }
  return [...files.values()];
}
