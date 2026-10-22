param(
    [Parameter(Mandatory=$true)][string]$Executable,
    [Parameter(Mandatory=$true)][string]$App,
    [switch]$PrepareOnly,
    [string]$TestRoot=(Join-Path ([Environment]::GetFolderPath('Desktop')) 'App_builds\tests')
)
$ErrorActionPreference = 'Stop'
$TestRoot = [IO.Path]::GetFullPath($TestRoot)
$exe = (Resolve-Path -LiteralPath $Executable).Path
$run = Join-Path $TestRoot ((Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-' + $App)
$inputDir = Join-Path $run 'input'
$runnerDir = Join-Path $run 'runner'
$outputDir = Join-Path $run 'output'
New-Item -ItemType Directory -Path $inputDir,$runnerDir,$outputDir -Force | Out-Null
$inputName = if ([IO.Path]::GetExtension($exe) -eq '.zip') {'app.zip'} else {'app.exe'}
Copy-Item -LiteralPath $exe -Destination (Join-Path $inputDir $inputName)
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Sandbox-Smoke.ps1') -Destination $runnerDir
if ($App -eq '004_Peak_Tracer') {
    $tests = Join-Path $runnerDir 'peak-tests'
    New-Item -ItemType Directory -Path $tests -Force | Out-Null
    $sourceTests = Join-Path (Split-Path $PSScriptRoot -Parent) "$App\python-app\tests"
    foreach ($name in @('test_analysis_contract.py','test_evidence.py')) {Copy-Item (Join-Path $sourceTests $name) $tests}
}
@{app=$App;artifact=[IO.Path]::GetFileName($exe);inputName=$inputName;sha256=(Get-FileHash $exe -Algorithm SHA256).Hash} | ConvertTo-Json | Set-Content (Join-Path $runnerDir 'test-recipe.json') -Encoding UTF8
function XmlText([string]$value) { [Security.SecurityElement]::Escape($value) }
@"
<Configuration>
  <MemoryInMB>6144</MemoryInMB><Networking>Disable</Networking><ClipboardRedirection>Disable</ClipboardRedirection><AudioInput>Disable</AudioInput>
  <MappedFolders>
    <MappedFolder><HostFolder>$(XmlText $inputDir)</HostFolder><SandboxFolder>C:\TestInput</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$(XmlText $runnerDir)</HostFolder><SandboxFolder>C:\TestRunner</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$(XmlText $outputDir)</HostFolder><SandboxFolder>C:\TestExport</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
  </MappedFolders>
  <LogonCommand><Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\TestRunner\Sandbox-Smoke.ps1</Command></LogonCommand>
</Configuration>
"@ | Set-Content (Join-Path $run 'smoke.wsb') -Encoding UTF8
Write-Output "Smoke run: $run"
if ($PrepareOnly) { return }
$existing = (& wsb.exe list --raw | Out-String | ConvertFrom-Json).WindowsSandboxEnvironments
if (@($existing).Count) { throw 'Close the existing Sandbox before clean-runtime testing.' }
Start-Process (Join-Path $env:WINDIR 'System32\WindowsSandbox.exe') -ArgumentList ('"' + (Join-Path $run 'smoke.wsb') + '"') -WindowStyle Hidden
Write-Output "Result will appear at $outputDir\smoke-result.json. Review the screenshot, then stop this test Sandbox with wsb stop --id <id>."
