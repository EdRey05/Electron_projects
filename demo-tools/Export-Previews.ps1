$ErrorActionPreference='Stop'
$ffmpeg='C:\Tools\ffmpeg\ffmpeg-9.0.2-essentials_build\bin\ffmpeg.exe'
$ffprobe='C:\Tools\ffmpeg\ffmpeg-9.0.2-essentials_build\bin\ffprobe.exe'
foreach($id in @('001_FileSync','002_Sequence_Binding_Finder','003_Gene_Synthesis_Hub','004_Peak_Tracer','005_KM_Plotter')){
 $receipt="C:\DemoExport\$id-result.json"
 if(!(Test-Path $receipt)){continue}
 $record=Get-Content $receipt -Raw|ConvertFrom-Json
 if($record.status -ne 'passed'){continue}
 $video="C:\DemoExport\$id.mp4"
 $metadata=(& $ffprobe -v error -show_entries 'format=duration:stream=codec_name,width,height,nb_frames' -of json $video|Out-String|ConvertFrom-Json)
 if([double]$metadata.format.duration -lt 12){throw "Recording too short: $id"}
 $filter='setpts=0.5*PTS,fps=5,scale=720:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4'
 $args='-hide_banner -loglevel error -y -i "'+$video+'" -vf "'+$filter+'" -loop 0 "C:\DemoExport\'+$id+'.gif"'
 $p=Start-Process $ffmpeg -ArgumentList $args -WindowStyle Hidden -Wait -PassThru
 if($p.ExitCode){throw "GIF encoding failed: $id"}
 $args='-hide_banner -loglevel error -y -i "'+$video+'" -vf "fps=1/7,scale=400:-2,tile=4x1" -frames:v 1 -update 1 "C:\DemoExport\'+$id+'-filmstrip.png"'
 $p=Start-Process $ffmpeg -ArgumentList $args -WindowStyle Hidden -Wait -PassThru
 if($p.ExitCode){throw "Filmstrip failed: $id"}
 $metadata|ConvertTo-Json -Depth 8|Set-Content "C:\DemoExport\$id-media.json"
}
