const fs=require('node:fs/promises'),path=require('node:path');
async function exists(file){try{await fs.stat(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function writeReference({directory,name,text},year=new Date().getFullYear()){
 if(!directory||!path.isAbsolute(directory))throw new Error('Choose an absolute reference folder.');
 if(!name||path.basename(name)!==name||/[<>:"/\\|?*\x00-\x1f]/.test(name)||/[. ]$/.test(name)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))throw new Error('Invalid reference filename.');
 if(!(await fs.stat(directory)).isDirectory())throw new Error('Reference folder is not a directory.');
 // Exact probes only: never enumerate the potentially huge reference/archive folder.
 for(const archiveYear of [year,year-1])if(await exists(path.join(directory,String(archiveYear),name)))return {ok:true,outcome:'completed',year:archiveYear};
 const target=path.join(directory,name),existed=await exists(target);
 // The Tk app writes in text mode on Windows: line breaks come out CRLF.
 await fs.writeFile(target,text.replace(/\r?\n/g,'\r\n'),'utf8');
 return {ok:true,outcome:existed?'overwritten':'created'};
}
module.exports={writeReference};
