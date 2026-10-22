param([switch]$Reuse,[string[]]$Apps)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
if($env:USERNAME -ne 'WDAGUtilityAccount'){throw 'Use the configured recording Sandbox.'}
New-Item -ItemType Directory C:\Apps,C:\Tools -Force|Out-Null
Start-Transcript C:\DemoExport\recording.log -Force
function Send($Socket,[string]$Method,$Parameters){
 $script:messageId++;$id=$script:messageId
 $bytes=[Text.Encoding]::UTF8.GetBytes((@{id=$id;method=$Method;params=$Parameters}|ConvertTo-Json -Depth 35 -Compress))
 $Socket.SendAsync([ArraySegment[byte]]::new($bytes),[Net.WebSockets.WebSocketMessageType]::Text,$true,[Threading.CancellationToken]::None).GetAwaiter().GetResult()|Out-Null
 $timeout=[Threading.CancellationTokenSource]::new(60000)
 try{do{$stream=[IO.MemoryStream]::new();do{$buffer=[byte[]]::new(65536);$r=$Socket.ReceiveAsync([ArraySegment[byte]]::new($buffer),$timeout.Token).GetAwaiter().GetResult();$stream.Write($buffer,0,$r.Count)}while(!$r.EndOfMessage);$reply=[Text.Encoding]::UTF8.GetString($stream.ToArray())|ConvertFrom-Json;$stream.Dispose()}while($reply.id -ne $id);if($reply.error){throw ($reply.error|ConvertTo-Json -Compress)};return $reply.result}finally{$timeout.Dispose()}
}
function Eval([string]$Expression,[switch]$Main){$s=$script:socket;if($Main){$s=$script:mainSocket};$r=Send $s 'Runtime.evaluate' @{expression=$Expression;awaitPromise=$true;returnByValue=$true};if($r.exceptionDetails){throw ($r.exceptionDetails|ConvertTo-Json -Depth 10 -Compress)};return $r.result.value}
function Observe([string]$Label){$dom=Eval '({text:document.body.innerText,inputs:[...document.querySelectorAll("input,textarea,select")].map(e=>({tag:e.tagName,type:e.type,placeholder:e.placeholder,value:e.value})),buttons:[...document.querySelectorAll("button")].map(e=>({text:e.innerText,title:e.title,disabled:e.disabled}))})';$safe=$Label -replace '[^A-Za-z0-9_-]','_';$dom|ConvertTo-Json -Depth 10|Set-Content "C:\DemoExport\$script:appId-$safe.json";return $dom}
function Step([string]$Label,[string]$Expression,[int]$Seconds=3){
 Write-Output "$script:appId $Label"
 Eval ('(()=>{let e=document.getElementById("demo-caption");if(!e){e=document.createElement("div");e.id="demo-caption";e.style="position:fixed;bottom:10px;right:16px;z-index:2147483647;background:#101828ee;color:white;padding:10px 18px;border-radius:8px;font:15px Arial;pointer-events:none";document.body.append(e)}e.textContent='+($Label|ConvertTo-Json -Compress)+';return true})()')|Out-Null
 if($Expression){Eval $Expression|Out-Null}
 Start-Sleep -Seconds $Seconds
 Observe $Label|Out-Null
}
function Click([string]$Text){$t=$Text|ConvertTo-Json -Compress;return "(()=>{const a=[...document.querySelectorAll('button')].filter(e=>e.innerText.trim()===$t);if(a.length!==1||a[0].disabled)throw Error('Button unavailable: '+$t);a[0].scrollIntoView({block:'center'});a[0].click();return true})()"}
function Fill([string]$Selector,[string]$Value){$a=$Selector|ConvertTo-Json -Compress;$b=$Value|ConvertTo-Json -Compress;return "(()=>{const e=document.querySelector($a);if(!e)throw Error('Input missing');e.scrollIntoView({block:'center'});const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,$b);e.dispatchEvent(new Event('input',{bubbles:true}));return true})()"}
function LoadFile([string]$Path){$d=Send $script:socket 'DOM.getDocument' @{};$n=Send $script:socket 'DOM.querySelector' @{nodeId=$d.root.nodeId;selector='input[type=file]'};if(!$n.nodeId){throw 'No file input'};Send $script:socket 'DOM.setFileInputFiles' @{nodeId=$n.nodeId;files=@($Path)}|Out-Null;Start-Sleep -Seconds 3}
function Queue([string[]]$Paths){Eval ('globalThis.demoOpenQueue='+ (ConvertTo-Json -InputObject @($Paths) -Compress)+';true') -Main|Out-Null}
$results=@()
try{
 [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
 $url='https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip'
 if(!$Reuse){Invoke-WebRequest $url -OutFile C:\Tools\ffmpeg.zip -UseBasicParsing}
 if((Get-FileHash C:\Tools\ffmpeg.zip).Hash -ne '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba'){throw 'FFmpeg checksum mismatch'}
 Add-Type -AssemblyName System.IO.Compression.FileSystem
 if(!$Reuse){[IO.Compression.ZipFile]::ExtractToDirectory('C:\Tools\ffmpeg.zip','C:\Tools\ffmpeg')}
 $ffmpeg=(Get-ChildItem C:\Tools\ffmpeg -Recurse -Filter ffmpeg.exe|Select-Object -First 1).FullName
 $ids=@('001_FileSync','002_Sequence_Binding_Finder','003_Gene_Synthesis_Hub','004_Peak_Tracer','005_KM_Plotter')
 $names=@('filesync-0.0.7','sequence-binding-finder-1.0.1','gene-synthesis-hub-2.0.1','peak-tracer-2.0.1','km-plotter-1.0.1')
 if(!$Reuse){for($i=0;$i -lt $ids.Count;$i++){[IO.Compression.ZipFile]::ExtractToDirectory("C:\Artifacts\$($names[$i])-win-x64-folder.zip","C:\Apps\$($ids[$i])")}}
 $python='C:\Apps\003_Gene_Synthesis_Hub\resources\python-app\runtime\python.exe'
 & $python C:\DemoRunner\make_fixtures.py
 if($LASTEXITCODE){throw 'Synthetic fixture generation failed'}
 if($Apps){$ids=@($Apps|ForEach-Object{$_ -split ','})}
 foreach($id in $ids){
  $script:appId=$id;$record=@{app=$id;status='failed';error=$null;synthetic=$true}
  $recorder=$null;$app=$null;$encoderLog=$null
  try{
   $exe=(Get-ChildItem "C:\Apps\$id" -Filter *.exe|Where-Object Name -ne 'elevate.exe'|Select-Object -First 1).FullName
   $app=Start-Process $exe -ArgumentList '--remote-debugging-port=9222','--inspect=9229' -PassThru
   $target=$null;for($n=0;$n -lt 60 -and !$target;$n++){Start-Sleep -Seconds 1;try{$targets=Invoke-RestMethod http://127.0.0.1:9222/json/list;$target=$targets|Where-Object type -eq 'page'|Select-Object -First 1}catch{}}
   if(!$target){throw 'Renderer did not start'}
   $script:socket=[Net.WebSockets.ClientWebSocket]::new();$script:socket.ConnectAsync([Uri]$target.webSocketDebuggerUrl,[Threading.CancellationToken]::None).GetAwaiter().GetResult();$script:messageId=0
   $mainTargets=Invoke-RestMethod http://127.0.0.1:9229/json/list;$main=$mainTargets|Select-Object -First 1
   $script:mainSocket=[Net.WebSockets.ClientWebSocket]::new();$script:mainSocket.ConnectAsync([Uri]$main.webSocketDebuggerUrl,[Threading.CancellationToken]::None).GetAwaiter().GetResult()
   Eval "globalThis.demoOpenQueue=[];globalThis.demoElectron=process.mainModule.require('electron');demoElectron.dialog.showOpenDialog=async()=>({canceled:false,filePaths:[demoOpenQueue.shift()||'C:\\DemoData\\exports']});demoElectron.dialog.showSaveDialog=async(o)=>({canceled:false,filePath:'C:\\DemoData\\exports\\'+process.mainModule.require('path').basename(o.defaultPath||'demo-output.xlsx')});true" -Main|Out-Null
   Eval 'demoElectron.BrowserWindow.getAllWindows()[0].setBounds({x:0,y:0,width:1450,height:950});true' -Main|Out-Null
   Start-Sleep -Seconds 3
   Send $script:socket 'Emulation.setDeviceMetricsOverride' @{width=1280;height=800;deviceScaleFactor=1;mobile=$false}|Out-Null
   $frameDirectory="C:\Frames\$id-"+(Get-Date -Format 'HHmmss')
   $video="C:\DemoExport\$id.mp4"
   $recorder=Start-Process powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File C:\DemoRunner\Capture-Frames.ps1 -Directory '+$frameDirectory) -WindowStyle Hidden -PassThru
   Start-Sleep -Seconds 1
   Step 'Synthetic data demo' '' 3
   . C:\DemoRunner\Workflows.ps1 -DemoApp $id
   $poster=Send $script:socket 'Page.captureScreenshot' @{format='png'};[IO.File]::WriteAllBytes("C:\DemoExport\$id.png",[Convert]::FromBase64String($poster.data))
   Step 'Completed using local synthetic inputs' '' 3
   $record.status='passed';$record.video="$id.mp4"
  }catch{$record.error=$_.ToString();Write-Output "DEMO FAILED: $_"}finally{
   if($recorder){
    New-Item -ItemType File -Path (Join-Path $frameDirectory 'stop') -Force|Out-Null
    if(!$recorder.WaitForExit(20000)){$recorder.Kill();$record.status='failed';$record.error='Capture worker did not stop'}
    if(Test-Path (Join-Path $frameDirectory 'frames.txt')){
     $arguments='-hide_banner -loglevel warning -y -f concat -safe 0 -i "'+$frameDirectory+'\frames.txt" -r 12 -c:v libx264 -preset veryfast -crf 24 -pix_fmt yuv420p -movflags +faststart "'+$video+'"'
     $encoder=Start-Process $ffmpeg -ArgumentList $arguments -WindowStyle Hidden -RedirectStandardError "C:\DemoExport\$id-encoder.log" -Wait -PassThru
     if($encoder.ExitCode -ne 0){$record.status='failed';$record.error='Video encoding failed'}
     Copy-Item (Join-Path $frameDirectory 'timings.json') "C:\DemoExport\$id-timings.json" -Force
    }else{$record.status='failed';$record.error='No captured frame sequence'}
   }
   if($app){& taskkill.exe /PID $app.Id /T /F|Out-Null}
   if($script:socket){$script:socket.Dispose()};if($script:mainSocket){$script:mainSocket.Dispose()}
   if(Test-Path $video){$record.sha256=(Get-FileHash $video).Hash}
   $record|ConvertTo-Json -Depth 12|Set-Content "C:\DemoExport\$id-result.json"
   $results+=$record;$results|ConvertTo-Json -Depth 12|Set-Content C:\DemoExport\results.json
   Start-Sleep -Seconds 3
  }
 }
 # Export the fixture data and real generated outputs for review, excluding runtimes.
 if(Test-Path C:\DemoExport\synthetic-data-and-outputs.zip){Remove-Item -LiteralPath C:\DemoExport\synthetic-data-and-outputs.zip}
 [IO.Compression.ZipFile]::CreateFromDirectory('C:\DemoData','C:\DemoExport\synthetic-data-and-outputs.zip')
}catch{$_|Out-String|Set-Content C:\DemoExport\fatal-error.txt}finally{Stop-Transcript}
