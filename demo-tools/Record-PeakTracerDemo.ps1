[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$Artifact,
 [Parameter(Mandatory=$true)][string]$Output,
 [string]$Samples='C:\Users\eduar\Desktop\ERA_BioAutomations\Gene_Synthesis_Agent\Tasks\Complete\Task_0010_Peak_tracer\shared_resources\samples\sample5\2-P1905972_2026-09-01',
 [switch]$PrepareOnly
)
$ErrorActionPreference='Stop'
$Artifact=(Resolve-Path -LiteralPath $Artifact).Path
$Samples=(Resolve-Path -LiteralPath $Samples).Path
$Output=[IO.Path]::GetFullPath($Output)
if(Test-Path -LiteralPath $Output){throw 'Choose a new recording output directory.'}
if([IO.Path]::GetExtension($Artifact) -ne '.zip'){throw 'Use a portable folder ZIP.'}
$reads=@(Get-ChildItem -LiteralPath $Samples -File -Filter *.ab1)
if(!$reads.Count){throw 'Choose a plate folder containing AB1 files, not its parent.'}
$runner=Join-Path $Output 'runner';$inputDirectory=Join-Path $Output 'input';$export=Join-Path $Output 'output'
New-Item -ItemType Directory -Path $runner,$inputDirectory,$export -Force|Out-Null
foreach($file in @('Record-PeakTracer.ps1','Capture-Frames.ps1')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $runner}
Copy-Item -LiteralPath $Artifact -Destination (Join-Path $inputDirectory 'PeakTracer.zip')
$ffmpeg=(Get-Command ffmpeg.exe -ErrorAction Stop).Source
Copy-Item -LiteralPath $ffmpeg -Destination (Join-Path $runner 'ffmpeg.exe')
@{artifactSha256=(Get-FileHash -LiteralPath $Artifact).Hash;artifactName=[IO.Path]::GetFileName($Artifact);samples=$Samples;plate=[IO.Path]::GetFileName($Samples);reads=$reads.Count;ffmpegSha256=(Get-FileHash $ffmpeg).Hash;createdAt=(Get-Date).ToString('o')}|ConvertTo-Json|Set-Content (Join-Path $runner 'recording-recipe.json') -Encoding UTF8
Get-ChildItem -LiteralPath $Samples -File | ForEach-Object {@{name=$_.Name;sha256=(Get-FileHash -LiteralPath $_.FullName).Hash}}|ConvertTo-Json|Set-Content (Join-Path $runner 'input-manifest.json') -Encoding UTF8
function Xml([string]$s){[Security.SecurityElement]::Escape($s)}
@"
<Configuration><MemoryInMB>8192</MemoryInMB><Networking>Disable</Networking><ClipboardRedirection>Disable</ClipboardRedirection><AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput>
<MappedFolders>
<MappedFolder><HostFolder>$(Xml $inputDirectory)</HostFolder><SandboxFolder>C:\DemoInput</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
<MappedFolder><HostFolder>$(Xml $Samples)</HostFolder><SandboxFolder>C:\Sample5Plate2</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
<MappedFolder><HostFolder>$(Xml $runner)</HostFolder><SandboxFolder>C:\DemoRunner</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
<MappedFolder><HostFolder>$(Xml $export)</HostFolder><SandboxFolder>C:\DemoExport</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
</MappedFolders><LogonCommand><Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\DemoRunner\Record-PeakTracer.ps1</Command></LogonCommand></Configuration>
"@|Set-Content (Join-Path $Output 'record.wsb') -Encoding UTF8
if(!$PrepareOnly){
 if(@((& wsb.exe list --raw|Out-String|ConvertFrom-Json).WindowsSandboxEnvironments).Count){throw 'Close existing Sandboxes before recording.'}
 Start-Process "$env:WINDIR\System32\WindowsSandbox.exe" -ArgumentList ('"'+(Join-Path $Output 'record.wsb')+'"') -WindowStyle Hidden
}
Write-Output "Recording run: $Output"
