const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {verifiedCopy,verifiedMove}=require('../electron/file-operations.cjs');
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gsh-io-'));
 try {
  const source=path.join(root,'raw','sample.ab1'),dest=path.join(root,'sorted','sample.ab1');
  await fs.mkdir(path.dirname(source));await fs.writeFile(source,Buffer.from([0,1,255,88,13,10]));
  await verifiedMove(source,dest);
  assert.deepEqual(await fs.readFile(dest),Buffer.from([0,1,255,88,13,10]));
  await assert.rejects(fs.stat(source));
  await fs.writeFile(source,'different');
  await assert.rejects(verifiedMove(source,dest),/both originals were preserved/);
  assert.equal(await fs.readFile(source,'utf8'),'different');
  await fs.writeFile(source,await fs.readFile(dest));
  assert.equal((await verifiedCopy(source,dest)).unchanged,true);
  assert((await fs.stat(source)).isFile());
  await assert.rejects(verifiedMove(source,source),/must differ/);
  console.log('Native file operations: exact bytes, verified move, existing-file collision preservation, identical-copy no-op and self-move rejection passed.');
 } finally {
  if(path.dirname(root)!==os.tmpdir()||!path.basename(root).startsWith('gsh-io-'))throw new Error('Unexpected test cleanup path');
  await fs.rm(root,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
