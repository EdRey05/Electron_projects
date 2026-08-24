/**
 * Excel helpers for QC Vector Map Prep.
 *
 * Mirrors `workflows/helpers.py` from the Python source. The Primer Log has
 * one or two relevant sheets (`input addon`, `Obsolete input addon(completed)`)
 * that share the same column structure. We:
 *   - detect the JobID column (case-insensitive, or fall back to column 0),
 *   - look up a row by JobID,
 *   - pull a field by column-name candidates with a positional fallback.
 */
import * as XLSX from "xlsx";

/**
 * Find a column whose header matches any of `candidates` (case-insensitive).
 * Returns the actual column name (with original casing) or null.
 */
export function normalizeColumnLookup(headers, candidates) {
  if (!headers) return null;
  const lowerMap = {};
  for (const h of headers) {
    if (h != null) lowerMap[String(h).trim().toLowerCase()] = h;
  }
  for (const cand of candidates) {
    const k = cand.toLowerCase();
    if (lowerMap[k]) return lowerMap[k];
  }
  return null;
}

/**
 * Find the first row in `rows` whose JobID cell matches `jobid`.
 * `rows` is the array-of-arrays form from sheet_to_json (header=1),
 * `headers` is the first row. Returns the row array, or null.
 */
export function getRowForJobId(rows, headers, jobid) {
  if (!rows || !headers) return null;
  const jobidCol = normalizeColumnLookup(headers, [
    "JobID",
    "Job Id",
    "Job_ID",
    "jobid",
  ]);
  let jobidIdx;
  if (jobidCol != null) {
    jobidIdx = headers.indexOf(jobidCol);
  } else {
    jobidIdx = 0;
  }
  const target = String(jobid).trim();
  for (const row of rows) {
    const cell = row[jobidIdx];
    if (cell == null) continue;
    if (String(cell).trim() === target) return row;
  }
  return null;
}

/**
 * Pull a field from a row by column-name candidates (case-insensitive),
 * falling back to a positional index if no column name matches.
 * Returns "" if not found / value is null.
 */
export function getFieldFromRow(row, headers, fieldNamesCandidates, fallbackIndex = null) {
  if (!row || !headers) return "";
  // 1. Try each candidate column name.
  for (const candidate of fieldNamesCandidates) {
    const actualCol = normalizeColumnLookup(headers, [candidate]);
    if (actualCol == null) continue;
    const idx = headers.indexOf(actualCol);
    if (idx < 0) continue;
    const val = row[idx];
    if (val == null || val === "") continue;
    return String(val).trim();
  }
  // 2. Positional fallback.
  if (fallbackIndex != null && fallbackIndex >= 0 && fallbackIndex < row.length) {
    const val = row[fallbackIndex];
    if (val != null && val !== "") return String(val).trim();
  }
  return "";
}

/**
 * Load a Primer Log .xlsx from a File object and return its relevant
 * sheets (case-insensitive match on `input addon` and
 * `Obsolete input addon(completed)`) as { name, headers, rows }.
 */
export async function loadPrimerLogSheets(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const wanted = ["input addon", "Obsolete input addon(completed)"];
  const wantedLower = wanted.map((w) => w.toLowerCase());
  const matching = wb.SheetNames.filter((n) => wantedLower.includes(n.toLowerCase()));
  if (matching.length === 0) {
    return { sheets: [], missing: wanted };
  }
  const sheets = [];
  for (const name of matching) {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], {
      header: 1,
      blankrows: false,
      raw: false,
    });
    if (aoa.length === 0) continue;
    const headers = aoa[0].map((h) => (h == null ? "" : String(h)));
    const rows = aoa.slice(1);
    sheets.push({ name, headers, rows });
  }
  return { sheets, missing: [] };
}

/**
 * Quick validation: does the workbook contain at least one of the expected
 * sheets? Used by the pre-flight check.
 */
export async function primerLogHasRequiredSheets(file) {
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const wantedLower = ["input addon", "obsolete input addon(completed)"];
    const found = wb.SheetNames.some((n) => wantedLower.includes(n.toLowerCase()));
    return found;
  } catch {
    return false;
  }
}
