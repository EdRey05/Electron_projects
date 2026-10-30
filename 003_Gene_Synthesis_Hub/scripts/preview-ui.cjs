// Real catalog + main/preload smoke preview; no fabricated app registry.
const {app}=require('electron'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
process.env.NODE_ENV='production';
const output=process.env.GSH_SCREENSHOT_DIR||path.join(os.tmpdir(),'gsh-ui-preview');fs.mkdirSync(output,{recursive:true});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
app.on('browser-window-created',(_event,win)=>win.webContents.once('did-finish-load',async()=>{
 try{
  for(let i=0;i<100;i++){if(await win.webContents.executeJavaScript('document.querySelectorAll(".gsh-tool-card").length===11'))break;await wait(200);}
  const names=await win.webContents.executeJavaScript(`[...document.querySelectorAll('.gsh-tool-card h3')].map(e=>e.innerText)`);assert.equal(names.length,11);
  fs.writeFileSync(path.join(output,'launcher.png'),(await win.webContents.capturePage()).toPNG());
  for(let i=0;i<names.length;i++){
   await win.webContents.executeJavaScript(`document.querySelectorAll('.gsh-tool-card button')[${i}].click()`);await wait(300);
   assert(await win.webContents.executeJavaScript(`document.body.innerText.includes(${JSON.stringify(names[i])})`));
   fs.writeFileSync(path.join(output,String(i+1).padStart(2,'0')+'-tool.png'),(await win.webContents.capturePage()).toPNG());
   await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim().endsWith('Hub')).click()`);await wait(100);
  }
  fs.writeFileSync(path.join(output,'preview-result.json'),JSON.stringify({status:'passed',nativeRoutes:names},null,2));console.log(output);app.exit(0);
 }catch(error){console.error(error);app.exit(1);}
}));
require('../electron/main.js');
