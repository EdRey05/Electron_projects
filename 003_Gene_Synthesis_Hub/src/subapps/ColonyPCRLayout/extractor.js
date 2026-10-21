/**
 * Colony PCR Layout — data extraction.
 *
 * Mirrors `fill_colony_pcr_layout` in the Python source. Reads the ligation
 * layout files (sheet "Layout") and the Primer Log (sheet "input addon"),
 * then joins them by Work No. to produce the summary data.
 *
 * Both reads use the Oct 2026 two-step column pass:
 *   1. Resolve the column by header NAME (canonical spelling first, legacy
 *      spelling tolerated), with ALL whitespace collapsed and lowercased.
 *   2. Only when the header row is not recognized, fall back to the historic
 *      fixed columns.
 *
 * The Python source logs which path fired; we return the same log lines so
 * the app's log panel shows the resolution provenance.
 *
 * Pure functions: input is already-loaded data (ArrayBuffer / parsed
 * workbook from the caller). No I/O, no side effects.
 */

import * as XLSX from "xlsx";
import { buildHeaderMap, columnLetter } from "../../ui/columns.js";

/** Historic fixed columns for the ligation "Layout" sheet: A,B,C,D,T,U,V,W. */
const LIGATION_FALLBACK_COLS = [0, 1, 2, 3, 19, 20, 21, 22];
const LIGATION_FALLBACK_NAMES = [
  "Well",
  "Work No.",
  "BBI ID",
  "Vector",
  "Length (bp)",
  "Resistance",
  "Host",
  "Temperature",
];

/** Header candidates per canonical ligation column (name-first pass). */
const LIGATION_WANTED = [
  { canonical: "Well", candidates: ["well"] },
  { canonical: "Work No.", candidates: ["work no.", "job id", "jobid", "job_id"] },
  { canonical: "BBI ID", candidates: ["bbi id", "bbid"] },
  { canonical: "Vector", candidates: ["vector"] },
  { canonical: "Length (bp)", candidates: ["length (bp)", "length"] },
  { canonical: "Resistance", candidates: ["resistance", "antibiotic"] },
  { canonical: "Host", candidates: ["host"] },
  { canonical: "Temperature", candidates: ["temperature"] },
];

/** Historic fixed columns for the Primer Log: A = Work No., K = primers. */
const PRIMER_FALLBACK = { workNo: 0, primers: 10 };
const PRIMER_WANTED = {
  workNo: ["work no.", "jobid", "job id", "job_id"],
  primers: ["colony pcr primers"],
};

/**
 * Read a ligation layout .xlsx and return the rows we need.
 *
 * Name-first pass: probe the header row (row 0) for all eight canonical
 * columns. If every one resolves, use those indices and report the
 * resolution. Otherwise fall back to the fixed columns A,B,C,D,T,U,V,W.
 *
 * Returns { rows: [...], log: string }.
 */
export function readLigationLayout(arrayBuffer, sourceFile) {
  const wb = XLSX.read(arrayBuffer, { type: "array" });
  const sheet = wb.Sheets["Layout"];
  if (!sheet) {
    throw new Error(`Sheet 'Layout' not found in ${sourceFile}`);
  }
  // header=None + skiprows=1 -> read all rows, treat the first as the header.
  // `raw: true` so numeric cells (e.g. Length (bp)) stay NUMBERS — with
  // `raw: false` a `#,##0`-formatted cell comes back as the string "2,686"
  // and the Python (pandas) would have yielded the number 2686.
  const aoa = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    blankrows: false,
    raw: true,
  });

  const baseName = (sourceFile || "").split(/[\\/]/).pop();
  const headers = (aoa[0] || []).map((h) => (h == null ? "" : String(h)));
  const headerMap = buildHeaderMap(headers);

  const resolved = [];
  for (const want of LIGATION_WANTED) {
    let found = null;
    for (const cand of want.candidates) {
      if (cand in headerMap) {
        found = headerMap[cand];
        break;
      }
    }
    resolved.push(found);
  }

  const allByName = resolved.every((i) => i !== null);
  const indices = allByName ? resolved : LIGATION_FALLBACK_COLS;
  const names = allByName
    ? LIGATION_FALLBACK_NAMES
    : LIGATION_FALLBACK_NAMES;

  let log;
  if (allByName) {
    const detail = names
      .map((name, i) => `${name}=${columnLetter(resolved[i])}`)
      .join(", ");
    log = `  > ${baseName}: columns resolved by name (${detail})`;
  } else {
    const fallbackCols = "A,B,C,D,T,U,V,W";
    log = `  > ${baseName}: header row not recognized, falling back to fixed columns (${fallbackCols})`;
  }

  const rows = [];
  for (let i = 1; i < aoa.length; i++) {
    const r = aoa[i] || [];
    const pick = (idx) => (r[idx] == null ? "" : String(r[idx]).trim());
    rows.push({
      Well: pick(indices[0]),
      Name: pick(indices[1]),
      "BBI ID": pick(indices[2]),
      Vector: pick(indices[3]),
      "Length (bp)": pick(indices[4]),
      Resistance: pick(indices[5]),
      Host: pick(indices[6]),
      Temperature: pick(indices[7]),
      SourceFile: sourceFile,
    });
  }
  return { rows, log };
}

