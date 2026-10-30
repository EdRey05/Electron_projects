const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');
async function digest(file) {
  const hash=createHash('sha256');
  for await(const chunk of fs.createReadStream(file))hash.update(chunk);
  return hash.digest('hex');
}
async function verifiedCopy(source,dest) {
  if(path.resolve(source).toLowerCase()===path.resolve(dest).toLowerCase())throw new Error('Source and destination must differ.');
  const before=await fsp.stat(source);
  if(!before.isFile())throw new Error('Source must be a regular file.');
  await fsp.mkdir(path.dirname(dest),{recursive:true});
  try {await fsp.copyFile(source,dest,fs.constants.COPYFILE_EXCL);}
  catch(error) {
    if(error.code!=='EEXIST')throw error;
    if(await digest(source)===await digest(dest)) {
      const after=await fsp.stat(source);
      if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new Error('Source changed while verifying an existing copy; both files were retained.');
      return {unchanged:true};
    }
    throw new Error('Destination contains a different file; both originals were preserved.');
  }
  const [a,b]=await Promise.all([digest(source),digest(dest)]);
  const after=await fsp.stat(source);
  if(a!==b || before.size!==after.size || before.mtimeMs!==after.mtimeMs)throw new Error('File changed or verification failed. Source and copied destination were retained for review.');
  return {unchanged:false};
}
async function verifiedMove(source,dest) {
  const result=await verifiedCopy(source,dest);
  // An existing identical destination is preserved too; no replacement needed.
  await fsp.unlink(source);
  return result;
}
module.exports={verifiedCopy,verifiedMove};
