[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Artifact,[Parameter(Mandatory=$true)][string]$Output,[switch]$PrepareOnly)
$ErrorActionPreference='Stop'
$Artifact=(Resolve-Path $Artifact).Path;$Output=[IO.Path]::GetFullPath($Output)
if(Test-Path $Output){throw 'Choose a new output directory.'}
if([IO.Path]::GetFileName($Artifact) -ne 'sequence-binding-finder-1.2.0-win-x64-folder.zip'){throw 'Update the recording version before using another release.'}
$runner=Join-Path $Output 'runner';$inputDir=Join-Path $Output 'input';$export=Join-Path $Output 'output'
New-Item -ItemType Directory -Path $runner,$inputDir,$export -Force|Out-Null
foreach($file in @('Record-SequenceBindingFinder.ps1','Capture-Frames.ps1')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $runner}
$ffmpeg=(Get-Command ffmpeg.exe -ErrorAction Stop).Source
Copy-Item $ffmpeg (Join-Path $runner 'ffmpeg.exe');Copy-Item $Artifact $inputDir
$assets=Join-Path $PSScriptRoot '..\002_Sequence_Binding_Finder\test_assets'
foreach($file in @('corpus.json','reference_phage_database.xlsx','test_query_assemblies.xlsx')){Copy-Item (Join-Path $assets $file) $inputDir}
@{sha256=(Get-FileHash $Artifact).Hash;ffmpegSha256=(Get-FileHash $ffmpeg).Hash;createdAt=(Get-Date).ToString('o')}|ConvertTo-Json|Set-Content (Join-Path $runner 'recording-recipe.json') -Encoding UTF8
function Xml([string]$s){[Security.SecurityElement]::Escape($s)}
@"
<Configuration><MemoryInMB>8192</MemoryInMB><Networking>Enable</Networking><ClipboardRedirection>Disable</ClipboardRedirection><AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput>
<MappedFolders>
<MappedFolder><HostFolder>$(Xml $inputDir)</HostFolder><SandboxFolder>C:\DemoInput</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
<MappedFolder><HostFolder>$(Xml $runner)</HostFolder><SandboxFolder>C:\DemoRunner</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
<MappedFolder><HostFolder>$(Xml $export)</HostFolder><SandboxFolder>C:\DemoExport</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
</MappedFolders><LogonCommand><Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\DemoRunner\Record-SequenceBindingFinder.ps1</Command></LogonCommand></Configuration>
"@|Set-Content (Join-Path $Output 'record.wsb') -Encoding UTF8
if(!$PrepareOnly){
 if(@((& wsb.exe list --raw|Out-String|ConvertFrom-Json).WindowsSandboxEnvironments).Count){throw 'Close existing Sandboxes before recording.'}
 Start-Process "$env:WINDIR\System32\WindowsSandbox.exe" -ArgumentList ('"'+(Join-Path $Output 'record.wsb')+'"') -WindowStyle Hidden
}
Write-Output "Recording run: $Output"
