// Run in the isolated development guest after `npm run build`.
// Uses the real main process, preload, INI catalog and compiled renderer.
const {app}=require('electron');
const fs=require('node:fs');
const assert=require('node:assert/strict');
process.env.NODE_ENV='production';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
let stage='launcher';
setInterval(()=>fs.writeFileSync('C:/Export/ui-stage.txt',stage),1000).unref();
app.on('browser-window-created',(_event,win)=>{
  win.webContents.once('did-finish-load',async()=>{
    try {
      for(let i=0;i<100;i++) {
        if(await win.webContents.executeJavaScript('document.querySelectorAll(".gsh-tool-card").length===11'))break;
        await wait(200);
      }
      const state=await win.webContents.executeJavaScript(`(()=>{
        const cards=[...document.querySelectorAll('.gsh-tool-card')];
        return {names:cards.map(c=>c.querySelector('h3').innerText),rects:cards.slice(0,2).map(c=>c.getBoundingClientRect().toJSON()),text:document.body.innerText,background:getComputedStyle(document.body).backgroundColor};
      })()`);
      assert.equal(state.names.length,11);
      assert.equal(state.names[0],'Ligation Layout');
      assert.equal(state.names[10],'Label Generator');
      assert(!state.names.includes('QC Vector Map Prep'));
      assert(!state.text.includes('Show wiring'));
      assert(!state.text.includes('Python app'));
      assert(Math.abs(state.rects[0].width-state.rects[1].width)<1);
      assert.equal(state.rects[0].y,state.rects[1].y);
      fs.writeFileSync('C:/Export/launcher.png',(await win.webContents.capturePage()).toPNG());
      fs.writeFileSync('C:/Export/launcher-ui.json',JSON.stringify({status:'passed',...state},null,2));
      const XLSX=require('xlsx');
      const workbook=XLSX.utils.book_new(),sheet=XLSX.utils.aoa_to_sheet([]);
      XLSX.utils.sheet_add_aoa(sheet,[['Oligo Name',"Sequence (5' to 3')"]],{origin:'A34'});
      XLSX.utils.sheet_add_aoa(sheet,[['Early','ACGTTGCAACCT']],{origin:'A35'});
      XLSX.utils.sheet_add_aoa(sheet,[['Late','ACGTTGCAACCT']],{origin:'A150'});
      XLSX.utils.book_append_sheet(workbook,sheet,'S-test');
      XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([
        ['Work No.','Vector','Insert Sequence','Final Vector Sequence','Colony PCR primers','Amplification primers','Seq primer 1','Seq primer 2'],
        ['GSH-TEST-01','pUC57','ACGT','GGACGTCC','PF/PR','','GSH-TEST-01_F','GSH-TEST-01_R'],
        ['GSH-TEST-02','pET24a','TTAA','CCTTAAGG','PF/PR','','GSH-TEST-02_F','GSH-TEST-02_R'],
      ]),'input addon');
      XLSX.writeFile(workbook,'C:/Export/synthetic-primer-log.xlsx');
      await win.webContents.executeJavaScript(`window.api.saveConfig({Primer_Log:'C:/Export/synthetic-primer-log.xlsx'},{})`);
      // Reload configuration before opening so initialPaths comes through real IPC.
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Rescan')?.click()`);
      await wait(400);
      for(let i=0;i<100;i++){if(await win.webContents.executeJavaScript(`!![...document.querySelectorAll('button')].find(b=>b.innerText==='Rescan'&&!b.disabled)`))break;await wait(200);}
      await win.webContents.executeJavaScript(`document.querySelector('[aria-label="Open Primer Finder"]')?.click()`);
      for(let i=0;i<60;i++) {
        if(await win.webContents.executeJavaScript('document.body.innerText.includes("Valid Excel file")'))break;
        await wait(200);
      }
      assert(await win.webContents.executeJavaScript('document.body.innerText.includes("Valid Excel file")'),'Configured workbook was not loaded');
      await win.webContents.executeJavaScript(`(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'TTTACGTTGCAACCTGGG');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await wait(200);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Find Binding Primers').click()`);
      for(let i=0;i<60;i++) {
        if(await win.webContents.executeJavaScript('document.body.innerText.includes("Found 2 matching primers")'))break;
        await wait(200);
      }
      assert(await win.webContents.executeJavaScript('document.body.innerText.includes("Found 2 matching primers")'),'Late primer row was not searched');
      fs.writeFileSync('C:/Export/primer-finder.png',(await win.webContents.capturePage()).toPNG());
      fs.writeFileSync('C:/Export/primer-ui.json',JSON.stringify({status:'passed',configuredWorkbook:true,lateRow150:true,matchingPrimers:2}));
      stage='reference-config';
      fs.mkdirSync('C:/Export/reference-files',{recursive:true});
      await win.webContents.executeJavaScript(`window.api.saveConfig({Reference_Sequences:'C:/Export/reference-files'},{})`);
      stage='back-to-hub';
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim().endsWith('Hub')).click()`);
      stage='rescan';await wait(250);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Rescan').click()`);
      await wait(400);
      for(let i=0;i<100;i++){if(await win.webContents.executeJavaScript(`!![...document.querySelectorAll('button')].find(b=>b.innerText==='Rescan'&&!b.disabled)`))break;await wait(200);}
      stage='open-reference-files';
      await win.webContents.executeJavaScript(`document.querySelector('[aria-label="Open Sequencing Reference Files"]').click()`);
      for(let i=0;i<60;i++) {
        if(await win.webContents.executeJavaScript('document.body.innerText.includes("Validated (input addon sheet found)")'))break;
        await wait(200);
      }
      assert(await win.webContents.executeJavaScript('document.body.innerText.includes("Validated (input addon sheet found)")'),'Reference file path did not load');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('input[type=text]').value.replaceAll('\\\\','/')`),'C:/Export/reference-files','Configured output folder mismatch');
      stage='export-reference-files';
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Export Sequences').click()`);
      for(let i=0;i<60;i++) {
        if(await win.webContents.executeJavaScript('document.body.innerText.includes("Done. 4 files written.")'))break;
        await wait(200);
      }
      for(const [name,contents] of Object.entries({'GSH-TEST-01.txt':'ACGT','GSH-TEST-01+pUC57.txt':'GGACGTCC','GSH-TEST-02.txt':'TTAA','GSH-TEST-02+pET24a.txt':'CCTTAAGG'}))assert.equal(fs.readFileSync('C:/Export/reference-files/'+name,'utf8'),contents);
      fs.writeFileSync('C:/Export/reference-files.png',(await win.webContents.capturePage()).toPNG());
      fs.writeFileSync('C:/Export/reference-files-ui.json',JSON.stringify({status:'passed',configuredWorkbook:true,nativeWrites:4,exactBytes:true}));
      stage='ligation';
      const jobBook=XLSX.utils.book_new(),fragmentBook=XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(jobBook,XLSX.utils.aoa_to_sheet([
        ['Work No.','BBI ID','Vector','Cloning Site','Resistance','Length (bp)'],
        ['GSH-TEST-01','BBI-TEST','pUC57','EcoRI','Amp',1200],
      ]),'Initiated');
      XLSX.utils.book_append_sheet(fragmentBook,XLSX.utils.aoa_to_sheet([
        ['Position','Gene Name','Sequence','Purity Pass','Yield Pass','Unused','Concentration'],
        ['A1','GSH-TEST-01','ACGT'.repeat(100),'Pass','Pass','',20],
      ]),'PCR Fragments');
      XLSX.writeFile(jobBook,'C:/Export/synthetic-job-log.xlsx');
      XLSX.writeFile(fragmentBook,'C:/Export/synthetic-fragments.xlsx');
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim().endsWith('Hub')).click()`);
      await wait(200);
      await win.webContents.executeJavaScript(`document.querySelector('[aria-label="Open Ligation Layout"]').click()`);
      await wait(500);
      win.webContents.debugger.attach('1.3');
      const {root}=await win.webContents.debugger.sendCommand('DOM.getDocument');
      const {nodeIds}=await win.webContents.debugger.sendCommand('DOM.querySelectorAll',{nodeId:root.nodeId,selector:'input[type=file]'});
      const source=require('node:path').resolve(__dirname,'../python-app');
      const inputs=['C:/Export/synthetic-job-log.xlsx','C:/Export/synthetic-fragments.xlsx',source+'/Templates/Ligation_Template_v6.xlsx',source+'/Databases/Vector_database.xlsx'];
      assert.equal(nodeIds.length,4);
      for(let i=0;i<4;i++)await win.webContents.debugger.sendCommand('DOM.setFileInputFiles',{nodeId:nodeIds[i],files:[inputs[i]]});
      win.webContents.debugger.detach();
      await win.webContents.executeJavaScript(`(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'GSH-TEST-01');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await wait(250);
      const {dialog}=require('electron');
      const ligationOutput='C:/Export/ligation-output-'+Date.now()+'.xlsx';
      dialog.showSaveDialog=async()=>({canceled:false,filePath:ligationOutput});
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Generate Layout').click()`);
      for(let i=0;i<100;i++) {if(fs.existsSync(ligationOutput))break;await wait(200);}
      assert(fs.existsSync(ligationOutput),'Ligation workbook was not generated');
      await wait(200);
      assert(await win.webContents.executeJavaScript(`!![...document.querySelectorAll('button')].find(b=>b.innerText==='Generate Layout'&&!b.disabled)`),'Generate remained stuck after success');
      const resultBook=XLSX.readFile(ligationOutput);
      assert.equal(resultBook.Sheets.Layout.B2.v,'GSH-TEST-01');
      assert.equal(resultBook.Sheets.Layout.T2.v,1200);
      fs.writeFileSync('C:/Export/ligation.png',(await win.webContents.capturePage()).toPNG());
      fs.writeFileSync('C:/Export/ligation-ui.json',JSON.stringify({status:'passed',nativeFileSelections:4,generatedWorkbook:true,repeatEnabled:true,path:ligationOutput,workNo:'GSH-TEST-01',length:1200}));
      stage='colony-pcr';
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim().endsWith('Hub')).click()`);
      await wait(200);
      await win.webContents.executeJavaScript(`document.querySelector('[aria-label="Open Colony PCR Layout"]').click()`);
      await wait(500);
      win.webContents.debugger.attach('1.3');
      const document2=await win.webContents.debugger.sendCommand('DOM.getDocument');
      const nodes2=await win.webContents.debugger.sendCommand('DOM.querySelectorAll',{nodeId:document2.root.nodeId,selector:'input[type=file]'});
      assert.equal(nodes2.nodeIds.length,3);
      const colonyInputs=[ligationOutput,'C:/Export/synthetic-primer-log.xlsx',source+'/Templates/ColonyPCR_layout_v3.xlsx'];
      for(let i=0;i<3;i++)await win.webContents.debugger.sendCommand('DOM.setFileInputFiles',{nodeId:nodes2.nodeIds[i],files:[colonyInputs[i]]});
      win.webContents.debugger.detach();await wait(200);
      const colonyOutput='C:/Export/colony-'+Date.now();fs.mkdirSync(colonyOutput);
      dialog.showOpenDialog=async()=>({canceled:false,filePaths:[colonyOutput]});
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Generate Layout').click()`);
      for(let i=0;i<60;i++){if(await win.webContents.executeJavaScript(`!!document.querySelector('input[type=number]')`))break;await wait(200);}
      await win.webContents.executeJavaScript(`(()=>{const e=document.querySelector('input[type=number]');Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,'6');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await wait(200);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Confirm').click()`);
      for(let i=0;i<100;i++){if(fs.readdirSync(colonyOutput).some(n=>n.endsWith('.xlsx')))break;await wait(200);}
      const colonyFile=fs.readdirSync(colonyOutput).find(n=>n.endsWith('.xlsx'));assert(colonyFile,'Colony workbook not written');
      const colonyBook=XLSX.readFile(colonyOutput+'/'+colonyFile);
      const clones=Object.entries(colonyBook.Sheets['Plate 1']).filter(([ref,c])=>/^[B-M](?:[3-9]|10)$/.test(ref)&&String(c.v).startsWith('GSH-TEST-01-Clone'));
      assert.equal(clones.length,6,'Clone count edit was not applied');
      assert(clones.some(([,c])=>c.v==='GSH-TEST-01-Clone6'));
      fs.writeFileSync('C:/Export/colony-pcr.png',(await win.webContents.capturePage()).toPNG());
      fs.writeFileSync('C:/Export/colony-pcr-ui.json',JSON.stringify({status:'passed',nativeFileSelections:3,editedCloneCount:6,actualCloneCells:clones.length,path:colonyOutput+'/'+colonyFile}));
      stage='sequencing-order-form';
      const orderDir='C:/Export/order-form-'+Date.now()+'/U1029-1';fs.mkdirSync(orderDir,{recursive:true});
      const validation=XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(validation,XLSX.utils.aoa_to_sheet([
        ['Work No.','BBI ID','Clone','Sequence Sample ID'],['GSH-TEST-01','BBI-TEST','Clone1','U1029P1A1'],
      ]),'Sequencing Pending');
      const validationFile=orderDir+'/Sequencing_validation.xlsx';XLSX.writeFile(validation,validationFile);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim().endsWith('Hub')).click()`);
      await wait(200);
      await win.webContents.executeJavaScript(`document.querySelector('[aria-label="Open Sequencing Order Form"]').click()`);
      await wait(700);
      win.webContents.debugger.attach('1.3');
      const document3=await win.webContents.debugger.sendCommand('DOM.getDocument');
      const nodes3=await win.webContents.debugger.sendCommand('DOM.querySelectorAll',{nodeId:document3.root.nodeId,selector:'input[type=file]'});
      assert.equal(nodes3.nodeIds.length,3);
      await win.webContents.debugger.sendCommand('DOM.setFileInputFiles',{nodeId:nodes3.nodeIds[2],files:[validationFile]});
      win.webContents.debugger.detach();
      for(let i=0;i<60;i++){if(await win.webContents.executeJavaScript(`!![...document.querySelectorAll('button')].find(b=>b.innerText==='Generate Form'&&!b.disabled)`))break;await wait(200);}
      assert(await win.webContents.executeJavaScript(`!![...document.querySelectorAll('button')].find(b=>b.innerText==='Generate Form'&&!b.disabled)`),'Configured Primer Log/form template not validated');
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Generate Form').click()`);
      const orderFile=orderDir+'/Sequencing_order_form_U1029-1.xlsx',layoutFile=orderDir+'/Sequencing_layout_U1029-1.xlsx';
      for(let i=0;i<100;i++){if(fs.existsSync(layoutFile))break;await wait(200);}
      for(let i=0;i<100;i++){if(await win.webContents.executeJavaScript(`!![...document.querySelectorAll('button')].find(b=>b.innerText==='Generate Form'&&!b.disabled)&&document.body.innerText.includes('Layout saved with')`))break;await wait(200);}
      assert(fs.existsSync(orderFile)&&fs.existsSync(layoutFile),'Linked workbook pair not written');
      const orderSheet=XLSX.readFile(orderFile).Sheets['Order form'];
      assert.equal(orderSheet.G20.v,'GSH-TEST-01');assert.equal(orderSheet.D20.v,'GSH-TEST-01_F');assert.equal(orderSheet.D21.v,'GSH-TEST-01_R');
      const archive=require('fflate').unzipSync(fs.readFileSync(layoutFile));
      assert(Buffer.from(archive['xl/externalLinks/_rels/externalLink1.xml.rels']).toString().includes('Sequencing_order_form_U1029-1.xlsx'));
      fs.writeFileSync('C:/Export/order-form.png',(await win.webContents.capturePage()).toPNG());
      fs.writeFileSync('C:/Export/order-form-ui.json',JSON.stringify({status:'passed',configuredInputsLoaded:2,nativeFileSelection:1,orderFile,layoutFile,primers:2,linkUpdatedWithoutCOM:true}));
      stage='sequencing-file-organizer';
      const ioRoot='C:/Export/organizer-'+Date.now(),rawDir=ioRoot+'/raw',sortedDir=ioRoot+'/sorted',sgDir=ioRoot+'/sg-check';
      for(const dir of [rawDir,sortedDir,sgDir])fs.mkdirSync(dir,{recursive:true});
      const rawName='U1029P1A1_GSH-TEST-01_F.AB1';
      fs.copyFileSync('C:/Control/fixtures/real-trace.ab1',rawDir+'/'+rawName);
      fs.writeFileSync(rawDir+'/U1029P1A1_GSH-TEST-01_R.fasta','>synthetic\nACGTACGT\n');
      fs.writeFileSync(rawDir+'/pOs_control_F.AB1','positive control fixture');
      fs.writeFileSync(rawDir+'/unparseable.AB1','unparseable fixture');
      fs.writeFileSync(rawDir+'/discard.SEQ','discard fixture');
      const checksum=file=>require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      const traceHash=checksum(rawDir+'/'+rawName);
      const setField=async(selector,value)=>{await win.webContents.executeJavaScript(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);await wait(100);};
      const until=async(expression)=>{for(let i=0;i<100;i++){if(await win.webContents.executeJavaScript(expression))return;await wait(150);}throw new Error('Timed out: '+expression);};
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim().endsWith('Hub')).click()`);await wait(200);
      await win.webContents.executeJavaScript(`document.querySelector('[aria-label="Open Sequencing File Organizer"]').click()`);await wait(500);
      await setField('#sfo-source-dir',rawDir);await setField('#sfo-dest-dir',sortedDir);
      await win.webContents.executeJavaScript(`document.querySelector('#sfo-organize-run').click()`);
      await until(`!!document.querySelector('#sfo-dialog-abort')`);
      await win.webContents.executeJavaScript(`document.querySelector('#sfo-dialog-abort').click()`);await wait(200);
      assert(fs.existsSync(rawDir+'/discard.SEQ')&&checksum(rawDir+'/'+rawName)===traceHash,'Abort changed source files');
      await win.webContents.executeJavaScript(`document.querySelector('#sfo-organize-run').click()`);
      await until(`!!document.querySelector('#sfo-dialog-skip')`);
      await win.webContents.executeJavaScript(`document.querySelector('#sfo-dialog-skip').click()`);
      await until(`document.body.innerText.includes('Organized 2 files.')`);
      const folder='GSH-TEST-01.U1029P1A1';
      assert.equal(checksum(sortedDir+'/'+folder+'/'+rawName),traceHash);
      assert(!fs.existsSync(rawDir+'/'+rawName));assert(!fs.existsSync(rawDir+'/discard.SEQ'));
      assert(fs.existsSync(rawDir+'/pOs_control_F.AB1')&&fs.existsSync(rawDir+'/unparseable.AB1'));
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Distribute References').click()`);await wait(200);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#sfo-dist-dest-dir').value.replaceAll('\\\\','/')`),sortedDir,'Sorted folder was not carried between tabs');
      await setField('#sfo-ref-dir','C:/Export/reference-files');
      await win.webContents.executeJavaScript(`document.querySelector('#sfo-distribute-run').click()`);
      await until(`document.body.innerText.includes('Distributed 2 files.')`);
      assert.equal(fs.readFileSync(sortedDir+'/'+folder+'/GSH-TEST-01.txt','utf8'),'ACGT');
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText==='SG Check Document').click()`);await wait(200);
      await setField('#sfo-output-dir',sgDir);
      await win.webContents.executeJavaScript(`document.querySelector('#sfo-sgcheck-run').click()`);
      for(let i=0;i<100;i++){if(fs.readdirSync(sgDir).some(n=>n.endsWith('.xlsx')))break;await wait(200);}
      const sgFile=fs.readdirSync(sgDir).find(n=>n.endsWith('.xlsx'));assert(sgFile,'SG Check file not written');
      const sgBook=XLSX.readFile(sgDir+'/'+sgFile);assert.equal(sgBook.Sheets[sgBook.SheetNames[0]].A2.v,folder);
      const sgParts=require('fflate').unzipSync(fs.readFileSync(sgDir+'/'+sgFile));
      const sgOriginal=require('fflate').unzipSync(fs.readFileSync(source+'/Templates/Gene_Seq_Log_v2.xlsx'));
      for(const key of Object.keys(sgOriginal))if(!key.startsWith('xl/worksheets/'))assert.deepEqual(sgParts[key],sgOriginal[key],'SG Check changed '+key);
      fs.writeFileSync('C:/Export/organizer.png',(await win.webContents.capturePage()).toPNG());
      fs.writeFileSync('C:/Export/organizer-ui.json',JSON.stringify({status:'passed',abortPreservedFiles:true,traceSha256:traceHash,movedFiles:2,discardedSyntheticSeq:1,positiveAndUnparseablePreserved:true,referencesDistributed:2,sessionFolderCarried:true,sgFile:sgDir+'/'+sgFile,externalLinksPreserved:true}));
      stage='integra-worklist';
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim().endsWith('Hub')).click()`);await wait(200);
      await win.webContents.executeJavaScript(`document.querySelector('[aria-label="Open Integra Worklist"]').click()`);await wait(400);
      const bulkPaste=[['GSH-TEST-01','BBI-TEST','Clone-X','U1029P1A1','note','20','1.8','2.0','3',''],['GSH-TEST-01','BBI-TEST','Clone-X','U1029P1B1','note','40','2.0','2.2','3',''],['GSH-TEST-02','BBI-TEST-2','Clone-Y','U1029P1C1','note','50','1.9','2.1','2','']].map(r=>r.join('\t')).join('\n');
      await win.webContents.executeJavaScript(`(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(bulkPaste)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await wait(100);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Load rows').click()`);await wait(100);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Create worklist').click()`);await wait(150);
      const integraDir='C:/Export/integra-'+Date.now();fs.mkdirSync(integraDir);
      dialog.showSaveDialog=async options=>({canceled:false,filePath:integraDir+'/'+require('node:path').basename(options.defaultPath)});
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Save worklist').click()`);await wait(150);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Save validation').click()`);await wait(150);
      const bulkCsv=fs.readFileSync(integraDir+'/integra_worklist.csv','utf8');
      assert(bulkCsv.includes('GSH-TEST-01;B;A1;C;A1;85\nGSH-TEST-01;B;B1;C;A1;85\nGSH-TEST-02;B;C1;C;B1;85'));
      assert(fs.readFileSync(integraDir+'/integra_worklist_validation.csv','utf8').includes('GSH-TEST-01,BBI-TEST,Clone-X,U1029P1A1x2,note,30,1.9,2.1'));
      fs.writeFileSync('C:/Export/integra-bulk.png',(await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Single entries').click()`);await wait(100);
      await setField('[aria-label="Work No."]','SINGLE-TEST');
      await win.webContents.executeJavaScript(`document.querySelector('[aria-label="Source well A1"]').click();document.querySelector('[aria-label="Target well H6"]').click()`);await wait(100);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Add sample').click()`);await wait(100);
      await setField('[aria-label="File name"]','integra_single');
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Save worklist').click()`);await wait(150);
      assert(fs.readFileSync(integraDir+'/integra_single.csv','utf8').includes('SINGLE-TEST;B;A1;C;H6;85'));
      fs.writeFileSync('C:/Export/integra-single.png',(await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Bulk mode').click()`);await wait(100);
      assert(await win.webContents.executeJavaScript(`document.body.innerText.includes('GSH-TEST-02')`),'Bulk output lost while switching modes');
      fs.writeFileSync('C:/Export/integra-ui.json',JSON.stringify({status:'passed',nativeRoute:true,bulkTransfers:3,pooledValidationRows:2,singleTransfer:'SINGLE-TEST;B;A1;C;H6;85',outputsPreservedAcrossModes:true,directory:integraDir}));
      stage='label-generator';
      const shipping=XLSX.utils.book_new();
      const shippingRows=[['12345678','BBI-TEST-01','GeneOne','WORK-001',1200,'pUC57','EcoRI','P1234567','5ug','202610A001'],['12345678','BBI-TEST-01','','',1200,'pUC57','EcoRI','P1234568','5ug','202610A002'],['12345679','BBI-TEST-02','GeneTwo','WORK-002',900,'pET24a','NdeI','U1234569','3ug','202610B001']];
      XLSX.utils.book_append_sheet(shipping,XLSX.utils.aoa_to_sheet(shippingRows),'Shipping');
      const shippingFile='C:/Export/synthetic-shipping.xlsx';XLSX.writeFile(shipping,shippingFile);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim().endsWith('Hub')).click()`);await wait(200);
      await win.webContents.executeJavaScript(`document.querySelector('[aria-label="Open Label Generator"]').click()`);await wait(300);
      win.webContents.debugger.attach('1.3');
      const labelDocument=await win.webContents.debugger.sendCommand('DOM.getDocument');
      const labelInput=await win.webContents.debugger.sendCommand('DOM.querySelector',{nodeId:labelDocument.root.nodeId,selector:'input[type=file]'});
      await win.webContents.debugger.sendCommand('DOM.setFileInputFiles',{nodeId:labelInput.nodeId,files:[shippingFile]});win.webContents.debugger.detach();await wait(150);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Read shipping lists').click()`);
      await until(`!![...document.querySelectorAll('button')].find(b=>b.innerText==='Add all'&&!b.disabled)`);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Add all').click()`);await wait(100);
      const labelDir='C:/Export/labels-'+Date.now();fs.mkdirSync(labelDir);
      dialog.showSaveDialog=async()=>({canceled:false,filePath:labelDir+'/Shipping_labels.csv'});
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Copy labels').click()`);await wait(100);
      assert(require('electron').clipboard.readText().includes('BBI-TEST-01\tGeneOne\tpUC57'));
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Save CSV').click()`);await wait(150);
      const labelCsv=fs.readFileSync(labelDir+'/Shipping_labels.csv','utf8');
      assert.equal(labelCsv.trim().split(/\r?\n/).length,3);assert(labelCsv.includes('BBI-TEST-01,GeneOne,pUC57,,5ug,1200,P1234567,202610A001,12345678,-20'));
      fs.writeFileSync('C:/Export/label-generator.png',(await win.webContents.capturePage()).toPNG());
      // Start a real larger parse and stop after the first worker progress event.
      const large=XLSX.utils.book_new();XLSX.utils.book_append_sheet(large,XLSX.utils.aoa_to_sheet(Array.from({length:5000},(_,i)=>shippingRows[i%shippingRows.length])),'Shipping');
      const largeFile='C:/Export/synthetic-shipping-5000.xlsx';XLSX.writeFile(large,largeFile);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Clear files').click();globalThis.pythonProgress=[];window.api.onPythonProgress(e=>pythonProgress.push(e));true;`);
      await wait(100);
      win.webContents.debugger.attach('1.3');
      const cancelDocument=await win.webContents.debugger.sendCommand('DOM.getDocument');
      const cancelInput=await win.webContents.debugger.sendCommand('DOM.querySelector',{nodeId:cancelDocument.root.nodeId,selector:'input[type=file]'});
      await win.webContents.debugger.sendCommand('DOM.setFileInputFiles',{nodeId:cancelInput.nodeId,files:[largeFile]});win.webContents.debugger.detach();await wait(100);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Read shipping lists').click()`);
      await until('pythonProgress.length>0');
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Stop').click()`);
      await until(`document.body.innerText.includes('Canceled.')`);
      assert.equal(require('electron').BrowserWindow.getAllWindows().length,1,'Python processing opened an extra GUI window');
      fs.writeFileSync('C:/Export/label-ui.json',JSON.stringify({status:'passed',bundledPython:true,headless:true,replicatesCollapsed:true,labelRows:2,clipboardAndCsv:true,canceledActual5000RowParse:true,directory:labelDir}));
      stage='batch-qc-report';
      const batchRoot='C:/Export/batch-ui-'+Date.now(),batchInput=batchRoot+'/input',batchOutput=batchRoot+'/output';
      fs.mkdirSync(batchOutput,{recursive:true});
      const python=source+'/runtime/python.exe';
      const fixtureRun=require('node:child_process').spawnSync(python,['-I','-X','utf8',require('node:path').join(__dirname,'make-batch-fixture.py'),batchInput],{encoding:'utf8',timeout:30000});
      assert.equal(fixtureRun.status,0,fixtureRun.stderr);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim().endsWith('Hub')).click()`);await wait(200);
      await win.webContents.executeJavaScript(`document.querySelector('[aria-label="Open BATCH QC Report"]').click()`);await wait(300);
      await setField('[aria-label="BATCH ZIP folder"]',batchInput);await setField('[aria-label="Output folder"]',batchOutput);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Create QC report').click()`);
      for(let i=0;i<600;i++){if(fs.existsSync(batchOutput+'/QC_Report.xlsx'))break;await wait(200);}
      assert(fs.existsSync(batchOutput+'/QC_Report.xlsx'),'Native BATCH report was not written');await wait(300);
      const report=XLSX.readFile(batchOutput+'/QC_Report.xlsx').Sheets['QC Report'];
      assert.equal(report.B2.v,'BATCH 1234-01');assert.equal(report.C2.v,'26TEST001');assert.equal(report.D2.v,30);assert.equal(report.E2.v,0.6);
      assert(await win.webContents.executeJavaScript(`document.body.innerText.includes('BATCH 1234-01')&&document.body.innerText.includes('Review 1 item(s)')`),'Report preview/warning missing');
      fs.writeFileSync('C:/Export/batch-qc.png',(await win.webContents.capturePage()).toPNG());
      fs.writeFileSync('C:/Export/batch-ui.json',JSON.stringify({status:'passed',bundledPythonAndOcr:true,headless:true,zipRecords:2,od260:0.6,ngPerUl:30,missingOdReviewed:true,noWordRequiredForDocx:true,output:batchOutput+'/QC_Report.xlsx'}));
      stage='qc-digestion-design';
      const mapDir='C:/Export/maps-ui-'+Date.now();fs.mkdirSync(mapDir);
      const mapBook=XLSX.utils.book_new();XLSX.utils.book_append_sheet(mapBook,XLSX.utils.aoa_to_sheet([['Work No.','Insert Sequence','Final Vector Sequence'],['MAP-001','CGT','AACGTGGA'],['MAP-WRAP','GGAAA','AACGTGGA']]),'input addon');
      const mapLog=mapDir+'/Primer_Log.xlsx';XLSX.writeFile(mapBook,mapLog);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim().endsWith('Hub')).click()`);await wait(200);
      await win.webContents.executeJavaScript(`document.querySelector('[aria-label="Open QC Digestion Design"]').click()`);await wait(300);
      await setField('[aria-label="QC Primer Log"]',mapLog);await setField('[aria-label="QC output folder"]',mapDir);await setField('[aria-label="QC Work Nos"]','MAP-001\nMAP-WRAP');
      await until(`!![...document.querySelectorAll('button')].find(b=>b.innerText==='Create GenBank maps'&&!b.disabled)`);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Create GenBank maps').click()`);
      await until(`document.body.innerText.includes('Complete.')`);
      assert(fs.existsSync(mapDir+'/MAP-001.gb'));assert(fs.readFileSync(mapDir+'/MAP-WRAP.gb','utf8').includes('join(6..8,1..2)'));
      fs.writeFileSync('C:/Export/qc-design.png',(await win.webContents.capturePage()).toPNG());
      fs.writeFileSync('C:/Export/qc-design-ui.json',JSON.stringify({status:'passed',nativeRoute:true,bundledPython:true,circularInsert:true,output:mapDir}));
      stage='qc-file-prep';
      const prepDir='C:/Export/qc-prep-ui-'+Date.now();fs.mkdirSync(prepDir);
      const prepFixture=require('node:child_process').spawnSync(python,['-I','-X','utf8',require('node:path').join(__dirname,'make-qc-prep-fixture.py'),prepDir],{encoding:'utf8',timeout:30000});assert.equal(prepFixture.status,0,prepFixture.stderr);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim().endsWith('Hub')).click()`);await wait(200);
      await win.webContents.executeJavaScript(`document.querySelector('[aria-label="Open QC File Prep"]').click()`);await wait(300);
      await setField('[aria-label="QC workflow"]','internal');
      await setField('[aria-label="Source ZIP folder"]',prepDir+'/internal');await setField('[aria-label="QC export folder"]',prepDir);await setField('[aria-label="Replacement map (tab-separated)"]',prepDir+'/rename.txt');
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Prepare QC files').click()`);
      await until(`document.body.innerText.includes('Complete.')`);assert(await win.webContents.executeJavaScript(`document.body.innerText.includes('BBI-TEST-99 QC.zip')`));
      fs.writeFileSync('C:/Export/qc-file-prep.png',(await win.webContents.capturePage()).toPNG());
      await setField('[aria-label="QC workflow"]','batch-post');
      await setField('[aria-label="Source ZIP folder"]',prepDir+'/batch');
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Prepare QC files').click()`);
      await until(`!!document.querySelector('[aria-label="pUC57 vector FASTA"]')`);
      await setField('[aria-label="pUC57 vector FASTA"]',prepDir+'/pUC57.fasta');
      for(const [label,value] of [['OD260','0.6'],['OD280','0.3'],['OD260/OD280','2'],['µg/µL','30']])await setField('[aria-label="'+label+'"]',value);
      fs.writeFileSync('C:/Export/qc-file-prep-prompt.png',(await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Process').click()`);
      await until(`document.body.innerText.includes('Complete.')`);assert(await win.webContents.executeJavaScript(`document.body.innerText.includes('BATCH001.zip')`));
      fs.writeFileSync('C:/Export/qc-prep-ui.json',JSON.stringify({status:'passed',nativeRoute:true,bundledPython:true,internalRename:true,batchInteractivePrompt:true,odMeasurements:4,output:prepDir}));
      app.exit(0);
    } catch(error) {
      fs.writeFileSync('C:/Export/ui-error.txt',stage+'\n'+error.stack);
      fs.writeFileSync('C:/Export/ui-error-dom.txt',await win.webContents.executeJavaScript('document.body.innerText').catch(()=>''));
      app.exit(1);
    }
  });
});
require('../electron/main.js');
