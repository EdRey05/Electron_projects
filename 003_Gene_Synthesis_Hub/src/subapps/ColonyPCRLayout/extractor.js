/**
 * Colony PCR Layout — data extraction.
 *
 * Mirrors the first ~120 lines of `fill_colony_pcr_layout` in the Python
 * source. Reads ligation layout files (sheet "Layout", columns A-D and T-W,
 * skipping row 1 as header) and the Primer Log (sheet "input addon",
 * columns A=JobID and K=Primers), then joins them by JobID to produce
 * the summary_data frame equivalent.
 *
 * Pure functions: input is already-loaded data (ArrayBuffer / parsed
 * workbook from the caller). No I/O, no side effects.
 */

import * as XLSX from "xlsx";

/**
 * Read a ligation layout .xlsx and return the rows we need.
 * Mirrors `pd.read_excel(path, sheet_name="Layout", header=None, skiprows=1,
 * usecols="A,B,C,D,T,U,V,W")` from the Python source.
 *
 * Returns an array of objects:
 *   { Well, Name, BBID, Vector, Length, Resistance, Host, Temperature, SourceFile }
 *
 * Note: well is left empty (column A is the well label, but the Python
 * source reads it but doesn't use it directly). SourceFile is added by
 * the caller since they know which file they loaded.
 */
export function readLigationLayout(arrayBuffer, sourceFile) {
  const wb = XLSX.read(arrayBuffer, { type: "array" });
  const sheet = wb.Sheets["Layout"];
  if (!sheet) {
    throw new Error(`Sheet 'Layout' not found in ${sourceFile}`);
  }
  // header=None + skiprows=1 -> read all rows, treat first row as data.
  // usecols="A,B,C,D,T,U,V,W" -> only columns A,B,C,D,20,21,22,23.
  const aoa = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    blankrows: false,
    raw: false,
  });
  // Skip row 0 (header). For each remaining row, pick columns A,B,C,D,T,U,V,W.
  // XLSX is 0-indexed; Excel columns are A=0, B=1, C=2, D=3, T=19, U=20, V=21, W=22.
  const rows = [];
  for (let i = 1; i < aoa.length; i++) {
    const r = aoa[i] || [];
    const pick = (idx) => (r[idx] == null ? "" : String(r[idx]).trim());
    rows.push({
      Well: pick(0),
      Name: pick(1),
      BBID: pick(2),
      Vector: pick(3),
      Length: pick(19),
      Resistance: pick(20),
      Host: pick(21),
      Temperature: pick(22),
      SourceFile: sourceFile,
    });
  }
  return rows;
}

/**
 * Read the Primer Log .xlsx and return a JobID -> Primers map.
 * Mirrors `pd.read_excel(primer_log_path, sheet_name="input addon")` +
 * `pd.Series(df_primer.iloc[:, 10].values, index=df_primer.iloc[:, 0]).to_dict()`
 * from the Python source.
 *
 * Column A (index 0) = JobID, Column K (index 10) = Primers.
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
  const map = {};
  for (let i = 1; i < aoa.length; i++) {
    const r = aoa[i] || [];
    const jobId = r[0];
    const primers = r[10];
    if (jobId == null) continue;
    const key = String(jobId).trim();
    if (!key) continue;
    map[key] = primers == null ? "" : String(primers);
  }
  return map;
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
 *   6. rename Name -> JobID
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
      warnings.push(`No primers found for JobID ${r.Name}.`);
    }
    return {
      JobID: r.Name,
      BBID: r.BBID,
      Vector: r.Vector,
      Resistance: r.Resistance,
      Primers: primers,
      Length: r.Length,
      Host: r.Host,
      Temperature: r.Temperature,
      SourceFile: r.SourceFile,
    };
  });
  return { rows, warnings };
}

/**
 * Deduplicate by (JobID, SourceFile) - the Python source uses this to
 * drive the clone-count dialog so each (job, source-file) gets one
 * prompt even if it appears multiple times.
 */
export function uniqueJobDetails(summaryRows) {
  const seen = new Set();
  const out = [];
  for (const row of summaryRows) {
    const key = `${row.JobID}\0${row.SourceFile}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}
