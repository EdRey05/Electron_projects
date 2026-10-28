# Actual release app in the network-enabled recording/acceptance Sandbox.
param()
$ErrorActionPreference='Stop'
if($env:USERNAME -ne 'WDAGUtilityAccount'){throw 'Use the configured Windows Sandbox.'}
$export='C:\DemoExport';$frameDirectory='C:\DemoFrames';$app=$null;$recorder=$null
New-Item -ItemType Directory C:\DemoApp,$export -Force|Out-Null
Start-Transcript "$export\recording.log" -Force|Out-Null
$record=@{app='002_Sequence_Binding_Finder';version='1.2.0';status='failed';synthetic=$false;capture='Actual release renderer; accession-derived corpus and deterministic mutations; CDP controls';error=$null}
function Send($Socket,[string]$Method,$Parameters){
 $script:messageId++;$id=$script:messageId
 $bytes=[Text.Encoding]::UTF8.GetBytes((@{id=$id;method=$Method;params=$Parameters}|ConvertTo-Json -Depth 35 -Compress))
 $Socket.SendAsync([ArraySegment[byte]]::new($bytes),[Net.WebSockets.WebSocketMessageType]::Text,$true,[Threading.CancellationToken]::None).GetAwaiter().GetResult()|Out-Null
 $timeout=[Threading.CancellationTokenSource]::new(30000)
 try{do{$stream=[IO.MemoryStream]::new();do{$buffer=[byte[]]::new(65536);$r=$Socket.ReceiveAsync([ArraySegment[byte]]::new($buffer),$timeout.Token).GetAwaiter().GetResult();$stream.Write($buffer,0,$r.Count)}while(!$r.EndOfMessage);$reply=[Text.Encoding]::UTF8.GetString($stream.ToArray())|ConvertFrom-Json;$stream.Dispose()}while($reply.id -ne $id);if($reply.error){throw ($reply.error|ConvertTo-Json -Compress)};return $reply.result}finally{$timeout.Dispose()}
}
function Eval([string]$Expression,[switch]$Main){
 $s=$script:socket
 if($Main){$s=[Net.WebSockets.ClientWebSocket]::new();$s.Options.KeepAliveInterval=[TimeSpan]::Zero;$s.ConnectAsync([Uri]$script:mainUrl,[Threading.CancellationToken]::None).GetAwaiter().GetResult()|Out-Null}
 try{$r=Send $s 'Runtime.evaluate' @{expression=$Expression;awaitPromise=$true;returnByValue=$true};if($r.exceptionDetails){throw ($r.exceptionDetails|ConvertTo-Json -Depth 10 -Compress)};return $r.result.value}finally{if($Main){$s.Dispose()}}
}
function Observe([string]$Label){Eval '({text:document.body.innerText,cards:[...document.querySelectorAll("dl")].map(e=>({text:e.innerText,green:e.classList.contains("bg-emerald-100"),rect:e.getBoundingClientRect().toJSON()}))})' | ConvertTo-Json -Depth 12 | Set-Content "$export\$Label.json" -Encoding UTF8}
function Step([string]$Label,[string]$Expression='',[int]$Seconds=3){
 Write-Output $Label
 Eval ('(()=>{let e=document.getElementById("demo-caption");if(!e){e=document.createElement("div");e.id="demo-caption";e.style="position:fixed;bottom:12px;right:16px;z-index:2147483647;background:#102d42ed;color:white;padding:10px 18px;border-radius:8px;font:16px Arial;pointer-events:none";document.body.append(e)}e.textContent='+($Label|ConvertTo-Json -Compress)+';return true})()')|Out-Null
 if($Expression){Eval $Expression|Out-Null};Start-Sleep -Seconds $Seconds;Observe ($Label -replace '[^A-Za-z0-9_-]','_')
}
function Click([string]$Text){$t=$Text|ConvertTo-Json -Compress;return "(()=>{const a=[...document.querySelectorAll('button')].filter(e=>e.innerText.trim()===$t);if(a.length!==1||a[0].disabled)throw Error('Button unavailable: '+$t);a[0].click();return true})()"}
function WaitFor([string]$Expression){$until=(Get-Date).AddSeconds(90);do{if(Eval $Expression){return};Start-Sleep -Milliseconds 250}while((Get-Date) -lt $until);throw "Timed out: $Expression"}
function Fill([string]$Selector,[string]$Value){$s=$Selector|ConvertTo-Json -Compress;$v=$Value|ConvertTo-Json -Compress;Eval "(()=>{window.scrollTo({top:0,behavior:'instant'});const e=document.querySelector($s);Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,$v);e.dispatchEvent(new Event('input',{bubbles:true}));return true})()"|Out-Null;Start-Sleep -Milliseconds 150}
function LoadWorkbook([string]$File){$doc=Send $script:socket 'DOM.getDocument' @{};$n=Send $script:socket 'DOM.querySelector' @{nodeId=$doc.root.nodeId;selector='input[type=file][accept=".xlsx,.xls"]'};Send $script:socket 'DOM.setFileInputFiles' @{nodeId=$n.nodeId;files=@($File)}|Out-Null;Start-Sleep -Milliseconds 500}
function RunCheck([string]$Name){Eval 'globalThis.lastComplete=null;globalThis.runBefore=demoMeasure();globalThis.runSamples=[];globalThis.sampleLayout=true;function captureRunLayout(){if(sampleLayout){runSamples.push(demoMeasure());requestAnimationFrame(captureRunLayout)}}requestAnimationFrame(captureRunLayout);true'|Out-Null;Eval (Click 'Run analysis')|Out-Null;WaitFor '!!globalThis.lastComplete&&document.querySelector(".sbf-results")?.dataset.state==="ready"';$layout=Eval '(()=>{sampleLayout=false;const final=demoMeasure();const frames=[...runSamples,final];let maxShift=0;for(const frame of frames){maxShift=Math.max(maxShift,Math.abs(frame.resultsTop-runBefore.resultsTop));for(const key of ["setup","analysis","run"]){for(const axis of ["x","y","width","height"]){if(Math.abs(frame[key][axis]-runBefore[key][axis])>0.6)throw Error("Layout shifted: "+key+"."+axis)}}}if(maxShift>0.6)throw Error("Results heading shifted");return{maxResultsShift:maxShift,frames:frames.length}})()';$data=Eval '({ms:lastComplete.elapsedMs,count:lastComplete.results.length,matching:lastComplete.results.filter(r=>r.status==="match").map(r=>({label:r.label,name:r.name,identity:r.identity,orientation:r.orientation,hitStart:r.hitStart,hitEnd:r.hitEnd,coverage:r.coverage,hitLength:r.hitLength})),text:document.body.innerText})';$data|Add-Member NoteProperty layout $layout;$data|ConvertTo-Json -Depth 15|Set-Content "$export\$Name.json" -Encoding UTF8;return $data}
function WriteWorkbook($Rows,[string]$Target){
 $zip=[IO.Compression.ZipFile]::Open($Target,[IO.Compression.ZipArchiveMode]::Create)
 try{
 $parts=@{
 '[Content_Types].xml'='<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'
 '_rels/.rels'='<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
 'xl/workbook.xml'='<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sequences" sheetId="1" r:id="rId1"/></sheets></workbook>'
 'xl/_rels/workbook.xml.rels'='<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
 }
 $xml=[Text.StringBuilder]::new();[void]$xml.Append('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="B1" t="inlineStr"><is><t>ID</t></is></c><c r="C1" t="inlineStr"><is><t>Sequence</t></is></c></row>');$i=1
 foreach($row in $Rows){$i++;[void]$xml.Append('<row r="'+$i+'">');$values=@($row.label,'test workload; not an NCBI release',$row.seq);for($j=0;$j -lt 3;$j++){[void]$xml.Append('<c r="'+[char](65+$j)+$i+'" t="inlineStr"><is><t>'+[Security.SecurityElement]::Escape($values[$j])+'</t></is></c>')};[void]$xml.Append('</row>')}
 [void]$xml.Append('</sheetData></worksheet>');$parts['xl/worksheets/sheet1.xml']=$xml.ToString()
 foreach($name in $parts.Keys){$writer=[IO.StreamWriter]::new($zip.CreateEntry($name).Open(),[Text.UTF8Encoding]::new($false));try{$writer.Write($parts[$name])}finally{$writer.Dispose()}}
 }finally{$zip.Dispose()}
}
try{
 $recipe=Get-Content C:\DemoRunner\recording-recipe.json -Raw|ConvertFrom-Json
 $zip='C:\DemoInput\sequence-binding-finder-1.2.0-win-x64-folder.zip'
 if((Get-FileHash $zip).Hash -ne $recipe.sha256){throw 'Artifact hash mismatch'}
 $record.artifactSha256=$recipe.sha256
 Add-Type -AssemblyName System.IO.Compression.FileSystem
 [IO.Compression.ZipFile]::ExtractToDirectory($zip,'C:\DemoApp')
 $corpus=Get-Content C:\DemoInput\corpus.json -Raw|ConvertFrom-Json
 $app=Start-Process 'C:\DemoApp\Sequence Binding Finder.exe' -ArgumentList '--remote-debugging-port=9222','--remote-debugging-address=127.0.0.1','--inspect=9229' -WindowStyle Hidden -PassThru -RedirectStandardError C:\DemoExport\app-stderr.log -RedirectStandardOutput C:\DemoExport\app-stdout.log
 $target=$null;for($n=0;$n -lt 60 -and !$target;$n++){Start-Sleep -Seconds 1;try{$targets=Invoke-RestMethod http://127.0.0.1:9222/json/list -TimeoutSec 3;$target=$targets|Where-Object type -eq 'page'|Select-Object -First 1}catch{}}
 if(!$target){throw 'Renderer did not start'}
 $script:messageId=0;$script:socket=[Net.WebSockets.ClientWebSocket]::new();$script:socket.ConnectAsync([Uri]$target.webSocketDebuggerUrl,[Threading.CancellationToken]::None).GetAwaiter().GetResult()
 $mainTargets=Invoke-RestMethod http://127.0.0.1:9229/json/list;$main=$mainTargets|Select-Object -First 1;$script:mainUrl=$main.webSocketDebuggerUrl
 $ver=Eval "globalThis.demoElectron=process.mainModule.require('electron');globalThis.demoFs=process.mainModule.require('fs');globalThis.demoPath=process.mainModule.require('path');globalThis.saveDialogs=0;demoElectron.dialog.showSaveDialog=async opts=>{saveDialogs++;return {canceled:false,filePath:demoPath.join('C:\\DemoExport',demoPath.basename(opts.defaultPath))}};demoElectron.BrowserWindow.getAllWindows()[0].setBounds({x:0,y:0,width:1320,height:960});demoElectron.app.getVersion()" -Main
 if($ver -ne '1.2.0'){throw 'Incorrect version'}
 Send $script:socket 'Emulation.setDeviceMetricsOverride' @{width=1280;height=900;deviceScaleFactor=1;mobile=$false}|Out-Null
 Eval 'globalThis.demoMeasure=()=>{const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return{x:r.x,y:r.y+scrollY,width:r.width,height:r.height}};return{setup:rect(".sbf-setup-grid"),analysis:rect(".sbf-analysis"),run:rect(".sbf-run"),resultsTop:rect(".sbf-results").y}};(()=>{const panels=[...document.querySelectorAll(".sbf-setup-section")].map(e=>e.getBoundingClientRect());if(panels.length!==2||Math.abs(panels[0].width-panels[1].width)>1||Math.abs(panels[0].height-panels[1].height)>1)throw Error("Unequal input panels");if(!document.querySelector("[role=tablist]")||!document.querySelector(".sbf-results-empty")||!document.querySelector("progress"))throw Error("Missing persistent layout");return true})()'|Out-Null
 Eval 'globalThis.workerEvents=[];globalThis.NativeWorker=Worker;globalThis.Worker=class extends NativeWorker{constructor(...a){super(...a);this.addEventListener("message",({data})=>{workerEvents.push({type:data.type,done:data.done,total:data.total,at:performance.now()});if(data.type==="complete")globalThis.lastComplete=data;});}};true'|Out-Null
 $recorder=Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File C:\DemoRunner\Capture-Frames.ps1 -Directory $frameDirectory -IntervalMs 90" -WindowStyle Hidden -PassThru
 Start-Sleep -Seconds 2
 Step 'Binding Search 1.2.0 · local sequence screening' '' 3
 Fill 'textarea' $corpus.queries[0][2];Fill 'input[type=text]' 'M13 read'
 LoadWorkbook 'C:\DemoInput\reference_phage_database.xlsx'
 Step 'One M13 read · 12 phage, vector and host references' '' 5
 $b=RunCheck 'modeB-M13';if($b.matching.Count -ne 1 -or $b.matching[0].identity -ne 100 -or $b.matching[0].hitStart -ne 1 -or $b.matching[0].hitEnd -ne 1200){throw 'M13 self-match contract failed'}
 Step 'M13 · 100% forward · database positions 1–1200' '' 5
 $again=RunCheck 'modeB-M13-repeat'
 if((Eval 'saveDialogs' -Main) -ne 0 -or @(Get-ChildItem $export -Filter binding_results*).Count){throw 'Run saved a file or opened a save dialog'}
 Step 'Inspect bases and coordinates' 'document.querySelector(".sbf-row").click();document.querySelector(".sbf-results").scrollIntoView({behavior:"smooth",block:"start"});true' 5
 $posterHeight=Eval 'Math.min(document.documentElement.scrollHeight,1400)';$poster=Send $script:socket 'Page.captureScreenshot' @{format='png';captureBeyondViewport=$true;clip=@{x=0;y=0;width=1280;height=$posterHeight;scale=1}};[IO.File]::WriteAllBytes("$export\002_Sequence_Binding_Finder.png",[Convert]::FromBase64String($poster.data))
 Step 'Export only when requested · XLSX and CSV' (Click 'Save .xlsx…') 2
 Eval (Click 'Save .csv…')|Out-Null;Start-Sleep -Seconds 2
 if((Eval 'saveDialogs' -Main) -ne 2 -or @(Get-ChildItem $export -Filter binding_results*).Count -ne 2){throw 'Manual exports missing'}
 Fill 'textarea' $corpus.queries[6][2];Fill 'input[type=text]' 'pUC19 vector read'
 $vector=RunCheck 'modeB-vector';if(!($vector.matching|Where-Object {$_.name -like '*pUC19*' -and $_.identity -eq 100})){throw 'Vector control failed'}
 Step 'Vector control · pUC19 sequence detected' '' 5
 Fill 'textarea' $corpus.queries[8][2];Fill 'input[type=text]' 'Ecoli host read'
 $hostRead=RunCheck 'modeB-host';if(!($hostRead.matching|Where-Object {$_.name -like '*E. coli*' -and $_.identity -eq 100})){throw 'Host control failed'}
 Step 'Host control · distinguish host DNA from phage' '' 5
 Eval (Click 'Screen candidates against a reference')|Out-Null;Fill 'textarea' $corpus.references[0][2];Fill 'input[type=text]' 'T7 32kb fragment';LoadWorkbook 'C:\DemoInput\test_query_assemblies.xlsx'
 $a=RunCheck 'modeA-T7';if(!($a.matching|Where-Object {$_.name -like '*Q04*' -and $_.identity -eq 95})){throw 'T7 control failed'}
 Step 'Candidate screening · T7 read at 95%' '' 5
 Fill 'textarea' $corpus.references[5][2];Fill 'input[type=text]' 'lambda 32kb fragment';$lambda=RunCheck 'modeA-lambda'
 if(!($lambda.matching|Where-Object {$_.name -like '*Q05*' -and $_.orientation -eq 'revcomp' -and [Math]::Abs($_.identity-92.6) -lt .001})){throw 'Lambda strand failed'}
 Step 'Lambda · reverse-complement hit at 92.60%' 'document.querySelector(".sbf-row").click();true' 6
 Fill 'textarea' $corpus.references[2][2];Fill 'input[type=text]' 'T4 32kb fragment'
 Eval '(()=>{const e=document.querySelector("input[type=range]");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,"86");e.dispatchEvent(new Event("input",{bubbles:true}));return true})()'|Out-Null;Start-Sleep -Milliseconds 200
 $t4=RunCheck 'modeA-T4-86';if(!($t4.matching|Where-Object {$_.name -like '*Q06*'})){throw 'T4 86% failed'}
 Step 'Custom threshold · T4 read passes at 86%' '' 5
 Eval '(()=>{const e=document.querySelector("input[type=range]");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,"87");e.dispatchEvent(new Event("input",{bubbles:true}));return true})()'|Out-Null;Start-Sleep -Milliseconds 200
 if((Eval 'document.querySelectorAll(".sbf-row").length') -ne 0){throw 'T4 87% should hide the hit'}
 Step 'At 87% the 86.56% hit falls below threshold' '' 4
 Eval (Click 'Search sequence against a database')|Out-Null;Eval (Click '90%')|Out-Null
 Step 'Optional NCBI download · cached for seven days' (Click 'Fetch UniVec_Core') 1
 WaitFor '!!document.querySelector(".sbf-database-summary")'
 $coreCount=Eval "globalThis.core=demoFs.readFileSync(demoPath.join(demoElectron.app.getPath('userData'),'univec_cache','UniVec_Core'),'utf8').trim().split(/^>/m).filter(Boolean).map(s=>{const a=s.split(/\r?\n/);return{label:a.shift(),seq:a.join('').replace(/[^ACGTN]/gi,'').toUpperCase()}});core.length" -Main
 if($coreCount -lt 100){throw 'NCBI database implausibly small'}
 $record.liveCoreEntries=$coreCount
 $probe=Eval 'core.find(r=>r.seq.length>=300).seq.slice(0,300)' -Main;Fill 'textarea' $probe;Fill 'input[type=text]' 'UniVec_Core 300bp probe'
 $coreRun=RunCheck 'live-Core-300bp'
 Step 'Search current UniVec_Core · actual record count shown' '' 5
 Step 'Results stay local · save exports when needed' '' 5
 New-Item -ItemType File "$frameDirectory\stop" -Force|Out-Null
 if(!$recorder.WaitForExit(20000)){throw 'Capture did not stop'}
 $record.performance=@{modeA_ms=$a.ms;modeB_ms=$b.ms;liveCore_ms=$coreRun.ms}
 if($a.ms -ge 1000 -or $b.ms -ge 1000 -or $coreRun.ms -ge 30000){throw 'Release worker performance target failed'}
 # Acceptance checks after the visible recording; no fabricated UI states.
 $liveMeta=Eval 'window.api.fetchUnivec({which:"UniVec_Core"}).then(m=>({cached:m.cached,entryCount:m.entryCount,sha256:m.sha256}))'
 if(!$liveMeta.cached -or $liveMeta.entryCount -ne $coreCount){throw 'Cache reuse failed'}
 $record.cache=$liveMeta
 foreach($index in @(17,943,2501)){
  $sequence=Eval "core[$index].seq" -Main
  foreach($strand in @('forward','revcomp')){
   $probe=$sequence;if($strand -eq 'revcomp'){$chars=$sequence.ToCharArray();[Array]::Reverse($chars);$probe=-join($chars|ForEach-Object{switch($_){A{'T'} C{'G'} G{'C'} T{'A'} N{'N'}}})}
   Fill 'textarea' $probe;$self=RunCheck "Core-self-$index-$strand";if(!($self.matching|Where-Object identity -eq 100)){throw 'UniVec self-match failed'}
  }
 }
 $stressRows=Eval 'Array.from({length:6100},(_,i)=>({label:"BENCHMARK duplicate "+i+" / "+core[i%core.length].label,seq:core[i%core.length].seq}))' -Main
 WriteWorkbook $stressRows "$export\benchmark-6100.xlsx";LoadWorkbook "$export\benchmark-6100.xlsx";Fill 'textarea' (Eval 'core.find(r=>r.seq.length>=300).seq.slice(0,300)' -Main)
 $stress=RunCheck 'benchmark-6100';$record.performance.benchmark6100_ms=$stress.ms
 if($stress.count -ne 6100 -or $stress.ms -ge 30000){throw '6100-row benchmark failed'}
 # Start a long real search and cancel immediately; no partial table is retained.
 Fill 'textarea' ($corpus.references[0][2]+$corpus.references[0][2]+$corpus.references[0][2]);Eval 'globalThis.lastComplete=null;globalThis.workerEvents=[];true'|Out-Null;Eval (Click 'Run analysis')|Out-Null
 WaitFor '[...document.querySelectorAll("button")].some(e=>e.innerText.trim()==="Stop")';Eval (Click 'Stop')|Out-Null;Start-Sleep -Seconds 1
 if(!(Eval 'document.body.innerText.includes("Analysis canceled.")&&!document.querySelector(".sbf-row")&&!!document.querySelector(".sbf-results-empty")')){throw 'Stop retained partial results'}
 $record.cancellation='passed';$record.cancelEvents=Eval 'workerEvents'
 $withoutM13=@($corpus.references|Where-Object{$_[0] -notlike '*M13*'}|ForEach-Object{@{label=$_[0];seq=$_[2]}})
 WriteWorkbook $withoutM13 "$export\without-M13.xlsx";LoadWorkbook "$export\without-M13.xlsx";Fill 'textarea' $corpus.queries[0][2]
 $missing=RunCheck 'modeB-without-M13';if($missing.matching.Count -ne 0){throw 'False positive without the M13 reference'}
 # Native FASTA chooser/read IPC, then paste validation and header override.
 $fasta='C:\DemoExport\one.fa';[IO.File]::WriteAllText($fasta,">single M13 read`n"+$corpus.queries[0][2])
 Eval "demoElectron.dialog.showOpenDialog=async()=>({canceled:false,filePaths:['C:\\DemoExport\\one.fa']});true" -Main|Out-Null
 Fill 'textarea' '';Eval (Click 'Load from .fasta/.txt')|Out-Null;WaitFor 'document.querySelector("textarea").value.length===1200'
 Fill 'textarea' ">one`nACGT`n>two`nTGCA";if(!(Eval 'document.body.innerText.includes("FASTA")&&[...document.querySelectorAll("button")].find(e=>e.innerText.trim()==="Run analysis").disabled')){throw 'Multi FASTA paste accepted'}
 LoadWorkbook 'C:\DemoInput\reference_phage_database.xlsx';Eval 'document.querySelector(".sbf-header-toggle input").click();true'|Out-Null;Start-Sleep -Milliseconds 100
 if(Eval 'document.querySelector(".sbf-header-toggle input").checked'){throw 'Header override failed'}
 Eval 'document.querySelector(".sbf-header-toggle input").click();true'|Out-Null
 # Verify the remaining database/export route and input shortcut guard.
 Eval (Click 'Fetch UniVec_Core')|Out-Null;WaitFor '!!document.querySelector(".sbf-database-summary")'
 Eval (Click 'Save as Excel')|Out-Null;Start-Sleep -Seconds 1
 if(!(Test-Path "$export\NCBI_UniVec_Core.xlsx")){throw 'Database Excel export missing'}
 Eval (Click 'Fetch UniVec')|Out-Null;WaitFor 'document.body.innerText.includes("from NCBI UniVec (")'
 Fill 'textarea' 'TTTTACGTACGTGGGG';Eval 'document.querySelector("textarea").focus();globalThis.beforeKeyboard=true;true'|Out-Null
 Send $script:socket 'Input.dispatchKeyEvent' @{type='keyDown';key='r';code='KeyR';modifiers=2;windowsVirtualKeyCode=82}|Out-Null
 Send $script:socket 'Input.dispatchKeyEvent' @{type='keyUp';key='r';code='KeyR';modifiers=2;windowsVirtualKeyCode=82}|Out-Null
 Start-Sleep -Milliseconds 500
 if(!(Eval 'globalThis.beforeKeyboard===true&&document.querySelector("textarea").value==="TTTTACGTACGTGGGG"')){throw 'Typing shortcut guard failed'}
 $record.checks=@('default-modeB','M13-exact-1-1200','no-save-on-two-runs','manual-XLSX-and-CSV','vector-and-host-controls','modeA-T7','lambda-reverse-complement','T4-threshold-86-vs-87','live-NCBI-Core','seven-day-cache-hit','three-live-self-matches-both-strands','6100-row-benchmark','worker-Stop-discards-partial','native-FASTA-load','multi-FASTA-paste-rejected','header-override','live-full-UniVec','database-Excel-export','CtrlR-ignored-while-typing','equal-input-panels','tab-mode-selector','persistent-results-placeholder','reserved-progress-no-layout-shift')
 $record.status='passed'
}catch{$record.error=$_.Exception.ToString();$record.errorLocation=$_.ScriptStackTrace}finally{
 if($recorder){New-Item -ItemType File "$frameDirectory\stop" -Force|Out-Null;if(!$recorder.WaitForExit(20000)){$recorder.Kill()}}
 if($app){& taskkill.exe /PID $app.Id /T /F|Out-Null}
 if($script:socket){$script:socket.Dispose()};if($script:mainSocket){$script:mainSocket.Dispose()}
 if(Test-Path "$frameDirectory\frames.txt"){
  $args='-hide_banner -loglevel warning -y -f concat -safe 0 -i "'+$frameDirectory+'\frames.txt" -vf scale=1280:900:flags=lanczos -r 12 -c:v libx264 -preset veryfast -crf 22 -pix_fmt yuv420p -movflags +faststart "'+$export+'\002_Sequence_Binding_Finder.mp4"'
  $encoder=Start-Process C:\DemoRunner\ffmpeg.exe -ArgumentList $args -WindowStyle Hidden -Wait -PassThru -RedirectStandardError "$export\encoder.log"
  if($encoder.ExitCode){$record.status='failed';$record.error='Encoding failed'}
  Copy-Item "$frameDirectory\timings.json" "$export\timings.json"
 }
 $record|ConvertTo-Json -Depth 20|Set-Content "$export\recording-result.json" -Encoding UTF8
 Stop-Transcript|Out-Null
}
