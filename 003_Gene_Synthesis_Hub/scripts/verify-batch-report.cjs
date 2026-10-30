const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const XLSX=require('xlsx');
const root=path.resolve(__dirname,'..'),python=path.join(root,'python-app/runtime/python.exe');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'gsh-batch-test-'));
try {
 const input=path.join(temporary,'input'),output=path.join(temporary,'output');
 const setup=spawnSync(python,['-I','-X','utf8',path.join(__dirname,'make-batch-fixture.py'),input],{encoding:'utf8',timeout:30000});assert.equal(setup.status,0,setup.stderr);
 const run=spawnSync(python,['-I','-B','-X','utf8',path.join(root,'python-app/worker.py')],{input:JSON.stringify({action:'batch-report',input:{inputFolder:input,outputFolder:output}}),encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024});
 assert.equal(run.status,0,run.stderr||run.error?.message);
 const data=run.stdout.trim().split(/\r?\n/).map(JSON.parse).find(m=>m.type==='result').data;
 assert.equal(data.records.length,2);assert.equal(data.records[0].bbi_id,'BATCH 1234-01');assert.equal(data.records[0].plasmid_no,'26TEST001');
 assert.equal(data.records[0].insert_seq,'ACGTRYSWKMBDHVN');assert.equal(data.records[0].final_vector_seq,'TTACGTRYSWKMBDHVNCC');
 for(const [key,value] of Object.entries({od260:0.6,od280:0.3,od_ratio:2,ng_ul:30}))assert.equal(data.records[0][key],value,'Real OCR: '+key);
 assert(data.warnings.some(w=>w.includes('1234-02')&&w.includes('OD values')),'Missing OD must be reported');
 const wb=XLSX.readFile(data.outputPath),sheet=wb.Sheets['QC Report'];
 assert.equal(sheet.B2.v,'BATCH 1234-01');assert.equal(sheet.C2.v,'26TEST001');assert.equal(sheet.D2.v,30);assert.equal(sheet.H2.v,'ACGTRYSWKMBDHVN');
 const archive=require('fflate').unzipSync(fs.readFileSync(data.outputPath));assert(Object.keys(archive).some(key=>key.startsWith('xl/media/')),'OD image missing from workbook');
 console.log('BATCH QC: real bundled OCR, smallest-image selection, DOCX plasmid ID, both sequence types, missing-OD review and workbook/image output passed.');
} finally {
 if(path.dirname(temporary)!==os.tmpdir()||!path.basename(temporary).startsWith('gsh-batch-test-'))throw new Error('Unexpected BATCH fixture cleanup path');
 fs.rmSync(temporary,{recursive:true,force:true});
}
