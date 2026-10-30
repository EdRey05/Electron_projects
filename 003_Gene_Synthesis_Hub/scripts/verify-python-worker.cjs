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
 const invalid=path.join(temporary,'invalid.xlsx');XLSX.writeFile(wb,invalid);
 const bad=XLSX.utils.book_new();XLSX.utils.book_append_sheet(bad,XLSX.utils.aoa_to_sheet([['wrong','layout']]),'Bad');XLSX.writeFile(bad,invalid);
 const rejected=invoke([invalid]);assert.notEqual(rejected.status,0);assert(rejected.stdout.includes('"type": "error"'));
 console.log('Bundled headless worker: exact label parsing, best replicate, cross-file deduplication, progress protocol and malformed shipping-list rejection passed.');
} finally {
 if(path.dirname(temporary)!==os.tmpdir()||!path.basename(temporary).startsWith('gsh-worker-'))throw new Error('Unexpected worker fixture cleanup path');
 fs.rmSync(temporary,{recursive:true,force:true});
}
