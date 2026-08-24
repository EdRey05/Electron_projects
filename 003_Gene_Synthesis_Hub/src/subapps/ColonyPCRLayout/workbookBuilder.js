/**
 * Colony PCR Layout — workbook builder.
 *
 * Mirrors the rest of `fill_colony_pcr_layout`:
 *   - Load the Colony PCR template
 *   - Rename the active sheet to "Plate 1" + set plate header (date-prefixed)
 *   - Place clone labels at (row, col) -> Excel (row+3, col+2)
 *   - Write samples table below the plate (header at B13, data starts at B14)
 *   - Write mix calculation table (Taq, H2O, Fwd, Rev per primer pair)
 *   - Add a "Label" sheet with date/JobID/quantity info for each job
 *   - Apply thin borders to plate cells; thick borders around clone groups
 *   - Save as "{yearChar}{date_str}-ColonyPCR-FL.xlsx"
 *
 * Limitations of the xlsx library round-trip:
 *   - We can't preserve the template's visual styling (formatting, merged cells).
 *   - We can't replicate the python-docx-styled thick/thin border painting
 *     exactly; the xlsx library doesn't expose per-edge border styling.
 *   - The generated workbook contains the DATA + structure; users may need
 *     to re-apply template styling manually in Excel.
 *
 * To match the Python app's behavior closely, we GENERATE A FRESH WORKBOOK
 * (not mutate the template). Excel will open it as a regular .xlsx.
 */

import * as XLSX from "xlsx";

/**
 * Build the plate header text. Mirrors:
 *   year_char = chr(datetime.now().year - 1941)   # 2026-1941 = 85 -> 'U'
 *   date_str = "%m%d"
 *   header_text = f"{year_char}{date_str}ColonyPCR-P{p_num}"
 *
 * For August 23, 2026 -> "U0823ColonyPCR-P1"
 */
export function buildPlateHeader(date = new Date(), pNum = 1) {
  const yearChar = String.fromCharCode(date.getFullYear() - 1941);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yearChar}${mm}${dd}ColonyPCR-P${pNum}`;
}

/**
 * Build the suggested output filename (no path).
 * "{yearChar}{date_str}-ColonyPCR-FL.xlsx" -> "U0823-ColonyPCR-FL.xlsx"
 */
export function buildOutputFilename(date = new Date()) {
  const yearChar = String.fromCharCode(date.getFullYear() - 1941);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yearChar}${mm}${dd}-ColonyPCR-FL.xlsx`;
}

/**
 * Build a complete workbook from the plate placement plan + summary data.
 *
 * @param {object} plan       - output of planPlates()
 * @param {Array} summaryData - the rows after primer enrichment (unused here
 *                              since the per-plate samples table is derived
 *                              from the plate's jobs).
 * @returns {object} - xlsx-format workbook ready to write
 */
export function buildWorkbook(plan, summaryData = []) {
  const wb = XLSX.utils.book_new();

  // Build per-plate sheets.
  plan.plates.forEach((plate, idx) => {
    const pNum = idx + 1;
    const sheet = buildPlateSheet(plate, summaryData, pNum);
    XLSX.utils.book_append_sheet(wb, sheet, `Plate ${pNum}`);
  });

  // Build the Label sheet (always last, regardless of plate count).
  const labelSheet = buildLabelSheet(plan.plates, summaryData);
  XLSX.utils.book_append_sheet(wb, labelSheet, "Label");

  return wb;
}

/**
 * Build a single plate sheet. The structure is:
 *   A1: plate header
 *   A3..M10: 96-well plate grid (we place clone labels at row+3, col+2)
 *   B12..I12: "Plate N Samples" header (we write at row 13)
 *   B13..I13: column headers (JobID, BBID, Vector, Resistance, Primers, Length, Host, Temperature)
 *   B14..I_n: data rows
 *   Mix calculation table: starts a few rows below the samples table
 */
