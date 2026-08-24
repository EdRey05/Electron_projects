/**
 * Pure data extraction for Sequencing Order Form.
 *
 * Mirrors `get_primer_info` + `get_sequence_sample_ID` from the Python source.
 * These are pure functions: input File objects, output plain JS arrays/dicts.
 */

import * as XLSX from "xlsx";

/**
 * Pulls every primer from the Primer Log's `input addon` sheet for the given
 * JobIDs. Primers live in columns Q (index 16) onwards. Multiple primers per
 * JobID are kept in column order.
 *
 * Returns: { jobId -> [primer, primer, ...] }
 */
export async function getPrimerInfo(primerLogFile, jobIDs) {
  const buf = await primerLogFile.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const sheet = wb.Sheets["input addon"];
  if (!sheet) {
    throw new Error("Sheet 'input addon' not found in Primer Log.");
  }
  const jobIDSet = new Set(jobIDs.map((j) => String(j).trim()));
  const primers = Object.create(null);
  for (const j of jobIDs) primers[String(j).trim()] = [];

  const aoa = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    blankrows: false,
    raw: false,
  });
  // Skip header (row 0). Start from row 1.
  for (let i = 1; i < aoa.length; i++) {
    const row = aoa[i] || [];
    const cell = row[0];
    if (!cell) continue;
    const jobId = String(cell).trim();
    if (!jobIDSet.has(jobId)) continue;
    // Columns Q (index 16) onwards.
    for (let c = 16; c < row.length; c++) {
      const val = row[c];
      if (val != null && val !== "") {
        primers[jobId].push(String(val));
      }
    }
  }
  return primers;
}

/**
 * Pulls the Sample ID (column D, index 3) for every row in the Sequencing
 * Pending sheet whose JobID (column A, index 0) is in the requested set.
 *
 * Returns: ordered list of [jobId, sampleId] tuples in sheet order, deduped
 * by jobId (first occurrence wins).
 */
export async function getSequenceSampleId(seqValidationFile) {
  const buf = await seqValidationFile.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const sheet = wb.Sheets["Sequencing Pending"];
  if (!sheet) {
    throw new Error("Sheet 'Sequencing Pending' not found in Sequencing Validation file.");
  }
  const aoa = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    blankrows: false,
    raw: false,
  });
  const ordered = [];
  const seen = new Set();
  // The Python app reads rows 2-98 (max_row=98). We replicate.
  // xlsx is 0-indexed; header is row 0, so data starts at row 1.
  // max_row=98 in 1-based = up to index 97 in 0-based; we cap at min(98, aoa.length).
  const endRow = Math.min(98, aoa.length);
  for (let i = 1; i < endRow; i++) {
    const row = aoa[i] || [];
    const cell = row[0];
    if (!cell) continue;
    const jobId = String(cell).trim();
    if (seen.has(jobId)) continue;
    seen.add(jobId);
    const sampleId = row[3] != null ? String(row[3]).trim() : "";
    ordered.push([jobId, sampleId]);
  }
  return ordered;
}

/**
 * Extract unique JobIDs from the Sequencing Validation file in sheet order.
 * Used when the user provides a Seq Validation file but no explicit JobIDs.
 */
export async function extractUniqueJobIds(seqValidationFile) {
  const samples = await getSequenceSampleId(seqValidationFile);
  return samples.map(([jobId]) => jobId);
}
