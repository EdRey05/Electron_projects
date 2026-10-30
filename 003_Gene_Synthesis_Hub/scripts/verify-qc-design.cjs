const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process'),XLSX=require('xlsx');
const root=path.resolve(__dirname,'..'),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'gsh-maps-'));
try {
 const wb=XLSX.utils.book_new(),header=['Work No.','Insert Sequence','Final Vector Sequence'];
 XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([header,['MAP-001','CGT','AACGTGGA'],['MAP-WRAP','GGAAA','AACGTGGA'],['MAP-NONE','','ACGTRYSWKMBDHVN'],['MAP-BAD','TTTT','AACGTGGA'],['MAP-LONG','AACGTGGAA','AACGTGGA']]),'input addon');
 XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([header,['OLD-001','CGT','AACGTGGA']]),'Obsolete input addon(completed)');
 const file=path.join(temporary,'log.xlsx');XLSX.writeFile(wb,file);
 const input={primerLog:file,outputFolder:temporary,workNos:['MAP-001','MAP-WRAP','MAP-NONE','MAP-BAD','MAP-LONG','OLD-001','MISSING']};
 const python=path.join(root,'python-app/runtime/python.exe'),worker=path.join(root,'python-app/worker.py');
 const invoke=(value,action='qc-design-bio')=>{const p=spawnSync(python,['-I','-X','utf8',worker],{input:JSON.stringify({action,input:value}),encoding:'utf8',timeout:60000});return {...p,messages:p.stdout.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)};};
 let r=invoke(input);assert.equal(r.status,0,r.stderr);let data=r.messages.find(m=>m.type==='result').data;assert.equal(data.files.length,4);assert.equal(data.failures.length,3);
 const check=spawnSync(python,['-I','-X','utf8','-c',`from Bio import SeqIO;from pathlib import Path;r=Path(${JSON.stringify(temporary)});a=SeqIO.read(r/'MAP-001.gb','genbank');w=SeqIO.read(r/'MAP-WRAP.gb','genbank');n=SeqIO.read(r/'MAP-NONE.gb','genbank');assert a.id=='MAP-001';assert str(a.seq)=='AACGTGGA';assert str(a.features[0].extract(a.seq))=='CGT';assert str(w.features[0].extract(w.seq))=='GGAAA';assert len(w.features[0].location.parts)==2;assert n.annotations['topology']=='circular';assert len(n.features)==0`],{encoding:'utf8'});assert.equal(check.status,0,check.stderr);
 const before=fs.readFileSync(path.join(temporary,'MAP-001.gb'));r=invoke({...input,workNos:['MAP-001']});assert.notEqual(r.status,0);assert.deepEqual(fs.readFileSync(path.join(temporary,'MAP-001.gb')),before);
 r=invoke({...input,replace:true,workNos:['MAP-001']});assert.equal(r.status,0,r.stderr);
 for(const id of ['../escape','CON','map.','a/b']){r=invoke({...input,workNos:[id]});assert.notEqual(r.status,0,id);}
 console.log('QC maps: upstream BioPython output re-parsed; forward/circular insert, IUPAC, obsolete sheet, missing/invalid records, filename and overwrite guards passed.');
} finally {fs.rmSync(temporary,{recursive:true,force:true});}
