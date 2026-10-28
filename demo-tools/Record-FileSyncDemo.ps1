[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$Artifact,
 [Parameter(Mandatory=$true)][string]$Output,
 [switch]$PrepareOnly
)
$ErrorActionPreference='Stop'
$Artifact=(Resolve-Path -LiteralPath $Artifact).Path
$Output=[IO.Path]::GetFullPath($Output)
if(Test-Path $Output){throw 'Choose a new recording output directory.'}
if([IO.Path]::GetFileName($Artifact) -ne 'filesync-1.0.0-win-x64-folder.zip'){throw 'Update the recording version checks before using another release.'}
$ffmpeg=(Get-Command ffmpeg.exe -ErrorAction Stop).Source
$runner=Join-Path $Output 'runner';$inputDir=Join-Path $Output 'input';$export=Join-Path $Output 'output';$fixtures=Join-Path $Output 'fixtures'
New-Item -ItemType Directory -Path $runner,$inputDir,$export,$fixtures -Force|Out-Null
foreach($file in @('Record-FileSync.ps1','New-FileSyncFixture.ps1','Capture-Frames.ps1')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $runner}
Copy-Item -LiteralPath $ffmpeg -Destination (Join-Path $runner 'ffmpeg.exe')
Copy-Item -LiteralPath $Artifact -Destination $inputDir
@{sha256=(Get-FileHash $Artifact).Hash;ffmpegSha256=(Get-FileHash $ffmpeg).Hash;createdAt=(Get-Date).ToString('o')}|ConvertTo-Json|Set-Content (Join-Path $runner 'recording-recipe.json')
function Xml([string]$s){[Security.SecurityElement]::Escape($s)}
@"
<Configuration><MemoryInMB>8192</MemoryInMB><Networking>Disable</Networking><ClipboardRedirection>Disable</ClipboardRedirection><AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput>
<MappedFolders>
<MappedFolder><HostFolder>$(Xml $fixtures)</HostFolder><SandboxFolder>C:\DemoData</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
<MappedFolder><HostFolder>$(Xml $inputDir)</HostFolder><SandboxFolder>C:\DemoInput</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
<MappedFolder><HostFolder>$(Xml $runner)</HostFolder><SandboxFolder>C:\DemoRunner</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
<MappedFolder><HostFolder>$(Xml $export)</HostFolder><SandboxFolder>C:\DemoExport</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
</MappedFolders><LogonCommand><Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\DemoRunner\Record-FileSync.ps1</Command></LogonCommand></Configuration>
"@ | Set-Content (Join-Path $Output 'record.wsb')
if(!$PrepareOnly){
 if(@((& wsb.exe list --raw|Out-String|ConvertFrom-Json).WindowsSandboxEnvironments).Count){throw 'Close existing Sandboxes before recording.'}
 Start-Process "$env:WINDIR\System32\WindowsSandbox.exe" -ArgumentList ('"'+(Join-Path $Output 'record.wsb')+'"') -WindowStyle Hidden
}
Write-Output "Recording run: $Output"
