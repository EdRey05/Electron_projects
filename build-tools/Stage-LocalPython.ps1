[CmdletBinding()]
param([switch]$PrepareOnly,[string]$OutputDirectory=(Join-Path ([Environment]::GetFolderPath('Desktop')) 'App_builds'))
$ErrorActionPreference='Stop'
$id=Split-Path (Get-Location).Path -Leaf
Write-Output 'Runtime staging is now part of the complete isolated build; no runtime is installed into the host checkout.'
& (Join-Path $PSScriptRoot 'Build-Apps.ps1') -Apps $id -OutputDirectory $OutputDirectory -PrepareOnly:$PrepareOnly
