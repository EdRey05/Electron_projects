[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$RecordingOutput,[string]$Repository='')
$ErrorActionPreference='Stop'
if(!$Repository){$Repository=Split-Path $PSScriptRoot -Parent}
$RecordingOutput=(Resolve-Path -LiteralPath $RecordingOutput).Path
$Repository=(Resolve-Path -LiteralPath $Repository).Path
$receipt=Get-Content (Join-Path $RecordingOutput 'recording-result.json') -Raw|ConvertFrom-Json
if($receipt.status -ne 'passed' -or $receipt.version -ne '2.0.2' -or $receipt.reads -ne 68 -or !$receipt.sourcePreserved){throw 'Use a passing plate-2 recording receipt for this version.'}
$ffmpeg=(Get-Command ffmpeg.exe -ErrorAction Stop).Source
$ffprobe=(Get-Command ffprobe.exe -ErrorAction Stop).Source
$video=Join-Path $RecordingOutput '004_Peak_Tracer.mp4'
$info=(& $ffprobe -v error -show_entries 'format=duration:stream=codec_name,width,height' -of json $video|Out-String|ConvertFrom-Json)
if($LASTEXITCODE -ne 0 -or [double]$info.format.duration -lt 25){throw 'Invalid or incomplete recording.'}
$gif=Join-Path $RecordingOutput '004_Peak_Tracer.gif'
$filter='setpts=0.5*PTS,fps=5,scale=720:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4'
$arguments='-hide_banner -loglevel error -y -i "'+$video+'" -vf "'+$filter+'" -loop 0 "'+$gif+'"'
$encoder=Start-Process $ffmpeg -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
if($encoder.ExitCode){throw 'GIF encoding failed'}
$filmstrip=Join-Path $RecordingOutput 'review-filmstrip.png'
$filter='fps=1/'+([double]$info.format.duration/5).ToString('F3',[Globalization.CultureInfo]::InvariantCulture)+',scale=384:-2,tile=5x1'
$arguments='-hide_banner -loglevel error -y -i "'+$video+'" -vf "'+$filter+'" -frames:v 1 -update 1 "'+$filmstrip+'"'
$encoder=Start-Process $ffmpeg -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
if($encoder.ExitCode){throw 'Review filmstrip failed'}
foreach($extension in @('mp4','gif','png')){Copy-Item -LiteralPath (Join-Path $RecordingOutput "004_Peak_Tracer.$extension") -Destination (Join-Path $Repository "Images_GIFs_Videos\004_Peak_Tracer.$extension") -Force}
$info|ConvertTo-Json -Depth 10|Set-Content (Join-Path $RecordingOutput 'media.json') -Encoding UTF8
Write-Output "Published recording assets from $RecordingOutput"
