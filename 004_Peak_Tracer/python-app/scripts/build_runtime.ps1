#!/usr/bin/env pwsh
# Build python-app/runtime/ as a self-contained, MINIMAL CPython distribution
# that electron-builder can bundle into the portable .exe.
#
# IMPORTANT: do NOT overlay an existing venv that has unrelated packages.
# We saw a 5x size increase (157 MB -> 787 MB) when the source venv happened
# to contain googleapiclient, onnxruntime, ctranslate2, av.libs, etc.
#
# IMPORTANT 2: uv creates lightweight venvs that SYMLINK the stdlib to a
# shared location. If you copy the venv as-is to python-app/runtime/, you
# get a runtime with only site-packages/ in it (no Lib/os.py etc.) and it
# WON'T RUN when shipped. This script MERGES uv's full stdlib from the
# managed CPython distribution INTO the runtime's Lib/, while preserving
# site-packages/ from the slim venv.

[CmdletBinding()]
param(
    [switch]$Force = $false
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)
$pyAppDir = Join-Path $repoRoot "python-app"
$runtimeDir = Join-Path $pyAppDir "runtime"
$buildVenv = Join-Path $env:TEMP "peak-tracer-build-venv-$([guid]::NewGuid())"
$uv = (Get-Command "uv" -ErrorAction Stop).Source

Write-Host "== Peak Tracer runtime builder =="
Write-Host "Runtime target: $runtimeDir"
Write-Host "Build venv: $buildVenv"
Write-Host "uv: $uv"
Write-Host ""

# 1. Find uv-managed CPython 3.11
$uvPythonDir = Get-ChildItem -Path "$env:APPDATA\uv\python" -Directory |
    Where-Object { $_.Name -like "cpython-3.11*" } |
    Select-Object -First 1

if (-not $uvPythonDir) {
    throw "uv-managed CPython 3.11 not found. Run: uv python install 3.11"
}
$uvPython = $uvPythonDir.FullName
$uvPythonExe = Join-Path $uvPython "python.exe"
Write-Host "Using uv CPython: $uvPython"

# 2. Create the slim build venv
& $uv venv $buildVenv --python $uvPythonExe | Out-Null
if ($LASTEXITCODE -ne 0) { throw "uv venv failed" }

# 3. Install ONLY the packages peak-tracer needs
& $uv pip install --python "$buildVenv\Scripts\python.exe" `
    -r (Join-Path $pyAppDir "requirements.txt") `
    openpyxl
if ($LASTEXITCODE -ne 0) { throw "uv pip install failed" }

