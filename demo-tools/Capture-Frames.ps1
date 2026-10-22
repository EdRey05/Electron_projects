param([string]$Directory)
$ErrorActionPreference='Stop'
New-Item -ItemType Directory -Path $Directory -Force|Out-Null
$targets=Invoke-RestMethod http://127.0.0.1:9222/json/list
$target=$targets|Where-Object type -eq 'page'|Select-Object -First 1
$socket=[Net.WebSockets.ClientWebSocket]::new()
$socket.ConnectAsync([Uri]$target.webSocketDebuggerUrl,[Threading.CancellationToken]::None).GetAwaiter().GetResult()|Out-Null
$clock=[Diagnostics.Stopwatch]::StartNew();$frames=@();$id=0
try{
 while(!(Test-Path (Join-Path $Directory 'stop'))){
  $id++;$at=$clock.Elapsed.TotalSeconds
  $request=@{id=$id;method='Page.captureScreenshot';params=@{format='jpeg';quality=78;captureBeyondViewport=$false}}|ConvertTo-Json -Compress
  $bytes=[Text.Encoding]::UTF8.GetBytes($request)
  $socket.SendAsync([ArraySegment[byte]]::new($bytes),[Net.WebSockets.WebSocketMessageType]::Text,$true,[Threading.CancellationToken]::None).GetAwaiter().GetResult()|Out-Null
  do{
   $stream=[IO.MemoryStream]::new()
   do{$b=[byte[]]::new(65536);$r=$socket.ReceiveAsync([ArraySegment[byte]]::new($b),[Threading.CancellationToken]::None).GetAwaiter().GetResult();$stream.Write($b,0,$r.Count)}while(!$r.EndOfMessage)
   $reply=[Text.Encoding]::UTF8.GetString($stream.ToArray())|ConvertFrom-Json;$stream.Dispose()
  }while($reply.id -ne $id)
  if(!$reply.result.data){throw 'Renderer frame capture failed'}
  $file=('{0:D6}.jpg' -f $id);[IO.File]::WriteAllBytes((Join-Path $Directory $file),[Convert]::FromBase64String($reply.result.data))
  $frames+=@{file=$file;seconds=$at};Start-Sleep -Milliseconds 200
 }
 $frames|ConvertTo-Json|Set-Content (Join-Path $Directory 'timings.json')
 $lines=@()
 for($i=0;$i -lt $frames.Count;$i++){
  $duration=0.3;if($i+1 -lt $frames.Count){$duration=$frames[$i+1].seconds-$frames[$i].seconds}
  $lines+="file '$($frames[$i].file)'";$lines+='duration '+$duration.ToString('F4',[Globalization.CultureInfo]::InvariantCulture)
 }
 $lines+="file '$($frames[-1].file)'";$lines|Set-Content (Join-Path $Directory 'frames.txt')
}finally{$socket.Dispose()}
