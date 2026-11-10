import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {extractJobLogInfo,extractFragmentsWithReport,cappedVectorRows} from '../src/subapps/LigationLayout/extractor.js';
import {writeLayoutRows} from '../src/subapps/LigationLayout/workbookBuilder.js';
import {validateWorkbookSheets} from '../src/ui/workbookValidation.js';
const make = sheets => {
 const wb=XLSX.utils.book_new();
 for(const [name,rows] of Object.entries(sheets))XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(rows),name);
 return XLSX.write(wb,{type:'array',bookType:'xlsx'});
};
const bytes=make({Initiated:[['Vector','BBI ID','Work No.','Length (bp)','Filler1','Filler2','Cloning Site','Resistance','Filler3'],['','BB1','JOB1',1000,'','','','',''],['DNA Fragment - No Vector','BB2','JOB2',2000,'','','','',''],['pUC57','BB3','JOB3',3000,'','','','','']]});
const jobs=extractJobLogInfo(bytes,['JOB1','JOB2','JOB3']);
assert.deepEqual(jobs.jobs_needing_manual_entry,['JOB1','JOB2']);
assert.equal(jobs.rows.JOB3.bbid,'BB3');
// Upstream v3.3 fallback depth: without a fallback position (columns F-I)
// resolution raises and aborts the run instead of reading blanks.
assert.throws(()=>extractJobLogInfo(make({Initiated:[['Vector','BBI ID','Work No.']]}),['JOB1']),/no fallback position/);
assert.deepEqual(validateWorkbookSheets(bytes,['Initiated']),['Initiated']);
assert.throws(()=>validateWorkbookSheets(bytes,['Vector','Digested_Vectors']),/Missing sheets/);
assert.throws(()=>validateWorkbookSheets(new TextEncoder().encode('not an Excel file').buffer),/valid XLSX/);
const fragmentBytes=make({
 'PCR Fragments':[['Position','Gene Name','Purity Pass','Sequence','Concentration'],['A1',1234,'Pass','ACGT',20]],
 U11:[['Position','Gene Name','Purity Pass','Sequence'],['A2','JOB2','Pass','TTAA']],
 'U11 malformed':[['Wrong','Columns'],['A3','BAD']],
});
const report=extractFragmentsWithReport(fragmentBytes,['U11','U10']);
assert.equal(report.rows.length,2);
assert.equal(report.rows[0].geneName,'1234');
assert.equal(report.rows[0].concentration,20);
assert.equal(report.rows[0].insertLength,4);
assert(report.logs.some(line=>line.includes('Skipped')&&line.includes('U11 malformed')));
const workbook=XLSX.utils.book_new();XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([['']]),'Layout');
writeLayoutRows(workbook,[{job_id:'MANUAL',vector:'custom',enzyme:'X',length:NaN,resistance:'Kan',is_manual:true}],{});
assert.equal(workbook.Sheets.Layout.T2.v,'');
assert.equal(workbook.Sheets.Layout.U2.v,'Kan');
console.log('Ligation 3.3: named columns, blank vector prompts, malformed sheet skips, numeric gene IDs, named PCR concentration, finite output and manual resistance passed.');

const inflated=XLSX.utils.aoa_to_sheet([['Name','Size'],['pUC57',2700]]);inflated['!ref']='A1:XFD1048576';
assert.equal(cappedVectorRows(inflated,0,4).length,1001);
assert.equal(cappedVectorRows(inflated,0,4)[1][0],'pUC57');
console.log('Inflated vector dimensions stop after first empty 500-row anchor block.');
