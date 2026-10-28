# Presentation edit only: slow the short real Analyze segment, with a visible label.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Recording,[Parameter(Mandatory=$true)][string]$Output)
$ErrorActionPreference='Stop'
$receipt=Get-Content (Join-Path $Recording 'recording-result.json') -Raw|ConvertFrom-Json
if($receipt.status -ne 'passed'){throw 'Use a successful actual-app recording.'}
$evidence=Get-Content (Join-Path $Recording 'transfer-evidence.json') -Raw|ConvertFrom-Json
$timings=Get-Content (Join-Path $Recording 'timings.json') -Raw|ConvertFrom-Json
$clock=Get-Content (Join-Path $Recording 'frame-clock.json') -Raw|ConvertFrom-Json
$byName=@{};foreach($frame in $clock){$byName[$frame.file]=$frame.createdAt}
$offsets=@(foreach($frame in $timings){if($byName.ContainsKey($frame.file)){$byName[$frame.file]-1000*$frame.seconds}})
$captureEpoch=($offsets|Measure-Object -Minimum).Minimum
$phase=@($evidence.phases|Where-Object phase -eq 'analyze')[0]
$finish=@($evidence.phases|Where-Object{$_.at -gt $phase.at -and $_.phase -ne 'analyze'})[0]
$start=[math]::Max([double]0,($phase.at-$captureEpoch)/1000-0.2)
$end=($finish.at-$captureEpoch)/1000+0.2
$factor=6
$f=[Globalization.CultureInfo]::InvariantCulture
$a=$start.ToString('F4',$f);$b=$end.ToString('F4',$f)
$font=$env:WINDIR.Replace('\','/')+'/Fonts/arial.ttf'
$font=$font.Replace(':','\:')
$filter="[0:v]split=3[pre][scan][post];[pre]trim=end=$a,setpts=PTS-STARTPTS[p];[scan]trim=start=${a}:end=$b,setpts=$factor*(PTS-STARTPTS),drawtext=fontfile='$font':text='Analyze - 1/6 speed':fontsize=20:fontcolor=white:box=1:boxcolor=0x102d42DD:boxborderw=10:x=20:y=h-th-25[s];[post]trim=start=$b,setpts=PTS-STARTPTS[q];[p][s][q]concat=n=3:v=1:a=0,fps=12[out]"
& ffmpeg.exe -hide_banner -loglevel error -y -i (Join-Path $Recording '001_FileSync.mp4') -filter_complex $filter -map '[out]' -c:v libx264 -preset veryfast -crf 22 -pix_fmt yuv420p -movflags +faststart $Output
if($LASTEXITCODE){throw 'Presentation encoding failed'}
@{rawSecondsStart=$start;rawSecondsEnd=$end;analyzeActualSeconds=($finish.at-$phase.at)/1000;analyzePlaybackFactor=$factor;label='Analyze - 1/6 speed';otherSegments='Real time; no cuts';captureEpochEstimate=$captureEpoch;method='Minimum frame-creation timestamp minus measured capture-request time; includes 200ms boundary margins';rawSha256=(Get-FileHash (Join-Path $Recording '001_FileSync.mp4')).Hash;editedSha256=(Get-FileHash $Output).Hash}|ConvertTo-Json|Set-Content ($Output+'.edit.json')
