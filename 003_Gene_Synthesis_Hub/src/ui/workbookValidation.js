import * as XLSX from 'xlsx';

export function validateWorkbookSheets(bytes, required = []) {
  const head = new Uint8Array(bytes);
  if (head[0] !== 0x50 || head[1] !== 0x4b) throw new Error('Not a valid XLSX/XLSM workbook.');
  const workbook = XLSX.read(bytes, {type:'array',bookSheets:true});
  const missing = required.filter(name => !workbook.SheetNames.includes(name));
  if (missing.length) throw new Error(`Missing sheet${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`);
  return workbook.SheetNames;
}

// The Colony PCR template shape check, mirroring the Tk app's fail-closed
// gate: the ACTIVE sheet must carry the plate grid (row-2 numbers 1..12 at
// B..M, column-A letters A..H at A3..A10); anything else rejects the file.
export function validateColonyGridShape(bytes) {
  const workbook = XLSX.read(bytes, {type:'array'});
  const views = (workbook.Workbook && workbook.Workbook.Views) || [];
  const activeIdx = views[0] && views[0].activeTab ? Number(views[0].activeTab) : 0;
  const name = workbook.SheetNames[activeIdx] || workbook.SheetNames[0];
  const sheet = workbook.Sheets[name];
  if (!sheet) throw new Error('Not a valid Excel file.');
  const aoa = XLSX.utils.sheet_to_json(sheet, {header:1, defval:null});
  const cell = (rowIdx, colIdx) => { const row = aoa[rowIdx-1] || []; return row[colIdx-1]; };
  const letter = (idx) => String.fromCharCode(64 + idx);
  // Python compares float(got) against the want value with a 1e-9 window
  // and falls back to an uppercase string compare; keep that shape.
  for (let col = 2; col <= 13; col++) {
    const got = Number(cell(2, col));
    const ok = Number.isFinite(got) && Math.abs(got - (col - 1)) < 1e-9;
    if (!ok) throw new Error('Not a Colony PCR Layout template (plate grid missing at ' + letter(col) + '2).');
  }
  for (let row = 3, k = 0; row <= 10; row++, k++) {
    const want = String.fromCharCode(65 + k);
    const ok = String(cell(row, 1) == null ? '' : cell(row, 1)).trim().toUpperCase() === want;
    if (!ok) throw new Error('Not a Colony PCR Layout template (plate grid missing at A' + row + ').');
  }
}
