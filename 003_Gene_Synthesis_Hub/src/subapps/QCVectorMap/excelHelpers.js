/**
 * Excel helpers for QC Vector Map Prep.
 *
 * Mirrors `workflows/helpers.py` from the Python source. The Primer Log has
 * one or two relevant sheets (`input addon`, `Obsolete input addon(completed)`)
 * that share the same column structure. We:
 *   - detect the Work No. column (canonical name first, legacy spellings
 *     tolerated, positional fallback to column 0),
 *   - look up a row by Work No.,
 *   - pull a field by column-name candidates with a positional fallback.
 *
 * The Python normalizes header keys with `str(c).strip().lower()`; we use the
 * shared `normHeader` from `ui/columns.js`, which additionally collapses
 * internal whitespace (line breaks / double spaces). That is a superset of
 * the Python behaviour — it matches every header the Python matches, plus
 * the ones that carry embedded newlines.
 *
 * `resolveQcColumns()` returns the full per-column provenance (index,
 * matched-by-name boolean, and WHICH candidate header matched) so the
 * caller can log the same three-way report the Python apps emit.
 */
import * as XLSX from "xlsx";
import {
  buildHeaderMap,
  normHeader,
  resolveColumn,
  resolveColumns,
  COLUMN_SPECS,
} from "../../ui/columns.js";

/**
 * The three columns the QC Vector Map workflow reads, in the order the
 * Python reads them (Work No. → Final Vector Sequence → Insert Sequence).
 * The candidate lists and fallback indices mirror
 * `vector_map_prep_biopython.py`:
 *   Work No.             → fallback index 0 (column A)
 *   Final Vector Sequence→ fallback index 8 (column I)
 *   Insert Sequence      → fallback index 7 (column H)
 */
export const QC_COLUMN_SPECS = [
  COLUMN_SPECS.workNo,
  COLUMN_SPECS.finalVectorSequence,
  COLUMN_SPECS.insertSequence,
];

/**
 * Resolve the QC Vector Map columns from a header row.
 *
 * @param {string[]} headers raw header row
 * @returns {{
 *   indices: {workNo:number, finalVectorSequence:number, insertSequence:number},
 *   byName: {workNo:boolean, finalVectorSequence:boolean, insertSequence:boolean},
 *   matched: {workNo:string|null, finalVectorSequence:string|null, insertSequence:string|null},
 *   report: string, mode: "all-name"|"partial"|"none"
 * }}
 *   `report` — the "Work No.=A (name), Final Vector Sequence=I (fixed fallback)" string
 *   `mode`   — "all-name" | "partial" | "none"
 */
export function resolveQcColumns(headers) {
  const resolved = resolveColumns(headers, QC_COLUMN_SPECS);
  const headerMap = buildHeaderMap(headers);
  const matched = {};
  for (const spec of QC_COLUMN_SPECS) {
    const r = resolveColumn(headerMap, spec.candidates, spec.fallback);
    matched[spec.key] = r.matched;
  }
  return { ...resolved, matched };
}

/**
 * Find a column whose header matches any of `candidates`.
 * Returns the actual column name (with original casing) or null.
 */
export function normalizeColumnLookup(headers, candidates) {
  if (!headers) return null;
  const map = buildHeaderMap(headers);
  // Keep the original header text so the caller can report it.
  for (const cand of candidates || []) {
    const key = normHeader(cand);
    if (!key) continue;
    if (key in map) return headers[map[key]];
  }
  return null;
}

/**
 * Find the first row in `rows` whose Work No. cell matches `workNo`.
 * `rows` is the array-of-arrays form from sheet_to_json (header=1),
 * `headers` is the first row. Returns the row array, or null.
 */
export function getRowForJobId(rows, headers, workNo) {
  if (!rows || !headers) return null;
  const { indices } = resolveQcColumns(headers);
  const workNoIdx = indices.workNo;

  const target = String(workNo).trim();
  for (const row of rows) {
    const cell = row[workNoIdx];
    if (cell == null) continue;
    if (String(cell).trim() === target) return row;
  }
  return null;
}

/**
 * Pull a field from a row by column-name candidates (canonical first),
 * falling back to a positional index if no column name matches.
 * Returns "" if not found / value is null.
 */
export function getFieldFromRow(row, headers, fieldNamesCandidates, fallbackIndex = null) {
  if (!row || !headers) return "";
  const headerMap = buildHeaderMap(headers);
  // 1. Try each candidate column name (canonical spellings first).
  for (const candidate of fieldNamesCandidates) {
    const key = normHeader(candidate);
    if (!key || !(key in headerMap)) continue;
    const idx = headerMap[key];
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
 * Read a cell at an already-resolved column index. Used when the caller
 * has the resolution provenance and wants the value from exactly the
 * column that was logged. Mirrors the Python's `get_field_from_row`
 * return contract: a stripped string, or "" for a missing value.
 */
export function readResolvedField(row, idx) {
  if (!row || idx == null || idx < 0 || idx >= row.length) return "";
  const val = row[idx];
  if (val == null || val === "") return "";
  return String(val).trim();
}

/**
 * Load a Primer Log .xlsx from a File object and return its relevant
 * sheets (case-insensitive match on `input addon` and
 * `Obsolete input addon(completed)`) as { name, headers, rows, resolution }.
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
    sheets.push({ name, headers, rows, resolution: resolveQcColumns(headers) });
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
