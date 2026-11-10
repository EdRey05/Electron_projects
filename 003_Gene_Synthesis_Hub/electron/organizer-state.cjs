const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
function validateSession(record){
  if(!record || !path.isAbsolute(record.dest_dir||'') ||
    !['organized_work_nos','created_folder_names'].every(key=>Array.isArray(record[key])&&record[key].length&&record[key].every(v=>typeof v==='string'&&v.trim()&&!/[\\/]/.test(v))))
    throw new Error('Saved session contains no valid batch.');
  return record;
}
async function saveSession(file,record){
  validateSession(record);
  await fs.mkdir(path.dirname(file),{recursive:true});
  const temp=file+'.'+randomUUID()+'.tmp';
  // The Tk record stamps '%Y-%m-%d %H:%M:%S' — keep that shape.
  const now=new Date(),p=n=>String(n).padStart(2,'0');
  const stamp=`${now.getFullYear()}-${p(now.getMonth()+1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
  try{await fs.writeFile(temp,JSON.stringify({...record,date:stamp},null,2),{flag:'wx'});await fs.rename(temp,file);}
  finally{await fs.unlink(temp).catch(()=>{});}
}
async function loadSession(file){return validateSession(JSON.parse(await fs.readFile(file,'utf8')));}
async function saveWorkbook(file,bytes,choose){
  await fs.mkdir(path.dirname(file),{recursive:true});
  try{await fs.writeFile(file,bytes,{flag:'wx'});return {ok:true,filePath:file};}
  catch(error){if(error.code!=='EEXIST')throw error;}
  const action=await choose(path.basename(file));
  if(action==='version'){
    const ext=path.extname(file),base=file.slice(0,-ext.length);
    for(let n=2;;n++){
      const candidate=base+' v'+n+ext;
      try{await fs.writeFile(candidate,bytes,{flag:'wx'});return {ok:true,filePath:candidate};}
      catch(error){if(error.code!=='EEXIST')throw error;}
    }
  }
  if(action!=='overwrite')return {ok:true,canceled:true};
  const temp=file+'.'+randomUUID()+'.tmp';
  try{await fs.writeFile(temp,bytes,{flag:'wx'});await fs.rename(temp,file);}
  finally{await fs.unlink(temp).catch(()=>{});}
  return {ok:true,filePath:file};
}
module.exports={saveSession,loadSession,saveWorkbook};
