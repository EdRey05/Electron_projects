param(
    [Parameter(Mandatory=$true)][string]$SourceDirectory,
    [Parameter(Mandatory=$true)][string]$ZigExecutable,
    [Parameter(Mandatory=$true)][string]$OutputExecutable
)
$ErrorActionPreference = 'Stop'
# Source: Debian 3.0.6~beta+dfsg orig archive, SHA256
# 24190cef98d7f6faaac35306c496d8fe16d72991da89d25cc589dcd5619938e0
# No TraceTuner source modifications. This is the upstream pcmake source list,
# compiled with a portable Zig 0.14.1 C compiler instead of installed GCC.
$computeDir = Join-Path $SourceDirectory 'src/compute_qv'
$matchDir = Join-Path $SourceDirectory 'src/mktrain'
$cFiles = Get-ChildItem $computeDir -Filter '*.c' | Where-Object { $_.Name -ne 'example.c' } | ForEach-Object FullName
$matchFiles = @('Btk_match_data.c','Btk_compute_match.c','Btk_sw.c') | ForEach-Object { Join-Path $matchDir $_ }
$destination = [IO.Path]::GetFullPath($OutputExecutable)
New-Item -ItemType Directory -Force ([IO.Path]::GetDirectoryName($destination)) | Out-Null
$env:ZIG_GLOBAL_CACHE_DIR = Join-Path ([IO.Path]::GetDirectoryName($destination)) 'zig-cache'
& $ZigExecutable cc -target x86_64-windows-gnu -std=gnu99 -O2 -D__WIN32 '-DOS_NAME="Windows"' -Wno-implicit-function-declaration -Wno-int-conversion -I $computeDir -I $matchDir @cFiles @matchFiles -o $destination
if ($LASTEXITCODE -ne 0) { throw "TraceTuner compilation failed: $LASTEXITCODE" }
Get-FileHash -LiteralPath $destination
