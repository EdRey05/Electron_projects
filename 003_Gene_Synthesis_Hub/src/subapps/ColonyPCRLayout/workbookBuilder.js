/**
 * Colony PCR Layout — TEMPLATE-BASED workbook builder.
 *
 * WHY THE TEMPLATE MATTERS
 * ------------------------
 * The Python original does NOT generate a fresh workbook. It loads
 * `Templates/ColonyPCR_layout_v3.xlsx` with openpyxl and MUTATES it:
 *
 *     wb = openpyxl.load_workbook(colony_pcr_template_path)   # :944
 *     ws = wb.active
 *     ws.title = "Plate 1"
 *
 * and every additional plate is a COPY of the template sheet
 * (`workbook.copy_worksheet(template_sheet)`, :1080-1099).
 *
 * The template carries the printed 96-well plate frame:
 *   - row 2     → the column numbers 1..12 (B2..M2)
 *   - column A  → the row letters A..H (A3..A10)
 *   - the border style of every grid cell
 *   - the merged section headers (B1:C1, B11:G11, H11:M11)
 *   - the column widths and the print setup
 *
 * A from-scratch workbook (what the React port used to do) has NO grid
 * labels at all — a printed plate cannot be read. It also has no borders,
 * so it is not usable as a bench worksheet.
 *
 * SheetJS (xlsx) cannot write cell styles, so the React port could not
 * reproduce the template. This module uses ExcelJS, which CAN read the
 * template's styles and write them back out.
 *
 * WHAT IS REPRODUCED
 * ------------------
 *   - the plate frame (row letters + column numbers) and its borders
 *   - thin borders on the plate grid and on the samples / mix tables
 *   - THICK borders around each clone group, including the Python's
 *     L-shaped variant for a group that does not fill its last column
 *   - the samples table (canonical headers) and the mix calculation table
 *   - the "Label" sheet with one row per job
 *   - the canonical output filename
 */

import ExcelJS from "exceljs";
import * as XLSX from "xlsx";

/** The plate grid occupies rows 3-10 and columns B-M in the template. */
const GRID_ROW_START = 3;
const GRID_ROW_END = 10;
const GRID_COL_START = 2; // column B
const GRID_COL_END = 13; // column M

/** The samples table starts at row 13 (header) with data from row 14. */
const SAMPLES_HEADER_ROW = 13;
const SAMPLES_FIRST_DATA_ROW = 14;

/**
 * Canonical column names, matching the Python
 * (`headers = ["Work No.", "BBI ID", "Vector", "Resistance", "Primers",
 *               "Length (bp)", "Host", "Temperature"]`).
 */
const SAMPLE_HEADERS = [
  "Work No.",
  "BBI ID",
  "Vector",
  "Resistance",
  "Primers",
  "Length (bp)",
  "Host",
  "Temperature",
];

/**
 * Build the plate header text. Mirrors:
 *   year_char = chr(datetime.now().year - 1941)   # 2026-1941 = 85 -> 'U'
 *   date_str = "%m%d"
 *   header_text = f"{year_char}{date_str}ColonyPCR-P{p_num}"
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
 * Build the workbook from the plate placement plan + summary data.
 *
 * This is the ASYNC, template-based replacement for the old synchronous
 * `buildWorkbook()`. It reads the template, mutates it the way the Python
 * does, and returns the serialized bytes.
 *
 * @param {object} plan       - output of planPlates()
 * @param {Array}  summaryData - the rows after primer enrichment
 * @param {Map}    requestedCloneCounts - ("Work No.", SourceFile) -> count
 * @param {ArrayBuffer|Uint8Array} templateBytes - the Colony PCR template
 * @param {Date}   date        - the run date (for the plate header)
 * @returns {Promise<Uint8Array>} the .xlsx bytes
 */
