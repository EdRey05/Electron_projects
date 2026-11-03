param()
$ErrorActionPreference='Stop'
if($env:USERNAME -ne 'WDAGUtilityAccount'){throw 'Use the configured recording Sandbox.'}
$export='C:\DemoExport';$frames='C:\DemoFrames';$app=$null;$recorder=$null
$record=@{app='004_Peak_Tracer';status='failed';synthetic=$false;error=$null;checks=@()}
Start-Transcript "$export\recording.log" -Force|Out-Null
function Send($Socket,[string]$Method,$Parameters){
 $script:messageId++;$id=$script:messageId
 $bytes=[Text.Encoding]::UTF8.GetBytes((@{id=$id;method=$Method;params=$Parameters}|ConvertTo-Json -Depth 30 -Compress))
 $Socket.SendAsync([ArraySegment[byte]]::new($bytes),[Net.WebSockets.WebSocketMessageType]::Text,$true,[Threading.CancellationToken]::None).GetAwaiter().GetResult()|Out-Null
 $timeout=[Threading.CancellationTokenSource]::new(30000)
 try{do{$stream=[IO.MemoryStream]::new();do{$buffer=[byte[]]::new(65536);$r=$Socket.ReceiveAsync([ArraySegment[byte]]::new($buffer),$timeout.Token).GetAwaiter().GetResult();$stream.Write($buffer,0,$r.Count)}while(!$r.EndOfMessage);$reply=[Text.Encoding]::UTF8.GetString($stream.ToArray())|ConvertFrom-Json;$stream.Dispose()}while($reply.id -ne $id);if($reply.error){throw ($reply.error|ConvertTo-Json -Compress)};return $reply.result}finally{$timeout.Dispose()}
}
function Eval([string]$Expression,[switch]$Main){
 $s=$script:socket
 if($Main){$s=[Net.WebSockets.ClientWebSocket]::new();$s.ConnectAsync([Uri]$script:mainUrl,[Threading.CancellationToken]::None).GetAwaiter().GetResult()|Out-Null}
 try{$r=Send $s 'Runtime.evaluate' @{expression=$Expression;awaitPromise=$true;returnByValue=$true};if($r.exceptionDetails){throw ($r.exceptionDetails|ConvertTo-Json -Depth 8 -Compress)};return $r.result.value}finally{if($Main){$s.Dispose()}}
}
function Step([string]$Label,[string]$Expression='',[int]$Seconds=3){
 Write-Output $Label
 Eval ('(()=>{let e=document.getElementById("demo-caption");if(!e){e=document.createElement("div");e.id="demo-caption";e.style="position:fixed;bottom:12px;right:16px;z-index:2147483647;background:#29282bf2;color:white;padding:10px 18px;border-radius:8px;font:16px Arial;pointer-events:none";document.body.append(e)}e.textContent='+($Label|ConvertTo-Json -Compress)+';return true})()')|Out-Null
 if($Expression){Eval $Expression|Out-Null}
 Start-Sleep -Seconds $Seconds
 Eval '({text:document.body.innerText})'|ConvertTo-Json|Set-Content (Join-Path $export (($Label -replace '[^A-Za-z0-9_-]','_')+'.json')) -Encoding UTF8
}
function WaitFor([string]$Expression,[int]$Seconds=90){$until=(Get-Date).AddSeconds($Seconds);do{if(Eval $Expression){return};Start-Sleep -Milliseconds 300}while((Get-Date) -lt $until);throw "Timed out: $Expression"}
try{
 $recipe=Get-Content C:\DemoRunner\recording-recipe.json -Raw|ConvertFrom-Json
 if((Get-FileHash C:\DemoInput\PeakTracer.zip).Hash -ne $recipe.artifactSha256){throw 'Artifact hash mismatch'}
 if((Get-FileHash C:\DemoRunner\ffmpeg.exe).Hash -ne $recipe.ffmpegSha256){throw 'Encoder hash mismatch'}
 $record.artifactSha256=$recipe.artifactSha256;$record.plate=$recipe.plate;$record.reads=$recipe.reads
 $record.hostTools=@{nodeAvailable=[bool](Get-Command node.exe -ErrorAction SilentlyContinue);pythonAvailable=[bool](Get-Command python.exe -ErrorAction SilentlyContinue)}
 Add-Type -AssemblyName System.IO.Compression.FileSystem
 [IO.Compression.ZipFile]::ExtractToDirectory('C:\DemoInput\PeakTracer.zip','C:\DemoApp')
 $inputFolder=Join-Path ([Environment]::GetFolderPath('Desktop')) ('PeakTracer_demo\sample5\'+$recipe.plate)
 $output=Join-Path ([Environment]::GetFolderPath('Desktop')) 'PeakTracer_results'
 New-Item -ItemType Directory -Path $inputFolder,$output -Force|Out-Null
 Copy-Item -Path C:\Sample5Plate2\* -Destination $inputFolder
 $manifest=Get-Content C:\DemoRunner\input-manifest.json -Raw|ConvertFrom-Json
 foreach($item in $manifest){if((Get-FileHash -LiteralPath (Join-Path $inputFolder $item.name)).Hash -ne $item.sha256){throw 'Input staging hash mismatch'}}
 $app=Start-Process 'C:\DemoApp\Peak Tracer.exe' -ArgumentList '--remote-debugging-port=9222','--remote-debugging-address=127.0.0.1','--inspect=9229' -WindowStyle Hidden -PassThru -RedirectStandardError "$export\app-stderr.log" -RedirectStandardOutput "$export\app-stdout.log"
 $target=$null
 for($n=0;$n -lt 60 -and !$target;$n++){Start-Sleep -Seconds 1;try{$targets=Invoke-RestMethod http://127.0.0.1:9222/json/list -TimeoutSec 3;$target=$targets|Where-Object type -eq 'page'|Select-Object -First 1}catch{}}
 if(!$target){throw 'Renderer did not start'}
 $script:messageId=0;$script:socket=[Net.WebSockets.ClientWebSocket]::new();$script:socket.ConnectAsync([Uri]$target.webSocketDebuggerUrl,[Threading.CancellationToken]::None).GetAwaiter().GetResult()
 $mainTargets=Invoke-RestMethod http://127.0.0.1:9229/json/list
 $script:mainUrl=($mainTargets|Select-Object -First 1).webSocketDebuggerUrl
 $paths=ConvertTo-Json -InputObject @($inputFolder,$output) -Compress
 $record.version=Eval ("globalThis.demoElectron=process.mainModule.require('electron');globalThis.demoOpenQueue="+$paths+";demoElectron.dialog.showOpenDialog=async()=>({canceled:false,filePaths:[demoOpenQueue.shift()]});demoElectron.BrowserWindow.getAllWindows()[0].setBounds({x:0,y:0,width:1320,height:960});demoElectron.app.getVersion()") -Main
 if($record.version -ne '2.0.2'){throw 'Unexpected application version'}
 Send $script:socket 'Emulation.setDeviceMetricsOverride' @{width=1280;height=900;deviceScaleFactor=1;mobile=$false}|Out-Null
 WaitFor '!!window.api&&document.querySelectorAll("button").length>3'
 Eval 'globalThis.demoEvents=[];globalThis.demoDone=null;window.api.onProgress(m=>demoEvents.push(m));window.api.onDone(m=>demoDone=m);true'|Out-Null
 $recorder=Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File C:\DemoRunner\Capture-Frames.ps1 -Directory $frames -IntervalMs 140" -WindowStyle Hidden -PassThru
 Start-Sleep -Seconds 2
 Step 'Peak Tracer 2.0.2 - Sample 5, plate 2' '' 3
 Step 'Choose the plate folder - 68 paired reads' '(()=>{const b=[...document.querySelectorAll("button")].filter(e=>e.innerText.trim()==="Pick");if(b.length!==2)throw Error("Missing folder pickers");b[0].click();return true})()' 4
 WaitFor 'document.body.innerText.includes("68 files")'
 Step 'Choose a separate Desktop output folder' '(()=>{[...document.querySelectorAll("button")].filter(e=>e.innerText.trim()==="Pick")[1].click();return true})()' 3
 # Leave the clean profile default selected; do not change parameters or mode.
 if(!(Eval '(()=>{const b=[...document.querySelectorAll("button")].find(e=>e.innerText.includes("Preprocessing + PT"));return b&&!!b.querySelector("svg")})()')){throw 'Default preprocessing mode not selected'}
 Step 'Keep Preprocessing + PT and the default parameters' '' 3
 $clock=[Diagnostics.Stopwatch]::StartNew()
 Step 'Run the full batch with the bundled processor' '(()=>{const b=[...document.querySelectorAll("button")].find(e=>e.innerText.trim()==="Run Peak Tracer");if(!b||b.disabled)throw Error("Run unavailable");b.click();return true})()' 2
 # Genuine processing duration is retained. No artificial delays or fabricated results.
 WaitFor 'globalThis.demoDone!==null' 1800
 $clock.Stop();$record.batchSeconds=[Math]::Round($clock.Elapsed.TotalSeconds,2)
 $record.done=Eval 'demoDone';$record.events=Eval 'demoEvents'
 if($record.done.code -ne 0){throw 'Batch failed; inspect recorded events'}
 $done=@($record.events|Where-Object type -eq 'file_done')
 if($done.Count -ne $recipe.reads){throw "Expected $($recipe.reads) successful read events; got $($done.Count)"}
 if(@($record.events|Where-Object type -in @('file_error','file_skip')).Count){throw 'Read failed or was skipped'}
 $runManifest=Get-Content (Join-Path $output 'run_manifest.json') -Raw|ConvertFrom-Json
 if(!$runManifest.parameters.preprocess -or @($runManifest.files).Count -ne $recipe.reads){throw 'Wrong workflow or manifest count'}
 if(@(Get-ChildItem -LiteralPath $output -Filter *.ab1).Count -ne $recipe.reads -or @(Get-ChildItem -LiteralPath $output -Filter *.seq).Count -ne $recipe.reads){throw 'Incomplete processed AB1/SEQ outputs'}
 foreach($item in $manifest){if((Get-FileHash -LiteralPath (Join-Path $inputFolder $item.name)).Hash -ne $item.sha256){throw 'An input changed'}}
 $record.sourcePreserved=$true
 Step 'Batch complete - inspect per-read QC' '' 5
 $poster=Send $script:socket 'Page.captureScreenshot' @{format='png'}
 [IO.File]::WriteAllBytes("$export\004_Peak_Tracer.png",[Convert]::FromBase64String($poster.data))
 foreach($fraction in @(0.25,0.5,0.75,1.0)){
  Step 'Scroll through the processed reads' ("(()=>{const e=[...document.querySelectorAll('div.overflow-y-auto')].find(e=>e.scrollHeight>e.clientHeight+10);if(!e)throw Error('Scrollable results missing');e.scrollTo({top:(e.scrollHeight-e.clientHeight)*"+$fraction.ToString([Globalization.CultureInfo]::InvariantCulture)+",behavior:'smooth'});return true})()") 3
 }
 Step '68 reads processed - raw inputs preserved' '' 4
 Copy-Item -LiteralPath $output -Destination (Join-Path $export 'results') -Recurse
 $record.checks=@('offline-clean-guest','bundled-python','Sample5-plate2-only','default-preprocessing-plus-PT','68-file-done-events','68-processed-AB1','68-SEQ','preprocess-manifest','all-input-SHA256-unchanged','results-scroll')
 $record.status='passed'
}catch{$record.error=$_.Exception.ToString();$record.errorLocation=$_.ScriptStackTrace}finally{
 if($recorder){New-Item -ItemType File "$frames\stop" -Force|Out-Null;if(!$recorder.WaitForExit(20000)){$recorder.Kill();$record.status='failed';$record.error='Capture did not stop'}}
 if($app){& taskkill.exe /PID $app.Id /T /F|Out-Null}
 if($script:socket){$script:socket.Dispose()}
 if(Test-Path "$frames\frames.txt"){
  $arguments='-hide_banner -loglevel warning -y -f concat -safe 0 -i "'+$frames+'\frames.txt" -vf scale=1280:900:flags=lanczos -r 12 -c:v libx264 -preset veryfast -crf 22 -pix_fmt yuv420p -movflags +faststart "'+$export+'\004_Peak_Tracer.mp4"'
  $encoder=Start-Process C:\DemoRunner\ffmpeg.exe -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru -RedirectStandardError "$export\encoder.log"
  if($encoder.ExitCode){$record.status='failed';$record.error='Video encoding failed'}
  Copy-Item "$frames\timings.json" "$export\timings.json"
 }
 $record|ConvertTo-Json -Depth 25|Set-Content "$export\recording-result.json" -Encoding UTF8
 Stop-Transcript|Out-Null
}
