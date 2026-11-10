const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const XLSX=require('xlsx');
const root=path.resolve(__dirname,'..'),python=path.join(root,'python-app/runtime/python.exe');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'gsh-batch-test-'));
try {
 const input=path.join(temporary,'input'),output=path.join(temporary,'output');
 const setup=spawnSync(python,['-I','-X','utf8',path.join(__dirname,'make-batch-fixture.py'),input],{encoding:'utf8',timeout:30000});assert.equal(setup.status,0,setup.stderr);
 const request=payload=>spawnSync(python,['-I','-B','-X','utf8',path.join(root,'python-app/worker.py')],{input:JSON.stringify(payload),encoding:'utf8',timeout:180000,maxBuffer:32*1024*1024});
 // Step 1: processing. Record 1 reads AUTO, record 2 has no OD table, record
 // 3 reads in-gate but out-of-rule: the run parks in the review queue
 // instead of writing a report.
 const first=request({action:'batch-report',input:{inputFolder:input,outputFolder:output}});
 assert.equal(first.status,0,first.stderr||first.error?.message);
 const data=first.stdout.trim().split(/\r?\n/).map(JSON.parse).find(m=>m.type==='result').data;
 assert.equal(data.step,'review');assert.ok(data.token,'review token present');
 assert.equal(data.records.length,3);
 assert.equal(data.records[0].odStatus,'FLAGGED');assert.ok(data.records[0].odFlags[0].includes('outside its expected range'),'flag reason ships to the dialog');
 assert.equal(data.records[0].bbiId,'BATCH 1234-01');assert.equal(data.records[0].plasmidNo,'26TEST001');
 assert.equal(data.records[0].insertSeq,'ACGTRYSWKMBDHVN');assert.equal(data.records[0].finalVectorSeq,'TTACGTRYSWKMBDHVNCC');
 for(const [key,value] of Object.entries({od260:0.6,od280:0.3,odRatio:2,ngUl:30}))assert.equal(data.records[0][key],value,'Real OCR round-trip: '+key);
 assert.ok(data.records[0].blob,'AUTO record keeps its od image for the workbook');
 assert.equal(data.review.noInput.length,1);assert.equal(data.review.noInput[0].index,1);assert.equal(data.review.noInput[0].bbiId,'BATCH 1234-02');
 assert.deepEqual(data.review.readable.map(r=>r.bbiId),['BATCH 1234-01','BATCH 1234-03']);
 assert.ok(data.review.readable[0].image,'review row carries the OCR image');
 assert.equal(data.review.readable[1].values.od260,0.2);assert.equal(data.review.readable[1].values.od_ratio,2.4);
 assert.deepEqual(data.review.readable[0].values,{od260:0.6,od280:0.3,od_ratio:2,ng_ul:30},'flagged row prefilled with its read values');
 assert(data.warnings.some(w=>w.includes('1234-02')&&w.includes('OD values')),'Missing OD must be reported');
 // Non-numeric entries are rejected naming the record, like the dialog.
 const bad=request({action:'batch-report',input:{step:'apply',token:data.token,records:data.records,warnings:data.warnings,skipped:false,outputFolder:output,entered:{0:{od260:'0.6',od280:'abc',od_ratio:'2',ng_ul:'30'}}}});
 assert.notEqual(bad.status,0);
 assert(bad.stdout.includes('"type": "error"')&&bad.stdout.includes('abc')&&bad.stdout.includes('is not a number'),'Rejected entry names the record');
 // Step 2: enter corrected values for the flagged row; the AUTO row keeps
 // its values, the no-image row is marked PENDING in its flagged fields.
 const second=request({action:'batch-report',input:{step:'apply',token:data.token,records:data.records,warnings:data.warnings,skipped:false,outputFolder:output,entered:{0:{od260:'0.6',od280:'0.3',od_ratio:'2',ng_ul:'30'},2:{od260:'0.6',od280:'0.5',od_ratio:'1.2',ng_ul:'35'}}}});
 assert.equal(second.status,0,second.stderr||second.error?.message);
 const done=second.stdout.trim().split(/\r?\n/).map(JSON.parse).find(m=>m.type==='result').data;
 assert.ok(done.outputPath);assert.equal(done.records.length,3);
 assert.equal(done.records[0].od_status,'MANUAL');
 assert.equal(done.records[1].od_status,'PENDING');
 assert.equal(done.records[2].od_status,'MANUAL');
 assert.equal(done.records[2].od260,0.6);assert.equal(done.records[2].od280,0.5);assert.equal(done.records[2].od_ratio,1.2);assert.equal(done.records[2].ng_ul,35);
 const wb=XLSX.readFile(done.outputPath),sheet=wb.Sheets['QC Report'];
 assert.equal(sheet.B2.v,'BATCH 1234-01');assert.equal(sheet.C2.v,'26TEST001');assert.equal(sheet.D2.v,30);assert.equal(sheet.H2.v,'ACGTRYSWKMBDHVN');
 assert.equal(sheet.D3.v,'PENDING');assert.equal(sheet.E3.v,'PENDING');
 assert.equal(sheet.B4.v,'BATCH 1234-03');assert.equal(sheet.D4.v,35);assert.equal(sheet.E4.v,0.6);assert.equal(sheet.F4.v,0.5);assert.equal(sheet.G4.v,1.2);
 const archive=require('fflate').unzipSync(fs.readFileSync(done.outputPath));assert(Object.keys(archive).some(key=>key.startsWith('xl/media/')),'OD image missing from workbook');
 console.log('BATCH QC: real bundled OCR, smallest-image selection, DOCX plasmid ID, both sequence types, in-gate/out-of-rule review rows (MANUAL/PENDING), non-numeric rejection and workbook/image output passed.');
} finally {
 if(path.dirname(temporary)!==os.tmpdir()||!path.basename(temporary).startsWith('gsh-batch-test-'))throw new Error('Unexpected BATCH fixture cleanup path');
 fs.rmSync(temporary,{recursive:true,force:true});
}
