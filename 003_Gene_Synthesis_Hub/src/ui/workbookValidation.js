import * as XLSX from 'xlsx';

export function validateWorkbookSheets(bytes, required = []) {
  const head = new Uint8Array(bytes);
  if (head[0] !== 0x50 || head[1] !== 0x4b) throw new Error('Not a valid XLSX/XLSM workbook.');
  const workbook = XLSX.read(bytes, {type:'array',bookSheets:true});
  const missing = required.filter(name => !workbook.SheetNames.includes(name));
  if (missing.length) throw new Error(`Missing sheet${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`);
  return workbook.SheetNames;
}