function buildPlateSheet(plate, summaryData, pNum) {
  // Build a sheet via direct cell assignment so we can use formula-like
  // values (we don't use formulas here, just strings).
  const sheet = {};
  // Set range to include all of our cells.
  sheet["!ref"] = "A1:M50";

  // A1: plate header
  const header = buildPlateHeader(new Date(), pNum);
  sheet["A1"] = { t: "s", v: header };

  // Place each clone at (row, col) -> Excel (row+3, col+2)
  for (const job of plate.jobs) {
    const cellRef = `${colLetter(job.col + 2)}${job.row + 3}`;
    sheet[cellRef] = { t: "s", v: job.label };
  }
  // Place each control
  for (const ctrl of plate.controls) {
    const cellRef = `${colLetter(ctrl.col + 2)}${ctrl.row + 3}`;
    sheet[cellRef] = { t: "s", v: ctrl.label };
  }

  // Samples table at row 13 (header), 14+ (data).
  const plateJobIds = new Set(plate.jobs.map((j) => j.jobId));
  const plateSummary = summaryData.filter((r) => plateJobIds.has(r.JobID));
  // Deduplicate by JobID
  const seen = new Set();
  const uniquePlateSummary = plateSummary.filter((r) => {
    if (seen.has(r.JobID)) return false;
    seen.add(r.JobID);
    return true;
  });

  const sampleHeaders = ["JobID", "BBID", "Vector", "Resistance", "Primers", "Length", "Host", "Temperature"];
  // Header row at row 13, cols B..I (indices 1..8)
  sampleHeaders.forEach((h, i) => {
    sheet[`${colLetter(i + 2)}13`] = { t: "s", v: h };
  });
  // Data rows starting at row 14
  uniquePlateSummary.forEach((row, rIdx) => {
    sampleHeaders.forEach((h, cIdx) => {
      sheet[`${colLetter(cIdx + 2)}${14 + rIdx}`] = { t: "s", v: row[h] ?? "" };
    });
  });

  // Mix calculation table. Header at B(n) where n = 14 + len(uniquePlateSummary) + 1
  // (one empty row between samples and mix). Rows: Taq, H2O, Fwd, Rev.
  const mixStartRow = 14 + uniquePlateSummary.length + 1;
  sheet[`B${mixStartRow}`] = { t: "s", v: "Mix Calculation" };
  sheet[`B${mixStartRow + 1}`] = { t: "s", v: "Taq" };
  sheet[`B${mixStartRow + 2}`] = { t: "s", v: "H2O" };
  sheet[`B${mixStartRow + 3}`] = { t: "s", v: "Fwd" };
  sheet[`B${mixStartRow + 4}`] = { t: "s", v: "Rev" };

  // One column per unique primer pair on this plate.
  // Compute clone counts per primer pair (sum of clones for jobs with that primer).
  const cloneCounts = new Map(); // jobId -> clone count
  for (const j of plate.jobs) {
    cloneCounts.set(j.jobId, (cloneCounts.get(j.jobId) ?? 0) + 1);
  }
  const primerGroups = new Map(); // primer -> Set<jobId>
  for (const j of plate.jobs) {
    if (!j.primers) continue;
    if (!primerGroups.has(j.primers)) primerGroups.set(j.primers, new Set());
    primerGroups.get(j.primers).add(j.jobId);
  }

  let mixCol = 3; // column C, after the row labels
  for (const [primer, jobIds] of primerGroups.entries()) {
    let totalClones = 0;
    for (const jobId of jobIds) totalClones += cloneCounts.get(jobId) ?? 0;
    if (totalClones === 0) continue;
    sheet[`${colLetter(mixCol)}${mixStartRow}`] = { t: "s", v: primer };
    sheet[`${colLetter(mixCol)}${mixStartRow + 1}`] = { t: "n", v: 10 * (totalClones + 1) };
    sheet[`${colLetter(mixCol)}${mixStartRow + 2}`] = { t: "n", v: 8.4 * (totalClones + 1) };
    sheet[`${colLetter(mixCol)}${mixStartRow + 3}`] = { t: "n", v: 0.8 * (totalClones + 1) };
    sheet[`${colLetter(mixCol)}${mixStartRow + 4}`] = { t: "n", v: 0.8 * (totalClones + 1) };
    mixCol += 1;
  }

  // Set column widths B..M = 25 (mirrors the Python source).
  sheet["!cols"] = [];
  for (let i = 1; i <= 13; i++) {
    sheet["!cols"][i] = { width: 25 };
  }

  return sheet;
}

function buildLabelSheet(plates, summaryData) {
  const headers = ["Date", "PRINTED", "ITEM #", "SIZE", "QTY", "LOT#1", "PERSON", "REASSAY DATE", "LOT#2"];
  const aoa = [headers];
  const now = new Date();
  const dateStrMdy = `${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}-${now.getFullYear()}`;
  const yearChar = String.fromCharCode(now.getFullYear() - 1941);
  const dateCode = `${yearChar}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const colopcrDateCode = dateCode;

  // For each unique (jobId, sourceFile) with clones > 0
  const cloneCounts = new Map(); // (jobId, sourceFile) -> total clones
  for (const plate of plates) {
    for (const j of plate.jobs) {
      const key = `${j.jobId}\0${jobSourceFile(j, summaryData)}`;
      cloneCounts.set(key, (cloneCounts.get(key) ?? 0) + 1);
    }
  }
  const seen = new Set();
  for (const plate of plates) {
    for (const j of plate.jobs) {
      const key = `${j.jobId}\0${jobSourceFile(j, summaryData)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const count = cloneCounts.get(key);
      if (count === 0) continue;
      const sourceFile = jobSourceFile(j, summaryData);
      const itemNum = `${j.jobId}-ColoPCR`;
      const lot1 = `${colopcrDateCode}-${itemNum}-FL`;
      // Strip trailing "-FL" from the ligation filename basename.
      let ligationBasename = sourceFile.split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
      if (ligationBasename.toUpperCase().endsWith("-FL")) {
        ligationBasename = ligationBasename.slice(0, -3);
      }
      const lot2 = `${ligationBasename}._.${colopcrDateCode}-ColoPCR._.${j.jobId}`;
      aoa.push([dateStrMdy, null, itemNum, "2x1", 1, lot1, null, null, lot2]);
    }
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  return ws;
}

function jobSourceFile(j, summaryData) {
  const row = summaryData.find((r) => r.JobID === j.jobId);
  return row ? row.SourceFile : "";
}

function colLetter(idx) {
  // 1 -> A, 2 -> B, ..., 26 -> Z, 27 -> AA
  let s = "";
  while (idx > 0) {
    const rem = (idx - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    idx = Math.floor((idx - 1) / 26);
  }
  return s;
}

export function serializeWorkbook(wb) {
  return XLSX.write(wb, { bookType: "xlsx", type: "array" });
}