/**
 * Read the Primer Log .xlsx and return a Work No. -> Primers map.
 *
 * Name-first pass: resolve the Work No. column and the "Colony PCR primers"
 * column by header name. Only when both are missing (or point at the same
 * column) does it fall back to the fixed A / K positions.
 *
 * Returns { map, log }.
 */
export function readPrimerLog(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: "array" });
  const sheet = wb.Sheets["input addon"];
  if (!sheet) {
    throw new Error("Sheet 'input addon' not found in Primer Log");
  }
  const aoa = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    blankrows: false,
    raw: false,
  });
  const headers = (aoa[0] || []).map((h) => (h == null ? "" : String(h)));
  const headerMap = buildHeaderMap(headers);

  const find = (candidates) => {
    for (const c of candidates) {
      if (c in headerMap) return headerMap[c];
    }
    return null;
  };
  const wi = find(PRIMER_WANTED.workNo);
  const pi = find(PRIMER_WANTED.primers);
  const byName = wi !== null && pi !== null && wi !== pi;

  const workNoIdx = byName ? wi : PRIMER_FALLBACK.workNo;
  const primersIdx = byName ? pi : PRIMER_FALLBACK.primers;

  const log = byName
    ? `  > Primer Log: columns resolved by name (${columnLetter(wi + 1)}=Work No., ${columnLetter(
        pi + 1
      )}=primers)`
    : "  > Primer Log: header row not recognized, falling back to fixed columns (A / K)";

  const map = {};
  for (let i = 1; i < aoa.length; i++) {
    const r = aoa[i] || [];
    const jobId = r[workNoIdx];
    const primers = r[primersIdx];
    if (jobId == null) continue;
    const key = String(jobId).trim();
    if (!key) continue;
    map[key] = primers == null ? "" : String(primers);
  }
  return { map, log };
}

/**
 * Combine all ligation files into a single summary dataset, then enrich
 * each row with its primer (joined from the Primer Log).
 *
 * Mirrors the chain in `fill_colony_pcr_layout`:
 *   1. read each ligation file -> df_single_ligation
 *   2. concat all -> df_ligation
 *   3. dropna(subset=["Name"]) -> drop empty rows
 *   4. filter out rows where Name starts with "CK" (controls)
 *   5. left join primer_mapping on Name -> add Primers column
 *   6. rename Name -> "Work No." (canonical naming standard)
 *   7. reorder columns
 *
 * Returns: { rows: [...], warnings: [...], primerLogValid, hasWarnings }
 */
export function buildSummary(ligationRows, primerMap) {
  // Drop rows with empty Name
  let rows = ligationRows.filter((r) => r.Name && r.Name.length > 0);
  // Drop CK controls
  const ckFiltered = rows.filter((r) => !r.Name.startsWith("CK"));
  const ckCount = rows.length - ckFiltered.length;
  rows = ckFiltered;
  // Enrich with primers
  const warnings = [];
  if (ckCount > 0) {
    warnings.push(`Filtered out ${ckCount} CK control row(s).`);
  }
  rows = rows.map((r) => {
    const primers = primerMap[r.Name] ?? "";
    if (!primers) {
      warnings.push(`No primers found for Work No. ${r.Name}.`);
    }
    return {
      "Work No.": r.Name,
      "BBI ID": r["BBI ID"],
      Vector: r.Vector,
      Resistance: r.Resistance,
      Primers: primers,
      "Length (bp)": r["Length (bp)"],
      Host: r.Host,
      Temperature: r.Temperature,
      SourceFile: r.SourceFile,
    };
  });
  return { rows, warnings };
}

/**
 * Deduplicate by ("Work No.", SourceFile) - the Python source uses this to
 * drive the clone-count dialog so each (job, source-file) gets one
 * prompt even if it appears multiple times.
 */
export function uniqueJobDetails(summaryRows) {
  const seen = new Set();
  const out = [];
  for (const row of summaryRows) {
    const key = `${row["Work No."]}\0${row.SourceFile}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}
