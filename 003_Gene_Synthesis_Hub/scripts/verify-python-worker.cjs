const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const XLSX=require('xlsx');
const root=path.resolve(__dirname,'..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'gsh-worker-'));
try {
 const file=path.join(temporary,'synthetic-shipping.xlsx'),wb=XLSX.utils.book_new();
 XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([
  ['12345678','BBI-TEST-01','GeneOne','WORK-001',1200,'pUC57','EcoRI','P1234567','5ug','202610A001'],
  ['12345678','BBI-TEST-01','','',1200,'pUC57','EcoRI','P1234568','5ug','202610A002'],
  ['12345679','BBI-TEST-02','GeneTwo','WORK-002',900,'pET24a','NdeI','U1234569','3ug','202610B001'],
 ]),'Shipping');XLSX.writeFile(wb,file);
 const invoke=files=>spawnSync(path.join(root,'python-app/runtime/python.exe'),['-I','-X','utf8',path.join(root,'python-app/worker.py')],{input:JSON.stringify({action:'labels',input:{files}}),encoding:'utf8',timeout:60000});
 const result=invoke([file,file]);assert.equal(result.status,0,result.stderr||result.error?.message);
 const messages=result.stdout.trim().split(/\r?\n/).map(JSON.parse);
 const data=messages.find(m=>m.type==='result').data;
 assert.equal(data.records.length,2);assert.equal(data.columns.length,10);
 assert.equal(data.records[0]['Gene Name'],'GeneOne');assert.equal(data.records[0]['Plasmid No.'],'202610A001');assert.equal(data.records[0]['Storage Condition (C)'],'-20');
 assert(messages.some(m=>m.type==='log'));
 const invalid=path.join(temporary,'invalid.xlsx');
 const bad=XLSX.utils.book_new();XLSX.utils.book_append_sheet(bad,XLSX.utils.aoa_to_sheet([['wrong','layout']]),'Bad');XLSX.writeFile(bad,invalid);
 // Upstream's auto-parse tolerates per-file failures: an unreadable list is
 // logged ([ERROR]/[WARNING], collected in the no-usable-data line) and the
 // run completes with zero records instead of failing.
 const rejected=invoke([invalid]);assert.equal(rejected.status,0,rejected.stderr||rejected.error?.message);
 const rejectedMessages=rejected.stdout.trim().split(/\r?\n/).map(JSON.parse);
 const rejectedData=rejectedMessages.find(m=>m.type==='result').data;
 assert.equal(rejectedData.records.length,0);
 assert(rejectedMessages.some(m=>m.type==='log'&&m.message.startsWith('[ERROR]')));
 assert(rejectedMessages.some(m=>m.type==='log'&&m.message.startsWith('[WARNING] \t Files with no usable data')));
 // A mixed batch keeps the readable file's records and flags the broken one.
 const mixed=invoke([invalid,file]);assert.equal(mixed.status,0,mixed.stderr||mixed.error?.message);
 const mixedData=mixed.stdout.trim().split(/\r?\n/).map(JSON.parse).find(m=>m.type==='result').data;
 assert.equal(mixedData.records.length,2);
 console.log('Bundled headless worker: exact label parsing, best replicate, cross-file deduplication, per-file tolerance and progress protocol passed.');
} finally {
 if(path.dirname(temporary)!==os.tmpdir()||!path.basename(temporary).startsWith('gsh-worker-'))throw new Error('Unexpected worker fixture cleanup path');
 fs.rmSync(temporary,{recursive:true,force:true});
}
