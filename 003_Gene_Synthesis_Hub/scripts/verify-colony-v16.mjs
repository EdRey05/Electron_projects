import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {planPlates} from '../src/subapps/ColonyPCRLayout/platePlanner.js';
import {buildWorkbookBytes} from '../src/subapps/ColonyPCRLayout/workbookBuilder.js';
const rows=[{ 'Work No.':'JOB1',SourceFile:'one.xlsx',Vector:'pUC57',Primers:'F/R','Length (bp)':NaN },{ 'Work No.':'JOB2',SourceFile:'two.xlsx',Vector:'pUC57',Primers:'F/R','Length (bp)':1000 }];
const counts=new Map([['JOB1\0one.xlsx',88],['JOB2\0two.xlsx',20]]);
const plan=planPlates(rows,counts);
assert.deepEqual(plan.plates.map(plate=>plate.jobs.length),[96,12]);
const bytes=await buildWorkbookBytes(plan,rows,counts,null,new Date('2026-11-05T12:00:00Z'));
const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(bytes);
for(const [index,expected] of [970,130].entries()){
 const sheet=workbook.worksheets[index];let mixRow;
 sheet.eachRow((row,n)=>{if(row.getCell(2).value==='Mix Calculation')mixRow=n;});
 assert(mixRow);assert.equal(sheet.getCell(mixRow+1,3).value,expected,'Mix must count only clones physically placed on this plate');
 sheet.eachRow(row=>row.eachCell(cell=>assert(!(typeof cell.value==='number'&&!Number.isFinite(cell.value)))));
}
console.log('Colony 1.6: split-job plate placement, per-plate master mix and finite workbook cells passed.');
