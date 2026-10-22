param([Parameter(Mandatory=$true)][string]$AppRoot,[Parameter(Mandatory=$true)][string]$App,[switch]$ReuseRuntime)
$ErrorActionPreference = 'Stop'
$profiles = Get-Content C:\Runner\apps.json -Raw | ConvertFrom-Json
$profile = $profiles | Where-Object { $_.id -eq $App }
if (!$profile -or !$profile.python) { throw 'Python app profile is missing' }
$spec = Get-Content C:\Runner\python-runtime.json -Raw | ConvertFrom-Json
$archive = 'C:\Build\python.tar.gz'
$runtime = Join-Path $AppRoot 'python-app\runtime'
if (!$ReuseRuntime) {
    Step "Downloading Python $($spec.version) standalone build $($spec.build)"
    if (!(Test-Path $archive)) { Invoke-WebRequest $spec.url -OutFile $archive -UseBasicParsing }
    if ((Get-FileHash $archive -Algorithm SHA256).Hash -ne $spec.sha256) { throw 'Standalone Python checksum mismatch.' }
    Copy-Item C:\Runner\python-runtime.json (Join-Path $export 'python-runtime.json')
    $stage = Join-Path $AppRoot '.python-stage'
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    Run 'tar.exe' @('-xzf',$archive,'-C',$stage)
    Move-Item -LiteralPath (Join-Path $stage 'python') -Destination $runtime
} else {
    if (!(Test-Path (Join-Path $export 'python-runtime.json')) -or !(Test-Path (Join-Path $runtime 'python.exe'))) { throw 'No previously verified runtime is available for recovery.' }
    Step 'Reusing the already verified runtime in the retained failed guest'
}
$python = Join-Path $runtime 'python.exe'
Run $python @('-I','-c',"import sys,tkinter,ssl; print(sys.version); print(sys.prefix); print(tkinter.Tcl().eval('info patchlevel'))")
$requirementsToInstall = Join-Path $AppRoot 'python-app\requirements.lock.txt'
Run $python @('-m','pip','install','--disable-pip-version-check','-r',$requirementsToInstall,'-r',(Join-Path $AppRoot 'python-app\requirements.txt'))
Run $python @('-m','pip','check')
Run $python @('-m','pip','freeze','--all')
# Save the resolved transitive dependency set separately from tool output.
& $python -m pip freeze --exclude pip --exclude setuptools --exclude wheel | Set-Content (Join-Path $export 'python-resolved-requirements.txt') -Encoding UTF8
if ($LASTEXITCODE -ne 0) { throw 'Could not record Python dependency resolution.' }
$locked = @(Get-Content $requirementsToInstall | Where-Object { $_.Trim() -and !$_.StartsWith('#') } | ForEach-Object { $_.Trim().ToLowerInvariant().Replace('_','-') } | Sort-Object)
$resolved = @(Get-Content (Join-Path $export 'python-resolved-requirements.txt') | Where-Object { $_.Trim() } | ForEach-Object { $_.Trim().ToLowerInvariant().Replace('_','-') } | Sort-Object)
if (Compare-Object $locked $resolved) { throw 'Installed Python packages differ from the committed complete lock.' }
$probe = "import importlib,tkinter; [importlib.import_module(n) for n in '" + ($profile.pythonImports -join ',') + "'.split(',') if n]; print(tkinter.Tcl().eval('info patchlevel'))"
Run $python @('-I','-c',$probe)
if ($profile.tesseract) {
    $ocrSpec = Get-Content C:\Runner\tesseract-runtime.json -Raw | ConvertFrom-Json
    Step "Bundling Tesseract $($ocrSpec.version) for offline OCR"
    $installer = 'C:\Build\tesseract-setup.exe'
    Invoke-WebRequest $ocrSpec.url -OutFile $installer -UseBasicParsing
    if ((Get-FileHash $installer -Algorithm SHA256).Hash -ne $ocrSpec.sha256) { throw 'Tesseract installer checksum mismatch.' }
    Copy-Item C:\Runner\tesseract-runtime.json (Join-Path $export 'tesseract-runtime.json')
    $installProcess = Start-Process -FilePath $installer -ArgumentList '/S','/D=C:\Build\Tesseract' -WindowStyle Hidden -Wait -PassThru
    if ($installProcess.ExitCode -ne 0) { throw "Guest Tesseract staging failed: $($installProcess.ExitCode)" }
    $tools = Join-Path $AppRoot 'python-app\tools'
    New-Item -ItemType Directory -Path $tools -Force | Out-Null
    $ocrRoot = Join-Path $tools 'tesseract'
    Move-Item C:\Build\Tesseract $ocrRoot
    if (!(Test-Path (Join-Path $ocrRoot 'tessdata\eng.traineddata'))) { throw 'Bundled Tesseract English language data missing.' }
    Run (Join-Path $ocrRoot 'tesseract.exe') @('--version')
}
# Relocate the complete Python-app tree again and run imports from the new path,
# with the old path absent. Relative resource and stdlib lookup must still work.
$pythonApp = Join-Path $AppRoot 'python-app'
$relocated = Join-Path $AppRoot 'relocated-python-app'
Move-Item -LiteralPath $pythonApp -Destination $relocated
try {
    $relocatedPython = Join-Path $relocated 'runtime\python.exe'
    Run $relocatedPython @('-I','-c',$probe)
} finally { Move-Item -LiteralPath $relocated -Destination $pythonApp }
Step 'Python full-runtime relocation check passed'