export async function buildWorkbookBytes(
  plan,
  summaryData = [],
  requestedCloneCounts = new Map(),
  templateBytes = null,
  date = new Date()
) {
  const wb = new ExcelJS.Workbook();
  if (templateBytes) {
    // ExcelJS wants a Buffer/ArrayBuffer; a Uint8Array view is accepted.
    await wb.xlsx.load(templateBytes);
  } else {
    // No template available — fall back to an empty book so the app still
    // produces output rather than throwing.
    wb.addWorksheet("Plate 1");
  }

  // The template's sheet is the "Plate 1" template. Keep a pristine copy
  // of it so each additional plate can be cloned from it, exactly as the
  // Python's `copy_worksheet(template_sheet)` does.
  const templateSheet = wb.getWorksheet(1);
  const templateSnapshot = snapshotSheet(templateSheet);

  const plates = plan.plates ?? [];

  plates.forEach((plate, idx) => {
    const pNum = idx + 1;
    const ws =
      pNum === 1
        ? templateSheet
        : cloneSheet(wb, templateSnapshot, `Plate ${pNum}`);
    writePlateSheet(ws, plate, summaryData, pNum, requestedCloneCounts, date);
  });

  // The Label sheet is always last.
  writeLabelSheet(wb, plates, summaryData, date);

  return await wb.xlsx.writeBuffer();
}

/**
 * Build the Label sheet.
 *
 * The Python (`generate_labels_sheet`) writes one row per job with a
 * clone count > 0:
 *   Date | PRINTED | ITEM # | SIZE | QTY | LOT#1 | PERSON | REASSAY DATE | LOT#2
 */
