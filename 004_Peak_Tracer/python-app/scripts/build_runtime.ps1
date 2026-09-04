#!/usr/bin/env pwsh
# Build python-app/runtime/ as a self-contained CPython distribution that
# electron-builder can bundle into the portable .exe.
#
# Replaces Scenario B's failure mode (electron-builder only ships
# Lib/site-packages/, leaving the stdlib missing) by populating runtime/
# from uv's local CPython cache + a working venv's site-packages.
#
# Usage (from repo root):
#   pwsh 004_Peak_Tracer/python-app/scripts/build_runtime.ps1
#
# Outputs:
#   004_Peak_Tracer/python-app/runtime/  (gitignored, ~700 MB)

$ErrorActionPreference = "Stop"

# 1. Locate sources
$uvCache = Join-Path $env:APPDATA "Roaming\uv\python"
$cpythonDirs = Get-ChildItem -Path $uvCache -Filter "cpython-3.11*" -Directory
if ($cpythonDirs.Count -eq 0) {
    Write-Host "ERROR: No CPython 3.11 found in $uvCache" -ForegroundColor Red
    Write-Host "Install with: uv python install 3.11"
    exit 1
}
$srcCpy = $cpythonDirs[0].FullName
Write-Host "CPython source: $srcCpy" -ForegroundColor Cyan

# Pick a working venv with biopython installed
$venvRoot = Join-Path $env:LOCALAPPDATA "hermes\hermes-agent\venv"
if (-not (Test-Path (Join-Path $venvRoot "Lib\site-packages\biopython-1.88.dist-info"))) {
    Write-Host "ERROR: $venvRoot does not have biopython 1.88 installed" -ForegroundColor Red
    Write-Host "Either install biopython there or pass -VenvRoot to a venv that has it."
    exit 1
}
$venvSrc = $venvRoot
Write-Host "Source venv:    $venvSrc" -ForegroundColor Cyan

# 2. Wipe and recreate runtime
$runtime = Join-Path $PSScriptRoot "..\runtime"
if (Test-Path $runtime) {
    Write-Host "Wiping existing $runtime" -ForegroundColor Yellow
    Remove-Item -Recurse -Force $runtime
}
New-Item -ItemType Directory -Path $runtime | Out-Null

# 3. Copy stdlib + headers + libs from CPython
foreach ($sub in @("DLLs", "include", "Lib", "libs")) {
    $src = Join-Path $srcCpy $sub
    if (Test-Path $src) {
        $dst = Join-Path $runtime $sub
        Write-Host "Copying $sub/" -NoNewline
        Copy-Item -Recurse -Force $src $dst
        $count = (Get-ChildItem $dst).Count
        Write-Host " ($count entries)"
    }
}

# 4. Copy python.exe + DLLs into Scripts/
$scripts = Join-Path $runtime "Scripts"
New-Item -ItemType Directory -Path $scripts | Out-Null
foreach ($fname in @("python.exe", "python3.dll", "python311.dll", "pythonw.exe",
                     "vcruntime140.dll", "vcruntime140_1.dll")) {
    $src = Join-Path $srcCpy $fname
    if (Test-Path $src) {
        Copy-Item -Force $src (Join-Path $scripts $fname)
    }
}
Write-Host "Scripts/: python.exe + DLLs copied"

# 5. Overwrite Lib/site-packages with the working venv
$dstSp = Join-Path $runtime "Lib\site-packages"
if (Test-Path $dstSp) {
    Remove-Item -Recurse -Force $dstSp
}
Write-Host "Copying site-packages/ (this takes ~30s)" -NoNewline
Copy-Item -Recurse -Force (Join-Path $venvSrc "Lib\site-packages") $dstSp
$spCount = (Get-ChildItem $dstSp).Count
Write-Host " ($spCount entries)"

# 6. Strip Cython sources (.pyx, .pxd) — they cause Windows file-lock
#    failures during electron-builder packaging
$pyxCount = 0
Get-ChildItem -Path $runtime -Recurse -Include "*.pyx", "*.pxd" -ErrorAction SilentlyContinue | ForEach-Object {
    Remove-Item -Force $_.FullName
    $pyxCount++
}
Write-Host "Stripped $pyxCount Cython source files"

# 7. Delete any pyvenv.cfg (uv embeds a build-host path here that breaks on
#    target machines)
$cfgCount = 0
Get-ChildItem -Path $runtime -Recurse -Filter "pyvenv.cfg" -ErrorAction SilentlyContinue | ForEach-Object {
    Remove-Item -Force $_.FullName
    $cfgCount++
}
Write-Host "Stripped $cfgCount pyvenv.cfg files"

# 8. Verify
Write-Host "`n=== Verification ===" -ForegroundColor Cyan
$py = Join-Path $scripts "python.exe"
& $py --version
& $py -c "import sys; print('sys.prefix:', sys.prefix)"
& $py -c "from Bio import SeqIO; import scipy; import numpy; print('biopython + scipy + numpy OK')"

# Check sys.prefix resolves to the runtime (NOT a temp path)
$prefix = & $py -c "import sys; print(sys.prefix)"
if (-not $prefix.EndsWith("\python-app\runtime")) {
    Write-Host "WARNING: sys.prefix does not end with \python-app\runtime" -ForegroundColor Red
    Write-Host "Python found a stray Lib/os.py somewhere up the tree. Search for them:"
    Write-Host "  Get-ChildItem -Path .. -Recurse -Filter os.py -ErrorAction SilentlyContinue | Where-Object { $_.FullName -like '*Lib*' }"
    exit 1
}

Write-Host "`nRuntime built successfully at $runtime" -ForegroundColor Green
Write-Host "Next step: npm run build && npm run package:portable"