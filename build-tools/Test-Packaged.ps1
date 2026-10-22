param([Parameter(Mandatory=$true)][string]$App,[string]$Executable)
$ErrorActionPreference = 'Stop'
if (!$Executable) {
    $repository = Split-Path $PSScriptRoot -Parent
    $package = Get-Content (Join-Path $repository "$App\package.json") -Raw | ConvertFrom-Json
    $Executable = Join-Path ([Environment]::GetFolderPath('Desktop')) "App_builds\$($package.name)-$($package.version)-win-x64-portable.exe"
}
& (Join-Path $PSScriptRoot 'Smoke-App.ps1') -App $App -Executable $Executable
