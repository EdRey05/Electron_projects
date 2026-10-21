/**
 * Sequencing Order Form — row builder + TEMPLATE-BASED workbook emitter.
 *
 * Mirrors `fill_order_form` from the Python source (v4.5).
 *
 * THE OUTPUT IS THE EMPTY ORDER FORM TEMPLATE, MUTATED
 * ------------------------------------------------------
 * The Python does NOT generate a fresh workbook:
 *
 *     wb = openpyxl.load_workbook(empty_form)   # :116
 *     sheet = wb.active                          # :117
 *
 * so the emitted order form keeps the template's real header row (row 19),
 * its 12 merged regions (including the B18:D18 block that carries the order
 * form ID), its column widths, its styling, its print settings and its
 * SHEET NAME ("Order form"). The Sequencing Layout workbook links to the
 * order form by that sheet name, so a sheet called "Sheet1" breaks the
 * link.
 *
 * ExcelJS reads the template's styles/merges and writes them back out, so
 * it can reproduce the template faithfully. (SheetJS — the `xlsx` package —
 * cannot write cell styles at all, which is why the previous React port
 * emitted a bare data table.)
 *
 * WHAT IS WRITTEN
 * ---------------
 * Starting at row 20, one row per sample per primer:
 *   B = Sample Type      — "Purified PCR product" when the sample ID carries
 *                          the PFr or PCR marker, otherwise "Plasmid"
 *   C = Sequence Sample ID (Plasmid ID / Vector #)
 *   D = Primer name
 *   E = formula: =CONCATENATE(C, "._.", G, "._.", D, "._.", H)
 *   F = Working concentration — always "40-60 ng/uL"
 *   G = Work No.
 *   H = date_ID (output folder basename)
 *   I = formula: =VLOOKUP(C, '<output_dir>/[<seq_validation>]Sequencing Pending'!$D:$K, 8, 0)
 *   J = formula: =CONCATENATE(C, " ", I)
 *   K = primer.split("(*", 1)[0].strip()
 *   L = formula: =CONCATENATE(C, "._.", G, "._.", K, "._.", H)
 *
 * Cell B18 (merged B18:D18) carries the order form reference ID:
 *   'Q' + <year> + <MMDD> + <order form number>
 * where the year comes from the date_ID's LETTER PREFIX (S=2024, T=2025,
 * U=2026 — one letter per year) and MMDD from its digits. The order form
 * number is the part after the dash, or 1 when there is no dash. When the
 * date_ID carries no letter or no digits, the template value is left in
 * place and a warning is emitted.
 */

import ExcelJS from "exceljs";
import { unzipSync, zipSync } from "fflate";
import {
  restoreConditionalFormatting,
  resolveSheetPart,
} from "../../ui/xlsxEdit.js";

const START_ROW = 20; // 1-based, matches the Python original

/** The sheet the Python's `wb.active` resolves to in the template. */
export const ORDER_FORM_SHEET_NAME = "Order form";

/**
 * Derive the order form ID (cell B18) from the Sequencing_ID / date_ID.
 *
 * The date_ID is a YEAR LETTER + zero-padded MMDD, optionally followed by
 * "-<N>" (the Nth order form of that day):
 *   U0304-1 -> "Q202603041"
 *   U1015   -> "Q202610151"
 *   T1215-1 -> "Q202512151"
 *
 * The letter IS the year code and beats the system clock: S=2024, T=2025,
 * U=2026 — one letter per year, moving backwards from the anchor.
 *
 * Returns { id, warning } — `id` is null when the date_ID is undecipherable
 * (the caller then leaves the template value in place).
 */
export function deriveOrderFormId(dateId) {
  const raw = String(dateId ?? "").trim();
  const dashIdx = raw.indexOf("-");
  const dateCode = dashIdx >= 0 ? raw.slice(0, dashIdx) : raw;
  const formNumber = dashIdx >= 0 ? raw.slice(dashIdx + 1).trim() : "";

  const codeDigits = (dateCode.match(/\d/g) || []).join("");
  const yearCode = (dateCode.match(/[A-Za-z]/g) || []).join("");

  let year = null;
  if (yearCode) {
    // Reversed from the inhouse-app year-letter scheme: base year 2024 = 'S'.
    year = 2024 + (yearCode.toUpperCase().charCodeAt(0) - "S".charCodeAt(0));
  }

  if (!codeDigits || !year) {
    return {
      id: null,
      warning:
        `Could not derive the order form ID (B18) from Sequencing_ID '${raw}'. ` +
        `Template value left in place.`,
    };
  }
  const identifier = formNumber || "1";
  return { id: `Q${year}${codeDigits}${identifier}`, warning: null };
}

