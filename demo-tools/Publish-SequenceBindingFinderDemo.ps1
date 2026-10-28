[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Output,[switch]$UsePreparedMedia)
$ErrorActionPreference='Stop'
$Output=(Resolve-Path $Output).Path
$id='002_Sequence_Binding_Finder';$root=Split-Path $PSScriptRoot -Parent
$record=Get-Content (Join-Path $Output 'recording-result.json') -Raw|ConvertFrom-Json
if($record.status -ne 'passed' -or $record.version -ne '1.2.0'){throw 'A passing v1.2.0 recording is required.'}
$supplement=Join-Path $Output 'supplemental-result.json'
if(Test-Path $supplement){
 $extra=Get-Content $supplement -Raw|ConvertFrom-Json
 if($extra.status -ne 'passed' -or !$extra.databaseExport -or !$extra.typingShortcut.preserved){throw 'Supplemental acceptance failed.'}
 $record.checks+=@('live-full-UniVec','database-Excel-export','CtrlR-ignored-while-typing')
}
$video=Join-Path $Output "$id.mp4"
$ffmpeg=(Get-Command ffmpeg.exe -ErrorAction Stop).Source;$ffprobe=(Get-Command ffprobe.exe -ErrorAction Stop).Source
$metadata=(& $ffprobe -v error -show_entries 'format=duration:stream=codec_name,width,height,nb_frames' -of json $video|Out-String|ConvertFrom-Json)
$stream=$metadata.streams|Where-Object codec_name -eq 'h264'|Select-Object -First 1
if(!$stream -or [double]$metadata.format.duration -lt 60){throw 'Recording is incomplete.'}
& $ffmpeg -hide_banner -loglevel error -i $video -f null -
if($LASTEXITCODE){throw 'MP4 decode validation failed.'}
$filter='setpts=0.5*PTS,fps=5,scale=720:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4'
if(!$UsePreparedMedia){
& $ffmpeg -hide_banner -loglevel error -y -i $video -vf $filter -loop 0 (Join-Path $Output "$id.gif")
if($LASTEXITCODE){throw 'GIF encoding failed.'}
& $ffmpeg -hide_banner -loglevel error -y -i $video -vf 'fps=1/15,scale=320:-2,tile=3x2' -frames:v 1 -update 1 (Join-Path $Output 'contact-sheet.png')
if($LASTEXITCODE){throw 'Contact sheet failed.'}
}
foreach($extension in @('mp4','gif','png')){[IO.File]::Copy((Join-Path $Output "$id.$extension"),(Join-Path $root "Images_GIFs_Videos\$id.$extension"),$true)}
$manifestPath=Join-Path $root 'demo-data\demo-results.json';$manifest=Get-Content $manifestPath -Raw|ConvertFrom-Json
$entry=[ordered]@{app=$id;version='1.2.0';frames=[int]$stream.nb_frames;height=[int]$stream.height;width=[int]$stream.width;durationSeconds=[double]$metadata.format.duration;synthetic=$false;data='Accession-linked references; deterministic mutated queries; random negative control';status='passed';codec='h264';video="Images_GIFs_Videos/$id.mp4";preview="Images_GIFs_Videos/$id.gif";poster="Images_GIFs_Videos/$id.png";sha256=(Get-FileHash $video).Hash;artifactSha256=$record.artifactSha256;recordedAt=(Get-Date).ToString('o');checks=$record.checks;performance=$record.performance;liveCoreEntries=$record.liveCoreEntries}
$manifest.results=@($manifest.results|ForEach-Object{if($_.app -eq $id){$entry}else{$_}})
[IO.File]::WriteAllText($manifestPath,($manifest|ConvertTo-Json -Depth 25)+"`n",[Text.UTF8Encoding]::new($false))
if(!$UsePreparedMedia){$entry|ConvertTo-Json -Depth 20|Set-Content (Join-Path $Output 'media-manifest.json') -Encoding UTF8}
Write-Output "Validated media and generated 002 manifest entry from $Output"
