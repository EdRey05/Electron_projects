[CmdletBinding()]
param([string]$Artifacts=(Join-Path ([Environment]::GetFolderPath('Desktop')) 'App_build_standardization\release-validation'),[string]$Output=(Join-Path ([Environment]::GetFolderPath('Desktop')) 'App_build_standardization\demos'),[switch]$PrepareOnly,[string]$App,[string]$Artifact)
$ErrorActionPreference='Stop'
if($App -eq '002_Sequence_Binding_Finder'){
 & (Join-Path $PSScriptRoot 'Record-SequenceBindingFinderDemo.ps1') -Artifact $Artifact -Output $Output -PrepareOnly:$PrepareOnly
 return
}
if($App){throw 'Use the per-app recorder or omit -App for the legacy batch recording.'}
$Artifacts=(Resolve-Path $Artifacts).Path
$Output=[IO.Path]::GetFullPath($Output)
New-Item -ItemType Directory -Path $Output -Force|Out-Null
function Xml([string]$s){[Security.SecurityElement]::Escape($s)}
@"
<Configuration><MemoryInMB>8192</MemoryInMB><Networking>Enable</Networking><ClipboardRedirection>Disable</ClipboardRedirection><AudioInput>Disable</AudioInput>
<MappedFolders>
<MappedFolder><HostFolder>$(Xml $Artifacts)</HostFolder><SandboxFolder>C:\Artifacts</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
<MappedFolder><HostFolder>$(Xml $PSScriptRoot)</HostFolder><SandboxFolder>C:\DemoRunner</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
<MappedFolder><HostFolder>$(Xml $Output)</HostFolder><SandboxFolder>C:\DemoExport</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
</MappedFolders><LogonCommand><Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\DemoRunner\Sandbox-Record.ps1</Command></LogonCommand></Configuration>
"@|Set-Content (Join-Path $Output 'record.wsb')
if($PrepareOnly){return}
if(@((& wsb.exe list --raw|Out-String|ConvertFrom-Json).WindowsSandboxEnvironments).Count){throw 'Close existing Sandboxes first.'}
Start-Process (Join-Path $env:WINDIR 'System32\WindowsSandbox.exe') -ArgumentList ('"'+(Join-Path $Output 'record.wsb')+'"') -WindowStyle Hidden
Write-Output "Recording guest started. Evidence: $Output. Stop its owned ID after reviewing results."
