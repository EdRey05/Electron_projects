param([Parameter(Mandatory=$true)][string]$Runtime,[Parameter(Mandatory=$true)][string]$ExportDirectory)
$ErrorActionPreference='Stop'
if($env:USERNAME -ne 'WDAGUtilityAccount' -or !(Test-Path C:\Runner\recipe.json)){throw 'Stage MSVC only inside the configured disposable build Sandbox.'}
$spec=Get-Content C:\Runner\msvc-runtime.json -Raw|ConvertFrom-Json
$installer='C:\Build\vc_redist.x64.exe'
if(!(Test-Path $installer)){Invoke-WebRequest $spec.url -OutFile $installer -UseBasicParsing}
if((Get-FileHash $installer -Algorithm SHA256).Hash -ne $spec.sha256){throw 'Microsoft runtime package checksum mismatch.'}
$signature=Get-AuthenticodeSignature $installer
if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'CN=Microsoft Corporation,'){throw 'Microsoft runtime signature is invalid.'}
# Extract CAB payloads without running the installer, even inside the guest.
& (Join-Path $Runtime 'python.exe') -I C:\Runner\extract-msvc-runtime.py $installer C:\Build\msvc-extracted $Runtime C:\Runner\msvc-runtime.json
if($LASTEXITCODE -ne 0){throw 'Microsoft runtime CAB extraction failed.'}
$files=@()
foreach($entry in $spec.files){
    $file=Join-Path $Runtime $entry.file
    if((Get-FileHash $file -Algorithm SHA256).Hash -ne $entry.sha256){throw "Runtime DLL checksum mismatch: $($entry.file)"}
    if((Get-Item $file).VersionInfo.FileVersion -ne $spec.version){throw "Runtime DLL version mismatch: $($entry.file)"}
    $files+=@{file=$entry.file;sha256=$entry.sha256;version=$spec.version}
}
@{version=$spec.version;source=$spec.url;installerSha256=$spec.sha256;files=$files}|ConvertTo-Json -Depth 5|Set-Content (Join-Path $ExportDirectory 'msvc-runtime.json')
Copy-Item C:\Runner\msvc-runtime.json (Join-Path $Runtime 'msvc-runtime-provenance.json')
