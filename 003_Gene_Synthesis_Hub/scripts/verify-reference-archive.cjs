const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {writeReference}=require('../electron/reference-files.cjs');
(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'gsh-reference-'));
 try{
  for(const year of [2026,2025])await fs.mkdir(path.join(dir,String(year)));
  await fs.writeFile(path.join(dir,'2026','DONE.txt'),'archived');
  await fs.writeFile(path.join(dir,'2025','LAST.txt'),'previous year');
  await fs.writeFile(path.join(dir,'DONE.txt'),'keep active copy too');
  assert.equal((await writeReference({directory:dir,name:'DONE.txt',text:'must not write'},2026)).outcome,'completed');
  assert.equal(await fs.readFile(path.join(dir,'DONE.txt'),'utf8'),'keep active copy too');
  assert.equal((await writeReference({directory:dir,name:'LAST.txt',text:'must not write'},2026)).year,2025);
  assert.equal((await writeReference({directory:dir,name:'NEW.txt',text:'ACGT'},2026)).outcome,'created');
  assert.equal((await writeReference({directory:dir,name:'NEW.txt',text:'TGCA'},2026)).outcome,'overwritten');
  assert.equal(await fs.readFile(path.join(dir,'NEW.txt'),'utf8'),'TGCA');
  await assert.rejects(writeReference({directory:dir,name:'../escape.txt',text:'x'},2026),/Invalid reference/);
  console.log('Reference 1.4: current/prior-year archive protection, active create/overwrite and path safety passed.');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