/**
 * The sample type for a row: purified PCR products carry the PFr or PCR
 * marker in the sample ID; everything else is a plasmid.
 */
export function sampleTypeFor(sampleId) {
  const text = String(sampleId ?? "");
  return text.includes("PFr") || text.includes("PCR")
    ? "Purified PCR product"
    : "Plasmid";
}

/** The working concentration written to column F on every filled row. */
export const WORKING_CONCENTRATION = "40-60 ng/uL";

/**
 * Build the row objects that will become the filled form rows.
 *
 * @param {Array<[string, string]>} orderedSamples  - [[workNo, sampleId], ...]
 * @param {Object} primersDict                       - {workNo -> [primer, ...]}
 * @param {string} dateId                            - basename of output folder
 * @returns {{ rows: Array, warnings: Array<string>, orderFormId: string|null }}
 */
export function buildFormRows(orderedSamples, primersDict, dateId) {
  const rows = [];
  const warnings = [];
  const reportedMissing = new Set();

  for (const [workNo, sequenceSampleId] of orderedSamples) {
    const primers = primersDict[workNo] || [];
    if (primers.length === 0) {
      if (!reportedMissing.has(workNo)) {
        warnings.push(`Work No. ${workNo}: No primers found in the primer log. Skipping.`);
        reportedMissing.add(workNo);
      }
      continue;
    }
    for (const primer of primers) {
      rows.push({
        workNo,
        sequenceSampleId,
        primer,
        primerShort: String(primer).split("(*", 1)[0].trim(),
        sampleType: sampleTypeFor(sequenceSampleId),
        dateId,
      });
    }
  }

  const { id: orderFormId, warning } = deriveOrderFormId(dateId);
  if (warning) warnings.push(warning);

  return { rows, warnings, orderFormId };
}

/**
 * The VLOOKUP reference path for column I.
 *
 * The Python (`sequencing_order_form_app.py:196-199`):
 *
 *     validation_filename = os.path.basename(seq_validation_file)
 *     dir_I = str(output_dir) + f"/[{validation_filename}]Sequencing Pending"
 *     formula_I = f"=VLOOKUP(C{row},'{dir_I}'!$D:$K,8,0)"
 *
 * so the reference is the ABSOLUTE output directory + a forward slash + the
 * bracketed validation filename + the sheet name. The output directory is
 * the folder that holds the Sequencing Validation file, which is where the
 * order form is written too.
 *
 * @param {string} outputDir            absolute path of the output folder
 * @param {string} seqValidationFilename basename of the validation workbook
 * @returns {string} e.g. "C:\\runs\\U0304/[Sequencing_validation_v6.xlsx]Sequencing Pending"
 */
export function buildValidationRefPath(outputDir, seqValidationFilename) {
  return `${outputDir}/[${seqValidationFilename}]Sequencing Pending`;
}

/**
 * The four formula strings for one row, exactly as the Python writes them.
 * (The leading "=" is dropped because openpyxl — and ExcelJS — store the
 * formula body only.)
 *
 * @param {number} row                   the 1-based Excel row
 * @param {string} validationRefPath     see buildValidationRefPath()
 * @returns {{E: string, I: string, J: string, L: string}}
 */
export function buildRowFormulas(row, validationRefPath) {
  return {
    E: `CONCATENATE(C${row},"._.",G${row},"._.",D${row},"._.",H${row})`,
    I: `VLOOKUP(C${row},'${validationRefPath}'!$D:$K,8,0)`,
    J: `CONCATENATE(C${row}," ",I${row})`,
    L: `CONCATENATE(C${row},"._.",G${row},"._.",K${row},"._.",H${row})`,
  };
}

/**
 * Build the filled order form from the Empty Order Form template.
 *
 * This is the React equivalent of the Python's `fill_order_form()`: it
 * MUTATES the template rather than generating a fresh workbook, so the
 * output keeps the real order form (header row 19, the merged blocks, the
 * column widths, the print setup and the "Order form" sheet name).
 *
 * @param {{rows, warnings, orderFormId}} built    from buildFormRows()
 * @param {object} opts
 * @param {ArrayBuffer|Uint8Array} opts.templateBytes  the Empty Order Form
 * @param {string} opts.outputDir                absolute output folder
 * @param {string} opts.seqValidationFilename    basename of the validation file
 * @returns {Promise<Uint8Array>} the .xlsx bytes
 */