# 4. Wipe old runtime (ignore Windows file locks)
if (Test-Path $runtimeDir) {
    Write-Host "Removing old runtime..."
    Remove-Item -Recurse -Force $runtimeDir -ErrorAction SilentlyContinue
}
if (Test-Path $runtimeDir) {
    $oldPath = "$runtimeDir.old-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Rename-Item $runtimeDir $oldPath -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

# 5. Copy build venv -> runtime
Write-Host "Copying build venv -> runtime..."
Copy-Item -Recurse -Force $buildVenv $runtimeDir

# 6. Merge uv's full stdlib INTO runtime/Lib/ (preserving site-packages/)
Write-Host "Merging uv stdlib into runtime/Lib/..."
$uvLib = Join-Path $uvPython "Lib"
$runtimeLib = Join-Path $runtimeDir "Lib"
$copied = 0
$skipped = 0
Get-ChildItem -Path $uvLib | ForEach-Object {
    $target = Join-Path $runtimeLib $_.Name
    if (Test-Path $target) {
        $skipped++
        return
    }
    if ($_.PSIsContainer) {
        Copy-Item -Recurse -Force $_.FullName $target
    } else {
        Copy-Item -Force $_.FullName $target
    }
    $copied++
}
Write-Host "  merged $copied stdlib items, skipped $skipped (site-packages preserved)"

# 7. Overwrite Scripts/python.exe + DLLs with uv's versions (the slim venv's
# python.exe is a small launcher that depends on the source CPython install)
Write-Host "Copying uv's Scripts/python.exe, DLLs..."
$runtimeScripts = Join-Path $runtimeDir "Scripts"
@("python.exe", "pythonw.exe", "python3.dll", "python311.dll") | ForEach-Object {
    $src = Join-Path $uvPython $_
    if (Test-Path $src) {
        Copy-Item -Force $src (Join-Path $runtimeScripts $_)
    }
}

# 8. Copy uv's DLLs/ directory (Windows extension modules)
$uvDlls = Join-Path $uvPython "DLLs"
if (Test-Path $uvDlls) {
    $runtimeDlls = Join-Path $runtimeDir "DLLs"
    if (Test-Path $runtimeDlls) { Remove-Item -Recurse -Force $runtimeDlls }
    Copy-Item -Recurse -Force $uvDlls $runtimeDlls
}

# 9. Copy vcruntime DLLs
@("vcruntime140.dll", "vcruntime140_1.dll") | ForEach-Object {
    $src = Join-Path $uvPython $_
    if (Test-Path $src) {
        Copy-Item -Force $src (Join-Path $runtimeScripts $_)
    }
}

# 10. Strip Cython source files (cause Windows file-lock failures during packaging)
$pyxCount = 0
$pxdCount = 0
Get-ChildItem -Path $runtimeDir -Recurse -Include "*.pyx","*.pxd" -ErrorAction SilentlyContinue |
    ForEach-Object {
        if ($_.Extension -eq ".pyx") { $pyxCount++ } else { $pxdCount++ }
        Remove-Item -Force $_.FullName -ErrorAction SilentlyContinue
    }
Write-Host "Removed $pyxCount .pyx + $pxdCount .pxd files"

# 11. Strip __pycache__
$cacheCount = 0
Get-ChildItem -Path $runtimeDir -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue |
    ForEach-Object {
        $cacheCount++
        Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue
    }
Write-Host "Removed $cacheCount __pycache__ dirs"

# 12. Strip dist-info for packages we don't need (keep only the 4 peak-tracer deps)
$keep = @("numpy", "scipy", "biopython", "openpyxl")
$removed = 0
Get-ChildItem -Path $runtimeDir -Recurse -Filter "*.dist-info" -ErrorAction SilentlyContinue |
    Where-Object { $keep -notcontains ($_.Name -split "-")[0].ToLower() } |
    ForEach-Object {
        $removed++
        Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue
    }
Write-Host "Removed $removed dist-info dirs we don't need"

# 13. Rewrite pyvenv.cfg: home must point at the runtime itself, so sys.prefix
# resolves to the runtime (not the temp build venv)
@"
home = $runtimeDir
include-system-site-packages = false
"@ | Set-Content -Path (Join-Path $runtimeDir "pyvenv.cfg") -Encoding ASCII

# 14. Verify
Write-Host ""
Write-Host "Verifying runtime works..."
$testResult = & "$runtimeDir\Scripts\python.exe" -c @"
import sys, os
from Bio import SeqIO
import scipy, numpy, openpyxl
print('  py       = ' + str(sys.version_info.major) + '.' + str(sys.version_info.minor) + '.' + str(sys.version_info.micro))
print('  biopython = ' + __import__('Bio').__version__)
print('  numpy     = ' + numpy.__version__)
print('  scipy     = ' + scipy.__version__)
print('  openpyxl  = ' + openpyxl.__version__)
print('  prefix    = ' + sys.prefix)
print('  os.py     = ' + os.__file__)
"@
$testResult | ForEach-Object { Write-Host $_ }

# 15. Cleanup build venv
Remove-Item -Recurse -Force $buildVenv -ErrorAction SilentlyContinue

# 16. Report size
$size = (Get-ChildItem -Path $runtimeDir -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB
Write-Host ""
Write-Host "== DONE =="
Write-Host "Runtime: $runtimeDir"
Write-Host ("Size: {0:N1} MB" -f $size)
Write-Host ""
Write-Host "Now run: npm run package:portable"
Write-Host "(or zip release/win-unpacked/ for the portable folder deliverable)"
