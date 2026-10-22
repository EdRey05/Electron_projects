[CmdletBinding()]
param([string[]]$Apps,[string]$OutputDirectory=(Join-Path ([Environment]::GetFolderPath('Desktop')) 'App_builds'),[switch]$PrepareOnly,[int]$TimeoutMinutes=120)
$ErrorActionPreference = 'Stop'
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$repository = Split-Path $PSScriptRoot -Parent
$profiles = Get-Content (Join-Path $PSScriptRoot 'apps.json') -Raw | ConvertFrom-Json
if (!$Apps) { $Apps = @($profiles.id) }
# Also accept a comma-separated CLI argument from Windows PowerShell -File.
$Apps = @($Apps | ForEach-Object { $_ -split ',' } | Select-Object -Unique)
foreach ($id in $Apps) { if ($id -notin $profiles.id) { throw "Unregistered app: $id. Add a profile to build-tools/apps.json first." } }
$run = Join-Path $OutputDirectory ('runs\' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-batch')
$inputs = Join-Path $run 'inputs'; $output = Join-Path $run 'output'
New-Item -ItemType Directory -Path $inputs,$output -Force | Out-Null
Copy-Item (Join-Path $PSScriptRoot '*') $inputs -Recurse -Exclude runs,tests
$commit = (& git.exe -C $repository rev-parse HEAD | Out-String).Trim()
$dirty = (& git.exe -C $repository status --porcelain | Out-String).Trim()
@{apps=$Apps;commit=$commit;workingTree=$dirty;createdAt=(Get-Date).ToString('o')} | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $inputs 'recipe.json')
function Xml([string]$s) { [Security.SecurityElement]::Escape($s) }
$config = @"
<Configuration>
<MemoryInMB>8192</MemoryInMB><Networking>Enable</Networking><ClipboardRedirection>Disable</ClipboardRedirection><AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput><PrinterRedirection>Disable</PrinterRedirection>
<MappedFolders>
<MappedFolder><HostFolder>$(Xml $repository)</HostFolder><SandboxFolder>C:\Source</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
<MappedFolder><HostFolder>$(Xml $inputs)</HostFolder><SandboxFolder>C:\Runner</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
<MappedFolder><HostFolder>$(Xml $output)</HostFolder><SandboxFolder>C:\Export</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
</MappedFolders>
<LogonCommand><Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Runner\Sandbox-Batch.ps1</Command></LogonCommand>
</Configuration>
"@
$wsb = Join-Path $run 'build.wsb'; $config | Set-Content $wsb
Write-Output "Batch: $run"
if ($PrepareOnly) { return }
$existing = (& wsb.exe list --raw | Out-String | ConvertFrom-Json).WindowsSandboxEnvironments
if (@($existing).Count) { throw 'Close the existing Sandbox first.' }
$ownedId = $null
try {
    Start-Process (Join-Path $env:WINDIR 'System32\WindowsSandbox.exe') -ArgumentList ('"'+$wsb+'"') -WindowStyle Hidden
    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    while (!(Test-Path (Join-Path $output 'result.json'))) {
        if (!$ownedId) {
            $guests = @((& wsb.exe list --raw | Out-String | ConvertFrom-Json).WindowsSandboxEnvironments)
            if ($guests.Count -eq 1) { $ownedId = $guests[0].Id }
        }
        if ((Get-Date) -gt $deadline) { throw "Batch timed out. Logs: $output" }
        Start-Sleep -Seconds 3
    }
    $batch = Get-Content (Join-Path $output 'result.json') -Raw | ConvertFrom-Json
    foreach ($result in $batch.results) {
        if ($result.app -notin $Apps -and $result.app -ne 'toolchain') { throw 'Unrecognized app in guest result' }
        foreach ($artifact in $result.artifacts) {
            if ($artifact.file -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]+\.(exe|zip)$') { throw 'Unsafe artifact filename' }
            $source = Join-Path (Join-Path $output $result.app) $artifact.file
            if ((Get-FileHash $source).Hash -ne $artifact.sha256) { throw 'Artifact checksum mismatch' }
            $destination = Join-Path $OutputDirectory $artifact.file
            if (Test-Path $destination) { $destination=Join-Path $OutputDirectory ((Split-Path $run -Leaf)+'-'+$artifact.file) }
            Copy-Item $source $destination
            "$($artifact.sha256)  $([IO.Path]::GetFileName($destination))" | Set-Content ($destination+'.sha256')
            Write-Output "Exported: $destination"
        }
    }
    if ($batch.status -ne 'packaged') { throw "Some builds failed; inspect $output\result.json" }
} finally {
    # Only stop the guest observed after this invocation started it.
    if ($ownedId) { & wsb.exe stop --id $ownedId | Out-Null }
}