export async function buildOrderFormBytes(built, opts) {
  const { rows = [], orderFormId = null } = built || {};
  const { templateBytes, outputDir = "", seqValidationFilename = "" } = opts || {};

  if (!templateBytes) {
    throw new Error(
      "The Empty Order Form template is required — the output is the template, filled in."
    );
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(toArrayBuffer(templateBytes));

  // `wb.active` in openpyxl terms — the template has a single sheet.
  const ws = activeWorksheet(wb);
  if (!ws) throw new Error("The Empty Order Form template has no worksheet.");

  // Cell B18 carries the order form reference ID. It sits in a merged
  // B18:D18 block, so we only write the master cell.
  if (orderFormId) {
    ws.getCell("B18").value = orderFormId;
  }

  const validationRefPath = buildValidationRefPath(outputDir, seqValidationFilename);

  let rowIdx = START_ROW; // 1-based row in the form
  for (const r of rows) {
    const f = buildRowFormulas(rowIdx, validationRefPath);
    ws.getCell(`B${rowIdx}`).value = r.sampleType;
    ws.getCell(`C${rowIdx}`).value = r.sequenceSampleId;
    ws.getCell(`D${rowIdx}`).value = r.primer;
    ws.getCell(`E${rowIdx}`).value = { formula: f.E };
    ws.getCell(`F${rowIdx}`).value = WORKING_CONCENTRATION;
    ws.getCell(`G${rowIdx}`).value = r.workNo;
    ws.getCell(`H${rowIdx}`).value = r.dateId;
    ws.getCell(`I${rowIdx}`).value = { formula: f.I };
    ws.getCell(`J${rowIdx}`).value = { formula: f.J };
    ws.getCell(`K${rowIdx}`).value = r.primerShort;
    ws.getCell(`L${rowIdx}`).value = { formula: f.L };
    rowIdx++;
  }

  // The formulas carry no cached value, so Excel must recalculate them on
  // open — otherwise column I (the VLOOKUP) shows blank.
  wb.calcProperties = { ...(wb.calcProperties || {}), fullCalcOnLoad: true };

  const out = await wb.xlsx.writeBuffer();
  return restoreTemplateConditionalFormatting(
    toUint8Array(out),
    toUint8Array(templateBytes)
  );
}

/**
 * Put the template's `<conditionalFormatting>` blocks back into the
 * re-emitted sheet.
 *
 * ExcelJS parses the template's "highlight duplicate values" rule but has
 * no renderer for the `duplicateValues` type, so it writes an EMPTY
 * `<conditionalFormatting sqref="H20:H115"/>` element. The OOXML schema
 * requires at least one `<cfRule>` child, so Excel would offer to repair
 * the workbook. We copy the original block verbatim instead.
 */
function restoreTemplateConditionalFormatting(outBytes, templateBytes) {
  let outFiles;
  let tplFiles;
  try {
    outFiles = unzipSync(outBytes);
    tplFiles = unzipSync(templateBytes);
  } catch (err) {
    // If either archive cannot be read, return the workbook untouched —
    // a missing conditional-formatting rule is far better than a corrupt
    // file.
    return outBytes;
  }

  const outPart = sheetPart(outFiles, ORDER_FORM_SHEET_NAME);
  const tplPart = sheetPart(tplFiles, ORDER_FORM_SHEET_NAME);
  if (!outPart || !tplPart) return outBytes;

  const decoder = new TextDecoder("utf-8");
  const encoder = new TextEncoder();
  const outXml = decoder.decode(outFiles[outPart]);
  const tplXml = decoder.decode(tplFiles[tplPart]);
  if (!outXml || !tplXml) return outBytes;

  const patched = restoreConditionalFormatting(outXml, tplXml);
  if (patched === outXml) return outBytes;

  outFiles[outPart] = encoder.encode(patched);
  return zipSync(outFiles, { level: 6 });
}

/** The worksheet part for a sheet name (falls back to the first sheet). */
function sheetPart(files, sheetName) {
  try {
    return resolveSheetPart(files, sheetName);
  } catch {
    try {
      return resolveSheetPart(files, "");
    } catch {
      return null;
    }
  }
}

/** The workbook's active worksheet (openpyxl's `wb.active`). */
function activeWorksheet(wb) {
  const sheets = wb.worksheets || [];
  if (!sheets.length) return null;
  const activeTab = wb.views?.[0]?.activeTab;
  if (activeTab != null && sheets[activeTab]) return sheets[activeTab];
  return sheets[0];
}

/** Normalize whatever the IPC handed us into an ArrayBuffer ExcelJS accepts. */
function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  if (Array.isArray(data)) return Uint8Array.from(data).buffer;
  throw new Error("Unsupported binary payload type");
}

/** Normalize whatever the IPC handed us into a Uint8Array. */
function toUint8Array(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (Array.isArray(data)) return Uint8Array.from(data);
  throw new Error("Unsupported binary payload type");
}
