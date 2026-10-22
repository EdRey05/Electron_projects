$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if ($env:USERNAME -ne 'WDAGUtilityAccount' -or !(Test-Path C:\Runner\recipe.json)) { throw 'Run only in the configured Windows Sandbox.' }
$recipe = Get-Content C:\Runner\recipe.json -Raw | ConvertFrom-Json
$buildRoot = 'C:\Build'
New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
$export = 'C:\Export'
function Step([string]$Message) { ((Get-Date).ToString('o') + ' ' + $Message) | Add-Content (Join-Path $export 'progress.log') }
function Run([string]$Program,[string[]]$Arguments) {
    Step ($Program + ' ' + ($Arguments -join ' '))
    $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    & $Program @Arguments 2>&1 | ForEach-Object { $_.ToString() } | Tee-Object -FilePath (Join-Path $export 'tools.log') -Append | Out-Host
    $code = $LASTEXITCODE; $ErrorActionPreference = $previous
    if ($code -ne 0) { throw "$Program exited $code" }
}
$results = @()
try {
    $spec = Get-Content C:\Runner\toolchain.json -Raw | ConvertFrom-Json
    $archive = "node-v$($spec.node)-win-x64.zip"
    $url = "https://nodejs.org/dist/v$($spec.node)"
    Invoke-WebRequest "$url/$archive" -OutFile "C:\Build\$archive" -UseBasicParsing
    $checksums = (Invoke-WebRequest "$url/SHASUMS256.txt" -UseBasicParsing).Content
    $match = @($checksums -split "`n" | Where-Object { $_.Trim().EndsWith(" $archive") })
    if ($match.Count -ne 1) { throw 'Node checksum entry missing or ambiguous' }
    $expected = ($match[0].Trim() -split '\s+')[0]
    if ((Get-FileHash "C:\Build\$archive").Hash -ne $expected) { throw 'Node checksum mismatch' }
    Expand-Archive "C:\Build\$archive" C:\Build
    $env:PATH = "C:\Build\node-v$($spec.node)-win-x64;$env:PATH"
    $env:npm_config_cache = 'C:\Build\npm-cache'
    $env:PIP_CACHE_DIR = 'C:\Build\wheel-cache'
    $env:ELECTRON_CACHE = 'C:\Build\electron-cache'
    $env:ELECTRON_BUILDER_CACHE = 'C:\Build\builder-cache'
    $env:ELECTRON_BUILDER_COMPRESSION_LEVEL = '3'
    $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
    if ((& npm.cmd --version) -ne $spec.npm) { throw 'Pinned npm version mismatch' }
    $workspace = 'C:\Build\workspace'
    New-Item -ItemType Directory -Path $workspace -Force | Out-Null
    Copy-Item C:\Runner (Join-Path $workspace 'build-tools') -Recurse
    Run 'node.exe' @('--test',(Join-Path $workspace 'build-tools\runtime.test.cjs'))
    $profiles = Get-Content C:\Runner\apps.json -Raw | ConvertFrom-Json
    foreach ($id in $recipe.apps) {
        $profile = $profiles | Where-Object { $_.id -eq $id }
        $export = Join-Path 'C:\Export' $id
        New-Item -ItemType Directory -Path $export -Force | Out-Null
        $result = @{app=$id;status='failed';error=$null;artifacts=@();startedAt=(Get-Date).ToString('o')}
        try {
            $appRoot = Join-Path $workspace $id
            $source = Join-Path 'C:\Source' $id
            $excluded = @('.git','node_modules','.venv','venv','runtime','runtime-venv','release','dist','out','.cache','.pytest_cache','__pycache__','data','logs')
            $excluded += @($profile.exclude | ForEach-Object { Join-Path $source $_ })
            & robocopy.exe $source $appRoot /E /XJ /R:1 /W:1 /XD @excluded /XF .env .env.local .env.production.local /NFL /NDL /NJH /NJS
            if ($LASTEXITCODE -ge 8) { throw "Source copy failed: $LASTEXITCODE" }
            Get-ChildItem $appRoot -Recurse -File | ForEach-Object { @{path=$_.FullName.Substring($appRoot.Length+1);sha256=(Get-FileHash $_.FullName).Hash} } | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $export 'source-manifest.json')
            Set-Location $appRoot
            Run 'npm.cmd' @('ci','--no-audit','--no-fund')
            if ($profile.python) { & C:\Runner\Stage-Python.ps1 -AppRoot $appRoot -App $id }
            Run 'npm.cmd' @('run','validate')
            Run 'npm.cmd' @('run','build')
            $builder = Join-Path $appRoot 'node_modules\.bin\electron-builder.cmd'
            Run $builder @('--config','electron-builder.json','--win','portable','--x64','--publish','never')
            $package = Get-Content package.json -Raw | ConvertFrom-Json
            $name = "$($package.name)-$($package.version)-win-x64"
            $exe = Join-Path $appRoot "release\$name-portable.exe"
            if (!(Test-Path $exe)) { throw "Artifact missing: $exe" }
            Copy-Item $exe $export
            # The same packaging pass emits win-unpacked. ZIP it without a second build.
            $folder = Join-Path $appRoot 'release\win-unpacked'
            $zip = Join-Path $export "$name-folder.zip"
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            [IO.Compression.ZipFile]::CreateFromDirectory($folder,$zip,[IO.Compression.CompressionLevel]::Fastest,$false)
            foreach ($file in @((Join-Path $export "$name-portable.exe"),$zip)) {
                $result.artifacts += @{file=[IO.Path]::GetFileName($file);sha256=(Get-FileHash $file).Hash;bytes=(Get-Item $file).Length}
            }
            $result.status = 'packaged'
        } catch { $result.error = $_.ToString(); Step "FAILED: $_" }
        $result.completedAt=(Get-Date).ToString('o')
        $result | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $export 'result.json')
        $results += $result
    }
} catch { $results += @{app='toolchain';status='failed';error=$_.ToString()} }
$batch = @{results=$results;completedAt=(Get-Date).ToString('o');status='packaged'}
if (@($results | Where-Object status -ne 'packaged').Count) { $batch.status='failed' }
$batch | ConvertTo-Json -Depth 12 | Set-Content C:\Export\result.tmp.json
Move-Item C:\Export\result.tmp.json C:\Export\result.json
& shutdown.exe /s /t 10
