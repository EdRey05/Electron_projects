# Compatibility entry point for the former host-local runtime builder.
[CmdletBinding()]
param([string]$OutputDirectory=(Join-Path ([Environment]::GetFolderPath('Desktop')) 'App_builds'),[switch]$PrepareOnly)
$ErrorActionPreference='Stop'
$repository=Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
Write-Output 'Runtime staging is now part of the complete isolated app build.'
& (Join-Path $repository 'build-tools\Build-Apps.ps1') -Apps 004_Peak_Tracer -OutputDirectory $OutputDirectory -PrepareOnly:$PrepareOnly
