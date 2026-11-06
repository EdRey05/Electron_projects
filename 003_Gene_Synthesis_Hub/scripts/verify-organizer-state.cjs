const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {saveSession,loadSession,saveWorkbook}=require('../electron/organizer-state.cjs');
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gsh-session-'));
 try{
  const session=path.join(root,'last_session_log.json'),file=path.join(root,'Gene Seq Log.xlsx');
  const record={dest_dir:root,organized_work_nos:['W1'],created_folder_names:['W1.P1']};
  await saveSession(session,record);assert.deepEqual((await loadSession(session)).organized_work_nos,['W1']);
  await assert.rejects(saveSession(session,{...record,organized_work_nos:[]}));
  assert.deepEqual((await loadSession(session)).created_folder_names,['W1.P1']);
  const first=await saveWorkbook(file,Buffer.from('original'),()=>assert.fail('unexpected dialog'));assert(first.ok);
  assert((await saveWorkbook(file,Buffer.from('cancel'),async()=> 'cancel')).canceled);
  assert.equal(await fs.readFile(file,'utf8'),'original');
  for(const n of [2,3])assert.equal((await saveWorkbook(file,Buffer.from('v'+n),async()=> 'version')).filePath,path.join(root,'Gene Seq Log v'+n+'.xlsx'));
  await saveWorkbook(file,Buffer.from('replacement'),async()=> 'overwrite');assert.equal(await fs.readFile(file,'utf8'),'replacement');
  assert.equal(await fs.readFile(path.join(root,'Gene Seq Log v2.xlsx'),'utf8'),'v2');
  console.log('Organizer session: persisted, invalid/empty batch preserved; SG saves: cancel, numbered versions, atomic overwrite passed.');
 }finally{await fs.rm(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
