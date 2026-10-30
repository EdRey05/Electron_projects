const fs=require('node:fs');
const path=require('node:path');
const readline=require('node:readline');
const {spawn}=require('node:child_process');

function registerPythonJobs({app,ipcMain,pythonAppRoot,pythonExe}) {
  const active=new Map();
  const stop=job=>{
    job.canceled=true;
    if(job.child?.pid) {
      if(process.platform==='win32')spawn('taskkill.exe',['/PID',String(job.child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}).on('error',()=>{});
      else job.child.kill();
    }
  };
  ipcMain.handle('hub:runPythonJob',async(event,{requestId,action,input})=>{
    if(!/^[a-zA-Z0-9-]{1,80}$/.test(requestId??''))return {ok:false,error:'Invalid job identifier.'};
    if(!['qc-file-prep','labels','batch-report','qc-design-bio','qc-design-snapgene'].includes(action))return {ok:false,error:'Unknown processing action.'};
    if([...active.values()].some(j=>j.sender===event.sender.id))return {ok:false,error:'A processing job is already running.'};
    let executable;
    try{executable=pythonExe();}catch(error){return {ok:false,error:'The bundled Python runtime is missing. Extract the complete ZIP and keep its resources folder. See the job log for details.'};}
    const root=pythonAppRoot(),worker=path.join(root,'worker.py');
    if(!fs.existsSync(worker))return {ok:false,error:'The packaged processing worker is missing.'};
    const logDir=app.getPath('logs');fs.mkdirSync(logDir,{recursive:true});
    const logPath=path.join(logDir,'job-'+requestId+'.log');
    return await new Promise(resolve=>{
      const job={sender:event.sender.id,canceled:false,child:null};active.set(requestId,job);
      const onDestroyed=()=>{if(active.get(requestId)===job)stop(job);};
      let completed=false,data=null,error=null;
      const log=message=>{fs.appendFileSync(logPath,String(message)+'\n');};
      const finish=code=>{
        if(completed)return;completed=true;active.delete(requestId);
        event.sender.removeListener('destroyed',onDestroyed);
        if(job.canceled)resolve({ok:false,canceled:true,error:'Processing canceled.',logPath});
        else if(code===0&&data!==null&&!error)resolve({ok:true,data,logPath});
        else resolve({ok:false,error:error||'Processing failed. See the job log.',logPath});
      };
      try {
        fs.mkdirSync(app.getPath('userData'),{recursive:true});
        const child=spawn(executable,['-I','-B','-X','utf8','-u',worker],{cwd:app.getPath('userData'),windowsHide:true,stdio:['pipe','pipe','pipe']});
        job.child=child;
        readline.createInterface({input:child.stdout}).on('line',line=>{
          try {
            const item=JSON.parse(line);
            if(item.type==='result')data=item.data;
            else if(item.type==='canceled')job.canceled=true;
            else if(item.type==='prompt') {
              job.prompt=item;
              if(!event.sender.isDestroyed())event.sender.send('hub:pythonProgress',{requestId,prompt:item});
            }
            else if(item.type==='error'){error=item.message;log(error);}
            else if(item.type==='log'){log(item.message);if(!event.sender.isDestroyed())event.sender.send('hub:pythonProgress',{requestId,message:item.message});}
          }catch{log(line);}
        });
        child.stderr.on('data',bytes=>log(bytes.toString('utf8')));
        child.on('error',err=>{error=err.message;finish(1);});
        child.on('close',finish);
        child.stdin.on('error',err=>{error=err.message;});
        child.stdin.write(JSON.stringify({action,input})+'\n');
        event.sender.once('destroyed',onDestroyed);
      }catch(err){error=err.message;finish(1);}
    });
  });
  ipcMain.handle('hub:answerPythonJob',(event,{requestId,promptId,choice,data})=>{
    const job=active.get(requestId);
    if(job?.sender!==event.sender.id||job.prompt?.promptId!==promptId||!job.prompt.choices.includes(choice))return false;
    job.prompt=null;
    job.child.stdin.write(JSON.stringify({replyTo:promptId,choice,data})+'\n');
    return true;
  });
  ipcMain.handle('hub:cancelPythonJob',(event,requestId)=>{
    const job=active.get(requestId);if(job?.sender===event.sender.id){stop(job);return true;}return false;
  });
  app.on('before-quit',()=>{for(const job of active.values())stop(job);});
}
module.exports={registerPythonJobs};
