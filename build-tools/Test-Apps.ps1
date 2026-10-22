[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$BuildOutput,[string]$TestRoot=(Join-Path ([Environment]::GetFolderPath('Desktop')) 'App_builds\tests'),[int]$TimeoutMinutes=15)
$ErrorActionPreference='Stop'
$batch=Get-Content (Join-Path $BuildOutput 'result.json') -Raw | ConvertFrom-Json
if ($batch.status -ne 'packaged' -or !@($batch.results).Count) {throw 'Choose a completed successful build batch before release testing.'}
foreach ($app in $batch.results) {
    if ($app.status -ne 'packaged' -or !@($app.artifacts).Count) {throw "No successful artifacts for $($app.app)"}
}
New-Item -ItemType Directory -Path $TestRoot -Force | Out-Null
$records=@()
foreach ($app in $batch.results) {
    foreach ($artifact in $app.artifacts) {
        $existing=@((& wsb.exe list --raw | Out-String | ConvertFrom-Json).WindowsSandboxEnvironments)
        if ($existing.Count) { throw 'Close existing Sandboxes before clean tests.' }
        $ownedId=$null
        try {
            $executable=Join-Path (Join-Path $BuildOutput $app.app) $artifact.file
            if ((Get-FileHash $executable).Hash -ne $artifact.sha256) { throw 'Build artifact hash mismatch' }
            $lines=& (Join-Path $PSScriptRoot 'Smoke-App.ps1') -App $app.app -Executable $executable -TestRoot $TestRoot
            $lines | Write-Output
            $line=@($lines | Where-Object { $_ -like 'Smoke run: *' })[-1]
            $run=$line.Substring('Smoke run: '.Length)
            $resultPath=Join-Path $run 'output\smoke-result.json'
            $deadline=(Get-Date).AddMinutes($TimeoutMinutes)
            while (!(Test-Path $resultPath)) {
                if (!$ownedId) {
                    $guests=@((& wsb.exe list --raw | Out-String | ConvertFrom-Json).WindowsSandboxEnvironments)
                    if ($guests.Count -eq 1) {$ownedId=$guests[0].Id}
                }
                if ((Get-Date) -gt $deadline) {throw "Runtime test timed out: $run"}
                Start-Sleep -Seconds 3
            }
            $result=Get-Content $resultPath -Raw | ConvertFrom-Json
            if ($result.sha256 -ne $artifact.sha256) {throw 'Test result refers to another artifact'}
            if ($result.hostTools.nodeAvailable -or $result.hostTools.pythonAvailable) {throw 'Clean test guest contains system build tools'}
            $records+=@{app=$app.app;artifact=$artifact.file;sha256=$artifact.sha256;status=$result.status;error=$result.error;testRecord=$resultPath;checks=$result.checks}
            Write-Output "$($artifact.file): $($result.status)"
        } catch {
            $records+=@{app=$app.app;artifact=$artifact.file;sha256=$artifact.sha256;status='failed';error=$_.ToString()}
        } finally {
            if ($ownedId) {& wsb.exe stop --id $ownedId | Out-Null}
            $records | ConvertTo-Json -Depth 15 | Set-Content (Join-Path $TestRoot 'TEST_RESULTS.json')
        }
    }
}
if (@($records | Where-Object status -ne 'smoke-passed').Count) {throw "Runtime tests failed. See $TestRoot\TEST_RESULTS.json"}
