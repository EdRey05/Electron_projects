const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'gsh-sync-')),source=path.join(temp,'reference'),destination=path.join(temp,'staged');
try{
 fs.mkdirSync(source);fs.mkdirSync(destination);const catalog=fs.readFileSync(path.join(__dirname,'../python-app/app_information.txt'),'utf8');
 fs.writeFileSync(path.join(source,'app_information.txt'),catalog);
 for(const folder of [...catalog.matchAll(/^path\s*=\s*(.*)$/gm)].map(m=>m[1].trim())){
  fs.mkdirSync(path.join(source,folder),{recursive:true});fs.writeFileSync(path.join(source,folder,'fixture.py'),'original\n');
 }
 for(const folder of ['Code','Templates','Databases']){
  fs.mkdirSync(path.join(source,folder),{recursive:true});fs.cpSync(path.join(source,folder),path.join(destination,folder),{recursive:true});
 }
 fs.mkdirSync(path.join(destination,'processors'));fs.writeFileSync(path.join(destination,'processors/adapter.py'),'keep');
 const invoke=(...args)=>spawnSync(process.execPath,[path.join(__dirname,'stage-subapps.js'),'--source',source,'--destination',destination,...args],{encoding:'utf8'});
 assert.equal(invoke('--snapshot').status,0);
 const file='Code/QC_file_prep/fixture.py';fs.writeFileSync(path.join(source,file),'updated\n');
 let result=invoke('--app','QC File Prep');assert.equal(result.status,0,result.stderr);assert(result.stdout.includes('update'));assert.equal(fs.readFileSync(path.join(destination,file),'utf8'),'original\n');
 result=invoke('--app','QC File Prep','--apply');assert.equal(result.status,0,result.stderr);assert.equal(fs.readFileSync(path.join(destination,file),'utf8'),'updated\n');
 assert.equal(fs.readFileSync(path.join(destination,'processors/adapter.py'),'utf8'),'keep');assert.equal(fs.readFileSync(path.join(destination,'Code/Primer_finder/fixture.py'),'utf8'),'original\n');
 fs.writeFileSync(path.join(destination,file),'local edits\n');result=invoke('--app','QC File Prep','--apply');assert.notEqual(result.status,0);assert.equal(fs.readFileSync(path.join(destination,file),'utf8'),'local edits\n');
 fs.writeFileSync(path.join(source,'app_information.txt'),'[Other Hub]\npath = ../outside\n');assert.notEqual(invoke('--all','--apply').status,0);
 console.log('Upstream refresh: dry-run, selected-tool copy, adapter preservation, local-change protection and wrong-hub rejection passed.');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
