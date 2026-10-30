const {spawn}=require('node:child_process');
const wanted=new Set(['B8. Gene Synthesis','B6. DNA Sequencing','Public']);
function parseDriveInventory(text){
 const data=JSON.parse(text.replace(/^\uFEFF/,'').trim()||'[]'),rows=Array.isArray(data)?data:[data],found={},duplicates=new Set();
 for(const row of rows){
  if(!row||!wanted.has(row.VolumeName)||!/^[A-Z]:$/i.test(row.DeviceID??''))continue;
  if(found[row.VolumeName])duplicates.add(row.VolumeName);
  found[row.VolumeName]=row.DeviceID.toUpperCase();
 }
 for(const label of duplicates)delete found[label];
 return found;
}
async function scanDrives(){
 if(process.platform!=='win32')return {};
 // JSON is independent of the language of Windows (unlike parsing `vol`).
 const command="[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,VolumeName) | ConvertTo-Json -Compress";
 return new Promise(resolve=>{
  let output='',finished=false;
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,stdio:['ignore','pipe','ignore']});
  const finish=value=>{if(finished)return;finished=true;clearTimeout(timer);resolve(value);};
  const timer=setTimeout(()=>{child.kill();finish({});},10000);
  child.stdout.on('data',bytes=>output+=bytes.toString('utf8'));
  child.on('error',()=>finish({}));child.on('close',code=>{try{finish(code===0?parseDriveInventory(output):{});}catch{finish({});}});
 });
}
module.exports={scanDrives,parseDriveInventory};