function writeLabelSheet(wb, plates, summaryData, date) {
  const existing = wb.getWorksheet("Label");
  if (existing) wb.removeWorksheet(existing.id);

  const ws = wb.addWorksheet("Label");

  const headers = [
    "Date",
    "PRINTED",
    "ITEM #",
    "SIZE",
    "QTY",
    "LOT#1",
    "PERSON",
    "REASSAY DATE",
    "LOT#2",
  ];
  headers.forEach((h, i) => {
    ws.getRow(1).getCell(i + 1).value = h;
  });

  const dateStrMdy = `${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate()
  ).padStart(2, "0")}-${date.getFullYear()}`;
  const yearChar = String.fromCharCode(date.getFullYear() - 1941);
  const dateCode = `${yearChar}${String(date.getMonth() + 1).padStart(2, "0")}${String(
    date.getDate()
  ).padStart(2, "0")}`;
  const colopcrDateCode = dateCode;

  // One row per unique (Work No., SourceFile) that has clones > 0.
  const cloneCounts = new Map();
  for (const plate of plates) {
    for (const j of plate.jobs) {
      const key = `${j.jobId}\0${jobSourceFile(j, summaryData)}`;
      cloneCounts.set(key, (cloneCounts.get(key) ?? 0) + 1);
    }
  }

  const seen = new Set();
  let rowIdx = 2;
  for (const plate of plates) {
    for (const j of plate.jobs) {
      const key = `${j.jobId}\0${jobSourceFile(j, summaryData)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if ((cloneCounts.get(key) ?? 0) === 0) continue;

      const sourceFile = jobSourceFile(j, summaryData);
      const itemNum = `${j.jobId}-ColoPCR`;
      const lot1 = `${colopcrDateCode}-${itemNum}-FL`;

      // Strip a trailing "-FL" from the ligation filename's basename.
      let ligationBasename = sourceFile.split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
      if (ligationBasename.toUpperCase().endsWith("-FL")) {
        ligationBasename = ligationBasename.slice(0, -3);
      }
      const lot2 = `${ligationBasename}._.${colopcrDateCode}-ColoPCR._.${j.jobId}`;

      const row = ws.getRow(rowIdx);
      row.getCell(1).value = dateStrMdy;
      row.getCell(2).value = null;
      row.getCell(3).value = itemNum;
      row.getCell(4).value = "2x1";
      row.getCell(5).value = 1;
      row.getCell(6).value = lot1;
      row.getCell(7).value = null;
      row.getCell(8).value = null;
      row.getCell(9).value = lot2;
      rowIdx += 1;
    }
  }

  // Column widths = longest cell + 2, matching the Python
  // (`label_ws.column_dimensions[...].width = max_length + 2`).
  for (let c = 1; c <= headers.length; c++) {
    let maxLength = 0;
    for (let r = 1; r <= rowIdx - 1; r++) {
      const v = ws.getRow(r).getCell(c).value;
      if (v == null) continue;
      const len = String(v).length;
      if (len > maxLength) maxLength = len;
    }
    ws.getColumn(c).width = maxLength + 2;
  }
}

/**
 * Write one plate: the clone grid, the samples table, the mix calculation
 * table and the borders.
 */
function writePlateSheet(ws, plate, summaryData, pNum, requestedCloneCounts, date) {
  ws.name = `Plate ${pNum}`;

  // A1: the plate header (bold, matching the Python's Font(bold=True)).
  const headerCell = ws.getCell("A1");
  headerCell.value = buildPlateHeader(date, pNum);
  setCellFont(ws, 1, 1, { ...(headerCell.font || {}), bold: true });

  // --- The plate grid -------------------------------------------------
  // Clear the grid's contents but keep the template's frame (the row
  // letters in column A and the column numbers in row 2 are OUTSIDE the
  // grid, so they survive).
  for (let r = GRID_ROW_START; r <= GRID_ROW_END; r++) {
    for (let c = GRID_COL_START; c <= GRID_COL_END; c++) {
      const cell = ws.getRow(r).getCell(c);
      cell.value = null;
      setCellFont(ws, r, c, {});
    }
  }
  // Thin border on every grid cell (the Python clears the grid and applies
  // a thin border to each cell).
  applyThinBorders(ws, GRID_ROW_START, GRID_COL_START, GRID_ROW_END, GRID_COL_END);

  // Place the clones.
  for (const job of plate.jobs) {
    ws.getRow(job.row + GRID_ROW_START).getCell(job.col + GRID_COL_START).value = job.label;
  }
  // Place the controls.
  for (const ctrl of plate.controls) {
    ws.getRow(ctrl.row + GRID_ROW_START).getCell(ctrl.col + GRID_COL_START).value = ctrl.label;
  }

  // --- Clone-group borders -------------------------------------------
  // One thick outline per clone group. The Python groups the clones of a
  // job, and draws a rectangle — or an L-shape when the group does not
  // fill its last column.
  const groups = new Map();
  for (const job of plate.jobs) {
    const key = `${job.groupStartRow}\0${job.groupStartCol}\0${job.groupEndCol}`;
    if (!groups.has(key)) {
      groups.set(key, {
        startRow: job.groupStartRow,
        startCol: job.groupStartCol,
        endCol: job.groupEndCol,
        cloneCount: job.cloneCount,
        cells: [],
      });
    }
    groups.get(key).cells.push({ row: job.row, col: job.col });
  }
  for (const g of groups.values()) {
    applyThickBorderToRange(ws, g);
  }
  // The controls get a thick outline around their (single) column.
  if (plate.controls.length) {
    const first = plate.controls[0];
    const last = plate.controls[plate.controls.length - 1];
    applyThickBorderToRange(ws, {
      startRow: first.row,
      startCol: first.groupStartCol,
      endCol: first.groupStartCol,
      cloneCount: null,
      cells: plate.controls.map((c) => ({ row: c.row, col: c.col })),
      endRow: last.row,
    });
  }

  // --- The samples table ----------------------------------------------
  const plateJobIds = new Set(plate.jobs.map((j) => j.jobId));
  const plateSummary = summaryData.filter((r) => plateJobIds.has(r["Work No."]));
  // Deduplicate by "Work No."
  const seen = new Set();
  const uniquePlateSummary = plateSummary.filter((r) => {
    if (seen.has(r["Work No."])) return false;
    seen.add(r["Work No."]);
    return true;
  });

  // Clear the previous samples table (the Python clears B..I for every
  // row from the start row to the end of the sheet).
  for (let r = SAMPLES_HEADER_ROW; r <= Math.max(ws.rowCount, SAMPLES_HEADER_ROW); r++) {
    for (let c = 2; c <= 9; c++) {
      ws.getRow(r).getCell(c).value = null;
    }
  }

  // Header row.
  SAMPLE_HEADERS.forEach((h, i) => {
    const cell = ws.getRow(SAMPLES_HEADER_ROW).getCell(i + 2);
    cell.value = h;
    setCellFont(ws, SAMPLES_HEADER_ROW, i + 2, { ...(cell.font || {}), bold: true });
  });

  // Data rows.
  uniquePlateSummary.forEach((row, rIdx) => {
    const excelRow = SAMPLES_FIRST_DATA_ROW + rIdx;
    SAMPLE_HEADERS.forEach((h, cIdx) => {
      const v = row[h];
      const cell = ws.getRow(excelRow).getCell(cIdx + 2);
      // Numeric fields (Length (bp)) must be written as NUMBERS, not text —
      // the Python writes the pandas value as-is.
      const isNumeric =
        h === "Length (bp)" && v !== "" && v != null && !Number.isNaN(Number(v));
      cell.value = isNumeric ? Number(v) : (v ?? "");
    });
  });

  // Thin borders around the samples table.
  if (uniquePlateSummary.length > 0) {
    applyThinBorders(
      ws,
      SAMPLES_HEADER_ROW,
      2,
      SAMPLES_FIRST_DATA_ROW + uniquePlateSummary.length - 1,
      9
    );
  }

  // --- The mix calculation table --------------------------------------
  // The Python's `write_samples_table` returns `start_row + len(samples_df)
  // + 1` (i.e. one row BELOW the last data row, which is the empty
  // separator), and the mix table is then written at `samples_end_row + 1`.
  const samplesEndRow = SAMPLES_FIRST_DATA_ROW + uniquePlateSummary.length;
  const mixStartRow = samplesEndRow + 1;

  const mixHeader = ws.getRow(mixStartRow).getCell(2);
  mixHeader.value = "Mix Calculation";
  setCellFont(ws, mixStartRow, 2, { ...(mixHeader.font || {}), bold: true });

  const mixLabels = ["Taq", "H2O", "Fwd", "Rev"];
  mixLabels.forEach((label, i) => {
    ws.getRow(mixStartRow + 1 + i).getCell(2).value = label;
  });

  // One column per unique primer pair on this plate. The clone count comes
  // from the REQUESTED counts (what the operator typed into the clone-count
  // dialog), not from the clones actually placed — the Python sums
  // `all_clone_counts` for every job on the plate that shares the primer.
  const primerGroups = new Map();
  for (const j of plate.jobs) {
    if (!j.primers) continue;
    if (!primerGroups.has(j.primers)) primerGroups.set(j.primers, new Set());
    primerGroups.get(j.primers).add(j.jobId);
  }

  let mixCol = 3; // column C, after the row labels
  let lastMixCol = 2;
  for (const [primer, jobIds] of primerGroups.entries()) {
    let totalClones = 0;
    for (const jobId of jobIds) {
      const key = `${jobId}\0${sourceFileFor(jobId, summaryData)}`;
      totalClones += requestedCloneCounts.get(key) ?? 0;
    }
    if (totalClones === 0) continue;

    const headerCell = ws.getRow(mixStartRow).getCell(mixCol);
    headerCell.value = primer;
    setCellFont(ws, mixStartRow, mixCol, { ...(headerCell.font || {}), bold: true });

    ws.getRow(mixStartRow + 1).getCell(mixCol).value = 10 * (totalClones + 1);
    ws.getRow(mixStartRow + 2).getCell(mixCol).value = 8.4 * (totalClones + 1);
    ws.getRow(mixStartRow + 3).getCell(mixCol).value = 0.8 * (totalClones + 1);
    ws.getRow(mixStartRow + 4).getCell(mixCol).value = 0.8 * (totalClones + 1);
    lastMixCol = mixCol;
    mixCol += 1;
  }

  // Thin borders around the mix table.
  if (lastMixCol > 2) {
    applyThinBorders(ws, mixStartRow, 2, mixStartRow + 4, lastMixCol);
  }
}

/**
 * Set a cell's border WITHOUT mutating a shared style object.
 *
 * WHY THIS IS NOT `cell.border = ...`
 * -----------------------------------
 * ExcelJS gives every cell that came from the same `<xf>` index in the
 * template the SAME style OBJECT — `cell.style` is not a copy:
 *
 *     ws.getCell("B3").style === ws.getCell("B4").style   // true
 *
 * and `cell.border = x` is a setter that writes into that shared object
 * (`this.style.border = value`). So setting a border on one cell silently
 * repaints every other cell that shares the style — the whole plate grid
 * ends up with the LAST border that was written.
 *
 * Assigning a FRESH style object per cell breaks the sharing, so each
 * cell keeps its own border.
 */
function setCellBorder(ws, row, col, border) {
  const cell = ws.getRow(row).getCell(col);
  cell.style = { ...(cell.style || {}), border };
}

/**
 * Set a cell's font without mutating a shared style object.
 * Same sharing problem as setCellBorder().
 */
function setCellFont(ws, row, col, font) {
  const cell = ws.getRow(row).getCell(col);
  cell.style = { ...(cell.style || {}), font };
}

/** A thin border on every cell of a rectangular range. */
function applyThinBorders(ws, startRow, startCol, endRow, endCol) {
  const side = { style: "thin", color: { indexed: 64 } };
  for (let r = startRow; r <= endRow; r++) {
    for (let c = startCol; c <= endCol; c++) {
      setCellBorder(ws, r, c, { left: side, right: side, top: side, bottom: side });
    }
  }
}

/**
 * Draw the thick outline around a clone group.
 *
 * Mirrors the Python's `apply_thick_border_to_range`:
 *   - a rectangular outline when the group fills its bounding rectangle
 *   - an L-SHAPED outline when the group does not fill its last column
 *     (the border traces around the cells that actually hold a clone)
 */
function applyThickBorderToRange(ws, group) {
  const thick = { style: "thick", color: { indexed: 64 } };
  const thin = { style: "thin", color: { indexed: 64 } };

  const startRow = group.startRow;
  const startCol = group.startCol;
  const endCol = group.endCol;
  const endRow =
    group.endRow ?? group.cells.reduce((m, c) => Math.max(m, c.row), startRow);

  const numColumns = endCol - startCol + 1;

  // The set of cells that actually hold a clone.
  const filled = new Set(group.cells.map((c) => `${c.row}\0${c.col}`));

  // Does the group need the L-shaped treatment? The Python decides this
  // from the clone count and the starting row: a group that wraps into a
  // new column but does not fill that column is L-shaped.
  let useLShaped = false;
  if (group.cloneCount != null && numColumns > 1) {
    const availableInFirstCol = 8 - startRow;
    if (group.cloneCount > availableInFirstCol) {
      const remaining = (group.cloneCount - availableInFirstCol) % 8;
      if (remaining > 0 && remaining < 8) useLShaped = true;
    }
  }

  for (let r = startRow; r <= endRow; r++) {
    for (let c = startCol; c <= endCol; c++) {
      if (useLShaped && !filled.has(`${r}\0${c}`)) {
        // Empty cell inside the group's bounding box — thin border only.
        setCellBorder(ws, r + GRID_ROW_START, c + GRID_COL_START, {
          left: thin,
          right: thin,
          top: thin,
          bottom: thin,
        });
        continue;
      }
      if (useLShaped) {
        // Thick on any edge where the neighbour does not hold a clone.
        const hasAbove = filled.has(`${r - 1}\0${c}`);
        const hasBelow = filled.has(`${r + 1}\0${c}`);
        const hasLeft = c - 1 >= startCol && filled.has(`${r}\0${c - 1}`);
        const hasRight = filled.has(`${r}\0${c + 1}`);
        setCellBorder(ws, r + GRID_ROW_START, c + GRID_COL_START, {
          left: hasLeft ? thin : thick,
          right: hasRight ? thin : thick,
          top: hasAbove ? thin : thick,
          bottom: hasBelow ? thin : thick,
        });
      } else {
        // Plain rectangle.
        setCellBorder(ws, r + GRID_ROW_START, c + GRID_COL_START, {
          left: c === startCol ? thick : thin,
          right: c === endCol ? thick : thin,
          top: r === startRow ? thick : thin,
          bottom: r === endRow ? thick : thin,
        });
      }
    }
  }
}

/**
 * Snapshot a worksheet so it can be cloned into a new sheet.
 * Mirrors openpyxl's `workbook.copy_worksheet()`.
 */
function snapshotSheet(ws) {
  const cells = [];
  ws.eachRow({ includeEmpty: true }, (row, rIdx) => {
    row.eachCell({ includeEmpty: true }, (cell, cIdx) => {
      cells.push({
        r: rIdx,
        c: cIdx,
        value: cell.value,
        style: cell.style ? JSON.parse(JSON.stringify(cell.style)) : null,
        numFmt: cell.numFmt,
      });
    });
  });
  const cols = [];
  for (let c = 1; c <= 16; c++) {
    const col = ws.getColumn(c);
    cols.push({
      width: col.width,
      style: col.style ? JSON.parse(JSON.stringify(col.style)) : null,
    });
  }
  const rows = [];
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    rows.push({ height: row.height });
  }
  return {
    name: ws.name,
    cells,
    cols,
    rows,
    merges: (ws.model.merges || []).slice(),
    pageSetup: { ...ws.pageSetup },
    views: ws.views ? JSON.parse(JSON.stringify(ws.views)) : undefined,
    properties: { ...ws.properties },
  };
}

/** Rebuild a worksheet from a snapshot taken by snapshotSheet(). */
function cloneSheet(wb, snap, name) {
  const ws = wb.addWorksheet(name, {
    properties: snap.properties,
    pageSetup: snap.pageSetup,
    views: snap.views,
  });

  for (let c = 1; c <= snap.cols.length; c++) {
    const src = snap.cols[c - 1];
    if (!src) continue;
    const dst = ws.getColumn(c);
    if (src.width != null) dst.width = src.width;
    if (src.style) dst.style = src.style;
  }

  for (const cellInfo of snap.cells) {
    const cell = ws.getRow(cellInfo.r).getCell(cellInfo.c);
    cell.value = cellInfo.value;
    if (cellInfo.style) cell.style = cellInfo.style;
  }

  for (let r = 1; r < snap.rows.length; r++) {
    if (snap.rows[r].height != null) ws.getRow(r + 1).height = snap.rows[r].height;
  }

  for (const m of snap.merges) {
    try {
      ws.mergeCells(m);
    } catch (e) {
      // A merge that cannot be applied is not fatal.
    }
  }

  return ws;
}

/** The SourceFile for a Work No. — the second half of the clone-count key. */
function sourceFileFor(jobId, summaryData) {
  const row = summaryData.find((r) => r["Work No."] === jobId);
  return row ? row.SourceFile : "";
}

function jobSourceFile(j, summaryData) {
  return sourceFileFor(j.jobId, summaryData);
}

/**
 * Serialize a SheetJS workbook to .xlsx bytes.
 * Kept for API compatibility with the previous SheetJS-based builder.
 */
export function serializeWorkbook(wb) {
  return XLSX.write(wb, { bookType: "xlsx", type: "array" });
}
