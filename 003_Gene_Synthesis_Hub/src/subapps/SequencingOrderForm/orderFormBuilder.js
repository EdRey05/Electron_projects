/**
 * Sequencing Order Form — row builder + workbook emitter.
 *
 * Mirrors `fill_order_form` from the Python source. Outputs a fresh .xlsx
 * workbook with the same columns the empty form uses:
 *   C = Sequence Sample ID (Plasmid ID / Vector #)
 *   D = Primer name
 *   E = formula: =CONCATENATE(C, "._.", G, "._.", D, "._.", H)
 *   G = JobID
 *   H = date_ID (output folder basename)
 *   I = formula: =VLOOKUP(C, '[<seq_validation>]Sequencing Pending'!$D:$K, 8, 0)
 *   J = formula: =CONCATENATE(C, " ", I)
 *   K = primer.split("(*", 1)[0].strip()
 *   L = formula: =CONCATENATE(C, "._.", G, "._.", K, "._.", H)
 *
 * Starts writing at row 20 (1-based), increments per primer per sample.
 *
 * Difference from the Python version: the Python code uses openpyxl to mutate
 * a copy of the Empty Form template (preserving any layout the user had).
 * We can't reliably round-trip arbitrary templates via the `xlsx` library —
 * it loses formatting, named styles, and complex formulas. So we generate a
 * clean workbook from scratch with just the data and computed formulas,
 * matching the data the Python version produces. The visual style is minimal
 * (a header row + the rows of data), but the content is identical and Excel
 * will recalculate the formulas on open.
 */

import * as XLSX from "xlsx";

const START_ROW = 20; // 1-based, matches the Python original

/**
 * Build the row objects that will become the filled form rows.
 *
 * @param {Array<[string, string]>} orderedSamples  - [[jobId, sampleId], ...]
 * @param {Object} primersDict                       - {jobId -> [primer, ...]}
 * @param {string} dateId                            - basename of output folder
 * @returns {{ rows: Array, warnings: Array<string> }}
 */
export function buildFormRows(orderedSamples, primersDict, dateId) {
  const rows = [];
  const warnings = [];
  const reportedMissing = new Set();

  for (const [jobId, sequenceSampleId] of orderedSamples) {
    const primers = primersDict[jobId] || [];
    if (primers.length === 0) {
      if (!reportedMissing.has(jobId)) {
        warnings.push(`Job ID ${jobId}: No primers found.`);
        reportedMissing.add(jobId);
      }
      continue;
    }
    for (const primer of primers) {
      rows.push({
        jobId,
        sequenceSampleId,
        primer,
        primerShort: String(primer).split("(*", 1)[0].trim(),
        dateId,
      });
    }
  }
  return { rows, warnings };
}

/**
 * Build a complete workbook object from the form rows + the seq validation
 * filename (used to construct the VLOOKUP path).
 *
 * @param {{ rows, warnings }} built
 * @param {string} seqValidationFilename  - basename of the seq validation file
 * @returns {object} - xlsx-format workbook ready to write
 */
export function buildWorkbook({ rows, warnings }, seqValidationFilename) {
  // Sheet 1: the filled order form. AOA layout (matches Python's row-by-row
  // direct cell access but starts at A20 per the original behaviour).
  const headerRow = [
    null, null, // A, B reserved
    "Sequence Sample ID", // C
    "Primer",              // D
    null,                  // E (formula)
    null,                  // F
    "Job ID",              // G
    "Plate Date ID",       // H
    null,                  // I (formula)
    null,                  // J (formula)
    "Primer Short",        // K
    null,                  // L (formula)
  ];

  const ws = XLSX.utils.aoa_to_sheet([headerRow]);

  // Build the data rows + prepend 19 empty rows so cells start at A20.
  // We use sheet_add_aoa with origin="A20" which writes to A20, A21, ...
  const dataRows = [];
  let rowIdx = START_ROW; // 1-based row in the form
  for (const r of rows) {
    const seqValidationDir = `'[${seqValidationFilename}]Sequencing Pending'`;
    const formulaE = `CONCATENATE(C${rowIdx},"._.",G${rowIdx},"._.",D${rowIdx},"._.",H${rowIdx})`;
    const formulaI = `VLOOKUP(C${rowIdx},${seqValidationDir}!$D:$K,8,0)`;
    const formulaJ = `CONCATENATE(C${rowIdx}," ",I${rowIdx})`;
    const formulaL = `CONCATENATE(C${rowIdx},"._.",G${rowIdx},"._.",K${rowIdx},"._.",H${rowIdx})`;
    dataRows.push([
      null,                  // A
      null,                  // B
      r.sequenceSampleId,    // C
      r.primer,              // D
      { f: formulaE },       // E
      null,                  // F
      r.jobId,               // G
      r.dateId,              // H
      { f: formulaI },       // I
      { f: formulaJ },       // J
      r.primerShort,         // K
      { f: formulaL },       // L
    ]);
    rowIdx++;
  }
  if (dataRows.length > 0) {
    XLSX.utils.sheet_add_aoa(ws, dataRows, { origin: "A20" });
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");

  // Sheet 2: warnings, if any. The Python app surfaces these via messagebox;
  // we add them as a second sheet so they're persisted with the output.
  if (warnings.length > 0) {
    const wsW = XLSX.utils.aoa_to_sheet([
      ["Warnings"],
      ...warnings.map((w) => [w]),
    ]);
    XLSX.utils.book_append_sheet(wb, wsW, "Warnings");
  }

  return wb;
}

/**
 * Serialize the workbook to a Uint8Array ready to write to disk.
 */
export function serializeWorkbook(wb) {
  const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  return buf;
}
