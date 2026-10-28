# Run only in the offline recording Sandbox described in recording_guides/FileSync.md.
param()
$ErrorActionPreference='Stop'
if($env:USERNAME -ne 'WDAGUtilityAccount'){throw 'Recording requires the configured Windows Sandbox.'}
$export='C:\DemoExport'
New-Item -ItemType Directory -Path C:\DemoApp,$export -Force | Out-Null
Start-Transcript "$export\recording.log" -Force | Out-Null
$record=@{status='failed';version='1.0.0';synthetic=$true;capture='Actual packaged renderer; CDP controls; no mocked results';error=$null}
$app=$null;$recorder=$null
function Send($Socket,[string]$Method,$Parameters){
 $script:messageId++;$id=$script:messageId
 $bytes=[Text.Encoding]::UTF8.GetBytes((@{id=$id;method=$Method;params=$Parameters}|ConvertTo-Json -Depth 35 -Compress))
 $Socket.SendAsync([ArraySegment[byte]]::new($bytes),[Net.WebSockets.WebSocketMessageType]::Text,$true,[Threading.CancellationToken]::None).GetAwaiter().GetResult()|Out-Null
 $timeout=[Threading.CancellationTokenSource]::new(30000)
 try{do{$stream=[IO.MemoryStream]::new();do{$buffer=[byte[]]::new(65536);$r=$Socket.ReceiveAsync([ArraySegment[byte]]::new($buffer),$timeout.Token).GetAwaiter().GetResult();$stream.Write($buffer,0,$r.Count)}while(!$r.EndOfMessage);$reply=[Text.Encoding]::UTF8.GetString($stream.ToArray())|ConvertFrom-Json;$stream.Dispose()}while($reply.id -ne $id);if($reply.error){throw ($reply.error|ConvertTo-Json -Compress)};return $reply.result}finally{$timeout.Dispose()}
}
function Eval([string]$Expression,[switch]$Main){$s=$script:socket;if($Main){$s=$script:mainSocket};$r=Send $s 'Runtime.evaluate' @{expression=$Expression;awaitPromise=$true;returnByValue=$true};if($r.exceptionDetails){throw ($r.exceptionDetails|ConvertTo-Json -Depth 10 -Compress)};return $r.result.value}
function Observe([string]$Label){Eval '({text:document.body.innerText,cards:[...document.querySelectorAll("dl")].map(e=>({text:e.innerText,green:e.classList.contains("bg-emerald-100"),rect:e.getBoundingClientRect().toJSON()}))})' | ConvertTo-Json -Depth 12 | Set-Content "$export\$Label.json"}
function Step([string]$Label,[string]$Expression='',[int]$Seconds=3){
 Write-Output $Label
 Eval ('(()=>{let e=document.getElementById("demo-caption");if(!e){e=document.createElement("div");e.id="demo-caption";e.style="position:fixed;bottom:12px;right:16px;z-index:2147483647;background:#102d42ed;color:white;padding:10px 18px;border-radius:8px;font:16px Arial;pointer-events:none";document.body.append(e)}e.textContent='+($Label|ConvertTo-Json -Compress)+';return true})()')|Out-Null
 if($Expression){Eval $Expression|Out-Null};Start-Sleep -Seconds $Seconds;Observe ($Label -replace '[^A-Za-z0-9_-]','_')
}
function Click([string]$Text){$t=$Text|ConvertTo-Json -Compress;return "(()=>{const a=[...document.querySelectorAll('button')].filter(e=>e.innerText.trim()===$t);if(a.length!==1||a[0].disabled)throw Error('Button unavailable: '+$t);a[0].click();return true})()"}
function WaitFor([string]$Expression){$until=(Get-Date).AddSeconds(90);do{if(Eval $Expression){return};Start-Sleep -Milliseconds 250}while((Get-Date) -lt $until);throw "Timed out: $Expression"}
try {
 $recipe=Get-Content C:\DemoRunner\recording-recipe.json -Raw|ConvertFrom-Json
 if((Get-FileHash C:\DemoInput\filesync-1.0.0-win-x64-folder.zip).Hash -ne $recipe.sha256){throw 'Recording ZIP hash mismatch'}
 $record.artifactSha256=$recipe.sha256
 Add-Type -AssemblyName System.IO.Compression.FileSystem
 [IO.Compression.ZipFile]::ExtractToDirectory('C:\DemoInput\filesync-1.0.0-win-x64-folder.zip','C:\DemoApp')
 & C:\DemoRunner\New-FileSyncFixture.ps1
 [IO.Compression.ZipFile]::CreateFromDirectory('C:\DemoData\FileSync',"$export\001_FileSync-inputs.zip",[IO.Compression.CompressionLevel]::Optimal,$false)
 Copy-Item 'C:\DemoData\FileSync\Folder B' 'C:\DemoData\Before B' -Recurse
 $app=Start-Process C:\DemoApp\FileSync.exe -ArgumentList '--remote-debugging-port=9222','--remote-debugging-address=127.0.0.1','--inspect=9229' -WindowStyle Hidden -PassThru
 $target=$null;for($n=0;$n -lt 90 -and !$target;$n++){Start-Sleep -Seconds 1;try{$targets=Invoke-RestMethod http://127.0.0.1:9222/json/list -TimeoutSec 3;$target=$targets|Where-Object type -eq 'page'|Select-Object -First 1}catch{}}
 if(!$target){throw 'Packaged renderer did not start'}
 $script:messageId=0;$script:socket=[Net.WebSockets.ClientWebSocket]::new();$script:socket.ConnectAsync([Uri]$target.webSocketDebuggerUrl,[Threading.CancellationToken]::None).GetAwaiter().GetResult()
 $mainTargets=Invoke-RestMethod http://127.0.0.1:9229/json/list -TimeoutSec 3;$main=$mainTargets|Select-Object -First 1
 $script:mainSocket=[Net.WebSockets.ClientWebSocket]::new();$script:mainSocket.ConnectAsync([Uri]$main.webSocketDebuggerUrl,[Threading.CancellationToken]::None).GetAwaiter().GetResult()
 Eval "globalThis.demoElectron=process.mainModule.require('electron');demoElectron.BrowserWindow.getAllWindows()[0].setBounds({x:0,y:0,width:1320,height:960});demoElectron.app.getVersion()" -Main | Set-Content "$export\app-version.txt"
 if((Get-Content "$export\app-version.txt") -ne '1.0.0'){throw 'Incorrect packaged version'}
 Send $script:socket 'Emulation.setDeviceMetricsOverride' @{width=1280;height=900;deviceScaleFactor=1;mobile=$false}|Out-Null
 $frameDirectory='C:\DemoFrames'
 $recorder=Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File C:\DemoRunner\Capture-Frames.ps1 -Directory $frameDirectory -IntervalMs 75" -WindowStyle Hidden -PassThru
 Start-Sleep -Seconds 2
 Step 'FileSync 1.0.0 · local folder mirror' '' 3
 Step 'Choose Folder A and Folder B' '(()=>{const a=[...document.querySelectorAll("input")].filter(e=>e.type==="text");["C:\\DemoData\\FileSync\\Folder A","C:\\DemoData\\FileSync\\Folder B"].forEach((v,i)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(a[i],v);a[i].dispatchEvent(new Event("input",{bubbles:true}))});return true})()' 4
 Step 'Mirror A → B · keep removed files in trash' '' 3
 Eval 'globalThis.demoApply=[];globalThis.demoAnalysis=[];globalThis.demoPhases=[];globalThis.demoStopAnalysis=window.api.engine.onAnalyzeProgress(p=>demoAnalysis.push(p));globalThis.demoStopApply=window.api.engine.onApplyProgress(p=>demoApply.push(p));globalThis.demoPhaseObserver=new MutationObserver(()=>{const a=document.querySelector("[aria-label=\"Analyze progress\"]"),r=document.querySelector("[aria-label=\"File operation progress\"]");const phase=r?"run":a?(a.innerText.includes("Checking results")?"result-check":"analyze"):"idle";if(demoPhases.at(-1)?.phase!==phase)demoPhases.push({phase,at:Date.now(),text:(r||a)?.innerText||""})});demoPhaseObserver.observe(document.body,{subtree:true,childList:true,characterData:true});true'|Out-Null
 Step 'Analyze · counting files in nested folders' (Click 'Analyze') 1
 WaitFor '(()=>{const b=[...document.querySelectorAll("button")].find(e=>e.innerText.trim()==="Run");return !!b&&!b.disabled})()'
 Step '1,000 files each · 300 copies or updates · 200 removals' '' 5
 $before=Eval '({cards:[...document.querySelectorAll("dl")].map(e=>e.innerText),text:document.body.innerText})'
 if($before.cards.Count -ne 4 -or ($before.cards -join ' ') -notmatch '300 of' -or ($before.cards -join ' ') -notmatch '200 removals'){throw 'Unexpected analyzed plan'}
 $layout=Eval '(()=>{const r=[...document.querySelectorAll("dl")].map(e=>e.getBoundingClientRect());return r.length===4&&r.every(x=>Math.abs(x.top-r[0].top)<1)&&document.documentElement.scrollWidth<=1280})()'
 if(!$layout){throw 'Cards do not fit one row'}
 Step 'Browse the folder tree' '(()=>{document.querySelectorAll("button[title=Collapse]").forEach(b=>{if(b.parentElement.style.paddingLeft==="12px")b.click()});return true})()' 4
 Step 'Expand Fieldwork · new text files' '(()=>{const b=[...document.querySelectorAll("button[title=Expand]")].find(e=>e.innerText.includes("Fieldwork/"));if(!b)throw Error("Fieldwork folder missing");b.click();return true})()' 4
 Step 'Review a batch before copying' '(()=>{document.querySelectorAll("button[title=Collapse]").forEach(b=>{if(b.innerText.includes("Batch-"))b.click()});return true})()' 2
 Step 'Open Batch-01' '(()=>{const b=[...document.querySelectorAll("button[title=Expand]")].find(e=>e.innerText.includes("Batch-01/"));if(!b)throw Error("Batch missing");b.click();return true})()' 5
 Step '700 shared files remain unchanged' '(()=>{document.querySelectorAll("button[title=Collapse]").forEach(b=>{if(b.parentElement.style.paddingLeft==="12px")b.click()});const e=[...document.querySelectorAll("label")].find(e=>e.innerText.includes("Only changes"));e.querySelector("input").click();return true})()' 4
 Step 'Projects · reports and shared notes' '(()=>{const b=[...document.querySelectorAll("button[title=Expand]")].find(e=>e.innerText.includes("Projects/"));b.click();return true})()' 3
 Step 'Compare the planned changes' '(()=>{const e=[...document.querySelectorAll("label")].find(e=>e.innerText.includes("Only changes"));e.querySelector("input").click();document.querySelectorAll("button[title=Collapse]").forEach(b=>{if(b.parentElement.style.paddingLeft==="12px")b.click()});window.scrollTo({top:0,behavior:"smooth"});return true})()' 4
 Step 'Run · verified copies and safe removals' (Click 'Run') 1
 WaitFor '[...document.querySelectorAll("dl")].filter(e=>e.classList.contains("bg-emerald-100")).length===4'
 Step 'Checked ✓ · no remaining differences' 'window.scrollTo({top:0,behavior:"smooth"});true' 8
 New-Item -ItemType File -Path "$frameDirectory\stop" -Force|Out-Null
 if(!$recorder.WaitForExit(20000)){throw 'Capture did not stop after final scene'}
 Get-ChildItem $frameDirectory -Filter *.jpg | Sort-Object Name | ForEach-Object { @{file=$_.Name;createdAt=([DateTimeOffset]$_.CreationTimeUtc).ToUnixTimeMilliseconds()} } | ConvertTo-Json | Set-Content "$export\frame-clock.json"
 $progress=Eval 'demoStopApply();demoStopAnalysis();demoPhaseObserver.disconnect();({events:demoApply,analysisEvents:demoAnalysis,phases:demoPhases,text:document.body.innerText,cards:[...document.querySelectorAll("dl")].map(e=>e.innerText)})'
 $progress|ConvertTo-Json -Depth 20|Set-Content "$export\transfer-evidence.json"
 $a='C:\DemoData\FileSync\Folder A';$b='C:\DemoData\FileSync\Folder B';$old='C:\DemoData\Before B'
 $aFiles=@(Get-ChildItem $a -Recurse -File);$bFiles=@(Get-ChildItem $b -Recurse -File|Where-Object{$_.FullName -notlike "$b\.filesync-trash\*"})
 if($aFiles.Count -ne 1000 -or $bFiles.Count -ne 1000){throw 'Expected 1000 matching files per folder'}
 foreach($f in $aFiles){$relative=$f.FullName.Substring($a.Length+1);if((Get-FileHash $f.FullName).Hash -ne (Get-FileHash (Join-Path $b $relative)).Hash){throw "Mirrored payload mismatch: $relative"}}
 $trash=@(Get-ChildItem "$b\.filesync-trash" -Recurse -File)
 $trashHashes=@{};foreach($f in $trash){$trashHashes[(Get-FileHash $f.FullName).Hash]=$true}
 $recovery=@(Get-ChildItem "$old\Projects\Reports","$old\Archive" -Recurse -File)
 if($recovery.Count -ne 300){throw 'Expected 300 old versions/removals'}
 foreach($f in $recovery){if(!$trashHashes.ContainsKey((Get-FileHash $f.FullName).Hash)){throw "Missing recovery copy: $($f.Name)"}}
 $payload=($aFiles|Where-Object{$_.FullName -notlike "$a\Projects\Shared\*"}|Measure-Object Length -Sum).Sum
 foreach($event in $progress.events){if($event.bytesTotal -ne $payload){throw 'Incorrect Run byte denominator'}}
 $poster=Send $script:socket 'Page.captureScreenshot' @{format='png'};[IO.File]::WriteAllBytes("$export\001_FileSync.png",[Convert]::FromBase64String($poster.data))
 $record.phases=$progress.phases
 $record.checks=@('v1.0.0','four-cards-one-row','300-copies-200-removals','1000-destination-hashes-match','300-trash-recovery-hashes','nested-folder-tree','copy-only-byte-total','four-green-checkmarks-after-result-check')
 $record.status='passed'
} catch {$record.error=$_.ToString()} finally {
 if($recorder){New-Item -ItemType File -Path "$frameDirectory\stop" -Force|Out-Null;if(!$recorder.WaitForExit(20000)){$recorder.Kill();$record.status='failed';$record.error='Capture did not stop'}}
 if($app){& taskkill.exe /PID $app.Id /T /F|Out-Null}
 if($script:socket){$script:socket.Dispose()};if($script:mainSocket){$script:mainSocket.Dispose()}
 if(Test-Path "$frameDirectory\frames.txt"){
  $args='-hide_banner -loglevel warning -y -f concat -safe 0 -i "'+$frameDirectory+'\frames.txt" -vf scale=1280:900:flags=lanczos -r 12 -c:v libx264 -preset veryfast -crf 22 -pix_fmt yuv420p -movflags +faststart "'+$export+'\001_FileSync.mp4"'
  $encoder=Start-Process C:\DemoRunner\ffmpeg.exe -ArgumentList $args -WindowStyle Hidden -Wait -PassThru -RedirectStandardError "$export\encoder.log"
  if($encoder.ExitCode){$record.status='failed';$record.error='Encoding failed'}
  Copy-Item "$frameDirectory\timings.json" "$export\timings.json"
 }
 $record | ConvertTo-Json -Depth 10 | Set-Content "$export\recording-result.json"
 Stop-Transcript | Out-Null
}
