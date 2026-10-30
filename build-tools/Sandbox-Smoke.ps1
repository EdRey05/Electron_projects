param([switch]$AttachExisting)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$export = 'C:\TestExport'
$result = @{status='failed';error=$null;checks=@();completedAt=$null}
function Send-Cdp([string]$Method, $Parameters) {
    $script:messageId++
    $id = $script:messageId
    $json = @{id=$id;method=$Method;params=$Parameters} | ConvertTo-Json -Depth 30 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $segment = [ArraySegment[byte]]::new($bytes)
    $script:socket.SendAsync($segment,[Net.WebSockets.WebSocketMessageType]::Text,$true,[Threading.CancellationToken]::None).GetAwaiter().GetResult() | Out-Null
    $timeout = [Threading.CancellationTokenSource]::new(30000)
    try {
        do {
            $stream = [IO.MemoryStream]::new()
            do {
                $buffer = [byte[]]::new(65536)
                $received = $script:socket.ReceiveAsync([ArraySegment[byte]]::new($buffer),$timeout.Token).GetAwaiter().GetResult()
                $stream.Write($buffer,0,$received.Count)
            } while (!$received.EndOfMessage)
            $reply = [Text.Encoding]::UTF8.GetString($stream.ToArray()) | ConvertFrom-Json
            $stream.Dispose()
        } while ($reply.id -ne $id)
        if ($reply.error) { throw ($reply.error | ConvertTo-Json -Compress) }
        return $reply.result
    } finally { $timeout.Dispose() }
}
function Evaluate([string]$Expression) {
    $reply = Send-Cdp 'Runtime.evaluate' @{expression=$Expression;awaitPromise=$true;returnByValue=$true}
    if ($reply.exceptionDetails) { throw ($reply.exceptionDetails | ConvertTo-Json -Depth 10 -Compress) }
    return $reply.result.value
}
try {
    if ($env:USERNAME -ne 'WDAGUtilityAccount' -or !(Test-Path 'C:\TestRunner\test-recipe.json')) { throw 'Run only in the configured test Sandbox.' }
    New-Item -ItemType Directory C:\Smoke,C:\SmokeFixtures\A,C:\SmokeFixtures\B -Force | Out-Null
    $recipe = Get-Content C:\TestRunner\test-recipe.json -Raw | ConvertFrom-Json
    $folderMode = $recipe.inputName -eq 'app.zip'
    if (!$AttachExisting) {
        if ($folderMode) {
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            [IO.Compression.ZipFile]::ExtractToDirectory('C:\TestInput\app.zip','C:\Smoke')
            $executables = @(Get-ChildItem C:\Smoke -Filter *.exe | Where-Object Name -ne 'elevate.exe')
            if ($executables.Count -ne 1) { throw 'Expected exactly one application executable at ZIP root.' }
            $executable = $executables[0].FullName
            $first = Start-Process $executable -ArgumentList '--remote-debugging-port=9222' -PassThru
            $ready = $false; $until = (Get-Date).AddSeconds(150)
            do {
                Start-Sleep -Seconds 2
                try { $ready = [bool](Invoke-RestMethod http://127.0.0.1:9222/json/list -TimeoutSec 2) } catch {}
            } while (!$ready -and (Get-Date) -lt $until)
            if (!$ready -or !(Test-Path C:\Smoke\data)) { throw 'Folder app did not initialize portable data.' }
            'retained across relocation' | Set-Content C:\Smoke\data\portability-marker.txt
            & taskkill.exe /PID $first.Id /T /F | Out-Null
            Start-Sleep -Seconds 3
            Move-Item C:\Smoke 'C:\Relocated app with spaces'
            $executable = Join-Path 'C:\Relocated app with spaces' $executables[0].Name
            if ((Get-Content 'C:\Relocated app with spaces\data\portability-marker.txt') -ne 'retained across relocation') { throw 'Portable data lost during relocation.' }
            $result.checks += 'folder-first-launch-and-relocation'
        } else { Copy-Item C:\TestInput\app.exe C:\Smoke\app.exe; $executable='C:\Smoke\app.exe' }
    } else { $executable='C:\Smoke\app.exe' }
    $result.artifact = $recipe.artifact
    $result.sha256 = (Get-FileHash (Join-Path C:\TestInput $recipe.inputName) -Algorithm SHA256).Hash
    $result.hostTools = @{nodeAvailable=[bool](Get-Command node.exe -ErrorAction SilentlyContinue);pythonAvailable=[bool](Get-Command python.exe -ErrorAction SilentlyContinue)}
    $launchStart = Get-Date
    if (!$AttachExisting) {
        Start-Process $executable -ArgumentList '--remote-debugging-port=9222','--remote-debugging-address=127.0.0.1' -RedirectStandardError C:\TestExport\app-stderr.log -RedirectStandardOutput C:\TestExport\app-stdout.log | Out-Null
    }
    $launchTimeout = if ($recipe.app -in @('003_Gene_Synthesis_Hub','004_Peak_Tracer','005_KM_Plotter')) {480} else {150}
    $deadline = (Get-Date).AddSeconds($launchTimeout)
    $target = $null
    do {
        Start-Sleep -Seconds 2
        try { $targets = Invoke-RestMethod http://127.0.0.1:9222/json/list -TimeoutSec 3; $target = @($targets | Where-Object { $_.type -eq 'page' -and $_.url -notlike 'devtools:*' }) | Select-Object -First 1 } catch { }
    } while (!$target -and (Get-Date) -lt $deadline)
    if (!$target) { throw "Packaged app did not expose its renderer within $launchTimeout seconds." }
    $result.rendererWaitSeconds = [math]::Round(((Get-Date)-$launchStart).TotalSeconds,1)
    $result.attachedToExistingLaunch = [bool]$AttachExisting
    $script:socket = [Net.WebSockets.ClientWebSocket]::new()
    $script:messageId = 0
    $script:socket.ConnectAsync([Uri]$target.webSocketDebuggerUrl,[Threading.CancellationToken]::None).GetAwaiter().GetResult()
    Start-Sleep -Seconds 3
    $dom = Evaluate '({title:document.title,text:document.body.innerText,url:location.href,apiKeys:Object.keys(window.api||{})})'
    $dom | ConvertTo-Json -Depth 8 | Set-Content C:\TestExport\renderer.json -Encoding UTF8
    if ($dom.text.Length -lt 80 -or $dom.url -notlike 'file:*' -or $dom.apiKeys.Count -lt 1) { throw 'Renderer is blank, not packaged, or preload API is unavailable.' }
    $result.checks += 'packaged-renderer-and-preload-loaded'
    if ($recipe.app -eq '001_FileSync') {
        $dataPath = Evaluate 'window.api.app.userDataPath()'
        $expectedData = if ($folderMode) {'C:\Relocated app with spaces\data'} else {'C:\Smoke\data'}
        if ($dataPath -ne $expectedData) { throw "FileSync data is outside portable folder: $dataPath" }
        $result.checks += 'portable-user-data-path'
        'portable build fixture' | Set-Content C:\SmokeFixtures\A\hello.txt
        $sync = Evaluate '(async()=>{const api=window.api;const before=await api.jobs.list();const req={jobId:"portable-smoke",sideA:"C:\\SmokeFixtures\\A",sideB:"C:\\SmokeFixtures\\B",direction:"a-to-b",deleteExtraneous:false};const dry=await api.engine.dryRun(req);const applied=await api.engine.apply({...req,plan:dry.plan,trash:{enabled:true,retainDays:30},preserveTimestamps:true});const history=await api.history.list(req.jobId);return {before,dry,applied,history};})()'
        $sync | ConvertTo-Json -Depth 30 | Set-Content C:\TestExport\filesync-functional.json -Encoding UTF8
        if ($sync.applied.status -ne 'ok' -or $sync.applied.filesCopied -ne 1) { throw 'FileSync fixture sync did not succeed.' }
        if ((Get-Content C:\SmokeFixtures\B\hello.txt -Raw) -ne (Get-Content C:\SmokeFixtures\A\hello.txt -Raw)) { throw 'Synced fixture content differs.' }
        $result.checks += 'sql-wasm-database-initialized','fixture-analyzed-and-copied','history-api-called'
    }
    if ($recipe.app -eq '002_Sequence_Binding_Finder') {
        Add-Type -AssemblyName System.IO.Compression,System.IO.Compression.FileSystem
        $fixture = 'C:\SmokeFixtures\binding-fixture.xlsx'
        $zip = [IO.Compression.ZipFile]::Open($fixture,[IO.Compression.ZipArchiveMode]::Create)
        $parts = @{
            '[Content_Types].xml' = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'
            '_rels/.rels' = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
            'xl/workbook.xml' = '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sequences" sheetId="1" r:id="rId1"/></sheets></workbook>'
            'xl/_rels/workbook.xml.rels' = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
            'xl/worksheets/sheet1.xml' = '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="B1" t="inlineStr"><is><t>ID</t></is></c><c r="C1" t="inlineStr"><is><t>Sequence</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>PortableFixture</t></is></c><c r="B2" t="inlineStr"><is><t>001</t></is></c><c r="C2" t="inlineStr"><is><t>ACGTACGT</t></is></c></row></sheetData></worksheet>'
        }
        foreach ($name in $parts.Keys) { $entry=$zip.CreateEntry($name);$writer=[IO.StreamWriter]::new($entry.Open());$writer.Write($parts[$name]);$writer.Dispose() }
        $zip.Dispose()
        $bytes = [IO.File]::ReadAllBytes($fixture)
        $save = Evaluate ('window.api.writeXlsx("C:\\TestExport\\binding-saved.xlsx", [' + ($bytes -join ',') + '])')
        if (!$save -or !(Test-Path C:\TestExport\binding-saved.xlsx)) { throw 'Binding workbook write IPC failed.' }
        if ((Get-FileHash $fixture).Hash -ne (Get-FileHash C:\TestExport\binding-saved.xlsx).Hash) { throw 'Binding workbook bytes changed during save.' }
        $result.checks += 'xlsx-write-ipc-preserved-workbook'
        Evaluate '(()=>{const e=document.querySelector("textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(e,"TTTTACGTACGTGGGG");e.dispatchEvent(new Event("input",{bubbles:true}));return true;})()' | Out-Null
        $doc = Send-Cdp 'DOM.getDocument' @{}
        $fileNode = Send-Cdp 'DOM.querySelector' @{nodeId=$doc.root.nodeId;selector='input[type=file][accept=".xlsx,.xls"]'}
        Send-Cdp 'DOM.setFileInputFiles' @{nodeId=$fileNode.nodeId;files=@($fixture)} | Out-Null
        Start-Sleep -Seconds 2
        $loaded = Evaluate 'document.body.innerText'
        if ($loaded -notmatch '1 entries loaded') { throw 'Sequence workbook fixture did not load.' }
        Evaluate '(()=>{const b=[...document.querySelectorAll("button")].find(e=>e.innerText.includes("Run analysis"));if(!b||b.disabled)throw Error("Analysis button disabled");b.click();return true;})()' | Out-Null
        Start-Sleep -Seconds 3
        $analysis = Evaluate 'document.body.innerText'
        $analysis | Set-Content C:\TestExport\sequence-functional.txt -Encoding UTF8
        if ($analysis -notmatch 'PortableFixture' -or $analysis -notmatch '100(?:\.0+)?%') { throw 'Expected perfect-match alignment result was not rendered.' }
        $result.checks += 'xlsx-fixture-loaded','perfect-match-alignment-rendered'
        $result.exportNote = 'Workbook write IPC verified byte-for-byte; native save-dialog selection still requires manual acceptance.'
    }
    if ($recipe.app -in @('003_Gene_Synthesis_Hub','004_Peak_Tracer','005_KM_Plotter')) {
        $pagePath = ([Uri]$dom.url).LocalPath
        $asarIndex = $pagePath.IndexOf('app.asar',[StringComparison]::OrdinalIgnoreCase)
        if ($asarIndex -lt 0) { throw 'Cannot locate packaged resources.' }
        $resources = $pagePath.Substring(0,$asarIndex)
        $pythonApp = Join-Path $resources 'python-app'
        $python = Join-Path $pythonApp 'runtime\python.exe'
        if (!(Test-Path -LiteralPath $python)) { throw 'Bundled full Python interpreter is missing.' }
        $imports = 'import sys,numpy,tkinter; print(sys.prefix); print(numpy.__version__); t=tkinter.Tk(); t.update(); t.destroy()'
        if ($recipe.app -eq '003_Gene_Synthesis_Hub') { $imports = 'import sys,numpy,pandas,customtkinter,Bio,docx,PIL,pytesseract,win32com.client,importlib.util; print(sys.prefix); assert importlib.util.find_spec(''streamlit'') is None' }
        if ($recipe.app -eq '004_Peak_Tracer') { $imports += '; import scipy,Bio' }
        if ($recipe.app -eq '005_KM_Plotter') { $imports += '; import pandas,openpyxl' }
        & $python -I -c $imports 2>&1 | Out-File C:\TestExport\python-runtime-test.log
        if ($LASTEXITCODE -ne 0) { throw 'Relocated packaged Python imports or Tk initialization failed.' }
        if ($recipe.app -eq '003_Gene_Synthesis_Hub') {$result.checks += 'packaged-headless-python-imports-passed'} else {$result.checks += 'packaged-python-imports-and-tk-passed'}
        if ($recipe.app -eq '003_Gene_Synthesis_Hub') {
            $layout = Evaluate 'window.api.getLayout()'
            $layout | ConvertTo-Json -Depth 8 | Set-Content C:\TestExport\hub-layout.json -Encoding UTF8
            foreach ($required in @('worker.py','processors','app_information.txt','default_directories.ini','Code','Templates','Databases')) {
                if (!(Test-Path -LiteralPath (Join-Path $pythonApp $required))) { throw "Hub resource missing: $required" }
            }
            if ($layout.venvPythonExe -ne $python) { throw 'Hub still points at a nonrelocatable venv.' }
            $expectedConfig = if ($folderMode) {'C:\Relocated app with spaces\data\default_directories.ini'} else {'C:\Smoke\data\default_directories.ini'}
            if ($layout.dirConfigPath -ne $expectedConfig -or !(Test-Path $expectedConfig)) { throw 'Hub directory settings are not persistent beside the executable.' }
            $result.checks += 'persistent-hub-directory-config'
            $saved = Evaluate '(async()=>{const before=await window.api.loadConfig({});const key="Primer_Log";const original=before.paths[key].raw;const value="C:\\SmokeFixtures\\synthetic-primer-log.xlsx";const write=await window.api.saveConfig({[key]:value},{});const after=await window.api.loadConfig({});const restore=await window.api.saveConfig({[key]:original},{});return {write,restore,persisted:after.paths[key].raw===value};})()'
            if (!$saved.write.ok -or !$saved.restore.ok -or !$saved.persisted) {throw 'Hub directory config save/read regression failed.'}
            $result.checks += 'hub-directory-config-save-read-and-restore'
            $catalog = Evaluate '(async()=>{const c=await window.api.loadConfig({});return c.apps.map(a=>({name:a.name,category:a.category}));})()'
            if ($catalog.Count -ne 11 -or @($catalog | Where-Object category -ne 'react_route').Count) { throw 'Expected eleven native Hub tools.' }
            @'
from pathlib import Path
from openpyxl import Workbook
from docx import Document
import zipfile
r=Path('C:/SmokeFixtures')
book=Workbook();sheet=book.active;sheet.append(['12345678','BBI-PORTABLE','GeneOne','WORK-001',1200,'pUC57','EcoRI','P1234567','5ug','202610A001']);book.save(r/'shipping.xlsx')
book=Workbook();sheet=book.active;sheet.title='input addon';sheet.append(['Work No.','Insert Sequence','Final Vector Sequence']);sheet.append(['MAP-WRAP','GGAAA','AACGTGGA']);book.save(r/'maps.xlsx')
(r/'maps').mkdir(exist_ok=True)
(r/'qc-input').mkdir(exist_ok=True);(r/'qc-output').mkdir(exist_ok=True)
doc=Document();table=doc.add_table(rows=1,cols=2);table.cell(0,0).text='BBI ID';table.cell(0,1).text='BBI-PORTABLE';doc.save(r/'report.docx')
with zipfile.ZipFile(r/'qc-input/BBI-PORTABLE QC.zip','w') as z:z.write(r/'report.docx','BBI-PORTABLE QC/BBI-PORTABLE Gene Synthesis Report.docx')
(r/'rename.txt').write_text('BBI-PORTABLE\tBBI-RENAMED\n',encoding='utf-8')
'@ | Set-Content C:\SmokeFixtures\hub_fixtures.py -Encoding UTF8
            & $python -I -X utf8 C:\SmokeFixtures\hub_fixtures.py 2>&1 | Out-File C:\TestExport\hub-fixtures.log
            if ($LASTEXITCODE -ne 0) {throw 'Could not create Hub fixtures with bundled Python.'}
            $labels = Evaluate 'window.api.runPythonJob("smoke-labels","labels",{files:["C:/SmokeFixtures/shipping.xlsx"]})'
            if (!$labels.ok -or $labels.data.records.Count -ne 1 -or $labels.data.records[0].'Gene Name' -ne 'GeneOne') { throw 'Packaged label worker failed.' }
            $maps = Evaluate 'window.api.runPythonJob("smoke-maps","qc-design-bio",{primerLog:"C:/SmokeFixtures/maps.xlsx",outputFolder:"C:/SmokeFixtures/maps",workNos:["MAP-WRAP"]})'
            if (!$maps.ok -or !(Test-Path C:\SmokeFixtures\maps\MAP-WRAP.gb)) { throw 'Packaged GenBank worker failed.' }
            if ((Get-Content C:\SmokeFixtures\maps\MAP-WRAP.gb -Raw) -notmatch 'join\(6\.\.8,1\.\.2\)') {throw 'Packaged circular insert annotation failed.'}
            $prep = Evaluate 'window.api.runPythonJob("smoke-prep","qc-file-prep",{workflow:"internal",inputFolder:"C:/SmokeFixtures/qc-input",outputFolder:"C:/SmokeFixtures/qc-output",replacementFile:"C:/SmokeFixtures/rename.txt"})'
            if (!$prep.ok -or $prep.data.files[0].name -ne 'BBI-RENAMED QC.zip') {throw 'Packaged QC document/ZIP processing failed.'}
            @{labels=$labels;maps=$maps;qcPrep=$prep} | ConvertTo-Json -Depth 15 | Set-Content C:\TestExport\hub-worker-results.json -Encoding UTF8
            $native = Evaluate '(async()=>{const names=[...document.querySelectorAll(".gsh-tool-card h3")].map(e=>e.innerText);if(names.length!==11)throw Error("Wrong catalog");document.querySelector("[aria-label=\"Open QC Digestion Design\"]").click();return names;})()'
            Start-Sleep -Seconds 1
            $nativeText = Evaluate 'document.body.innerText'
            if ($nativeText -notmatch 'Create GenBank maps') {throw 'Packaged native QC interface did not open.'}
            $result.checks += 'eleven-native-tools','headless-label-parser','headless-circular-genbank','headless-qc-docx-zip-renaming','native-qc-route','no-streamlit-runtime'
            $workers = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -like '*worker.py*' })
            if ($workers.Count) {throw 'A completed Hub worker was left running.'}
            $result.checks += 'completed-workers-exited'
            $ocr = Join-Path $pythonApp 'tools\tesseract\tesseract.exe'
            & $ocr --version 2>&1 | Out-File C:\TestExport\tesseract-runtime-test.log
            if ($LASTEXITCODE -ne 0) { throw 'Bundled Tesseract did not run in the clean guest.' }
            @'
import sys
from PIL import Image, ImageDraw, ImageFont
import pytesseract
pytesseract.pytesseract.tesseract_cmd = sys.argv[1]
image = Image.new('RGB', (450, 120), 'white')
try:
    font = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 64)
except OSError:
    font = ImageFont.load_default(size=64)
ImageDraw.Draw(image).text((25, 15), '12345', font=font, fill='black')
text = pytesseract.image_to_string(image, config='--psm 7').strip()
print(text)
assert text == '12345', repr(text)
'@ | Set-Content C:\SmokeFixtures\ocr_smoke.py -Encoding UTF8
            & $python C:\SmokeFixtures\ocr_smoke.py $ocr 2>&1 | Out-File C:\TestExport\ocr-fixture.txt
            if ($LASTEXITCODE -ne 0) { throw 'Bundled OCR failed to recognize the numeric fixture.' }
            $result.checks += 'bundled-tesseract-started','offline-ocr-fixture-recognized'
            $result.externalDependencies = 'Legacy .doc conversion requires Microsoft Word; .docx needs no Word installation. Network drive workflows require the configured data locations.'
        }
        if ($recipe.app -eq '004_Peak_Tracer') {
            & $python (Join-Path $pythonApp 'peaktrace_core.py') --help 2>&1 | Out-File C:\TestExport\peaktrace-cli-help.txt
            if ($LASTEXITCODE -ne 0) { throw 'Packaged Peak Tracer CLI failed to start.' }
            @'
import sys, unittest
sys.path.insert(0, sys.argv[1])
suite = unittest.defaultTestLoader.discover(sys.argv[2], pattern='test_*.py')
assert suite.countTestCases() == 18, 'Expected all synthetic AB1 contracts'
result = unittest.TextTestRunner(stream=sys.stdout, verbosity=2).run(suite)
sys.exit(0 if result.wasSuccessful() else 1)
'@ | Set-Content C:\SmokeFixtures\run_contracts.py -Encoding UTF8
            & $python -I C:\SmokeFixtures\run_contracts.py $pythonApp C:\TestRunner\peak-tests 2>&1 | Out-File C:\TestExport\peaktrace-contracts.txt
            if ($LASTEXITCODE -ne 0) {throw 'Packaged synthetic AB1 contract tests failed.'}
            $result.checks += 'packaged-synthetic-ab1-contracts-18-passed'
            $result.checks += 'peaktrace-backend-cli-started'
        }
        if ($recipe.app -eq '005_KM_Plotter') {
            "PATIENT_ID`tOS_MONTHS`tOS_STATUS`r`nP1`t5`t1`r`nP2`t10`t0`r`nP3`t15`t1`r`nP4`t20`t0" | Set-Content C:\SmokeFixtures\clinical.tsv
            $km = Evaluate '(async()=>{const base={clinicalPath:"C:\\SmokeFixtures\\clinical.tsv",timeColumn:"OS_MONTHS",eventColumn:"OS_STATUS",eventValues:["1"],noEventValues:["0"],variables:[]};const info=await window.api.info();const inspect=await window.api.run({...base,command:"inspect"});const analysis=await window.api.run({...base,command:"analyze"});const exported=await window.api.run({...base,command:"export"});return {info,inspect,analysis,exported};})()'
            $km | ConvertTo-Json -Depth 50 | Set-Content C:\TestExport\km-functional.json -Encoding UTF8
            if (!$km.inspect.ok -or !$km.analysis.ok -or !$km.exported.ok -or !$km.exported.base64) { throw 'KM inspect, analysis, or workbook export fixture failed.' }
            [IO.File]::WriteAllBytes('C:\TestExport\km-fixture-results.xlsx',[Convert]::FromBase64String($km.exported.base64))
            Add-Type -AssemblyName System.IO.Compression,System.IO.Compression.FileSystem
            $workbook = [IO.Compression.ZipFile]::OpenRead('C:\TestExport\km-fixture-results.xlsx')
            try {
                if (!$workbook.GetEntry('xl/workbook.xml') -or @($workbook.Entries | Where-Object {$_.FullName -like 'xl/worksheets/sheet*.xml'}).Count -lt 1) { throw 'KM export is not a valid XLSX workbook structure.' }
            } finally { $workbook.Dispose() }
            $result.checks += 'clinical-fixture-inspected','km-analysis-completed','xlsx-workbook-exported-and-zip-valid'
        }
    }
    $screenshot = Send-Cdp 'Page.captureScreenshot' @{format='png';captureBeyondViewport=$false}
    [IO.File]::WriteAllBytes('C:\TestExport\screenshot.png',[Convert]::FromBase64String($screenshot.data))
    $result.status = 'smoke-passed'
    $result.limits = 'Automated checks cover renderer/preload and app-specific fixtures only; not a complete user acceptance test.'
} catch {
    $result.error = $_.ToString()
    if ($script:socket -and $script:socket.State -eq [Net.WebSockets.WebSocketState]::Open) {
        try { $failureScreenshot=Send-Cdp 'Page.captureScreenshot' @{format='png'}; [IO.File]::WriteAllBytes('C:\TestExport\screenshot.png',[Convert]::FromBase64String($failureScreenshot.data)) } catch {}
    }
} finally {
    $result.completedAt = (Get-Date).ToString('o')
    $result | ConvertTo-Json -Depth 15 | Set-Content C:\TestExport\smoke-result.tmp.json -Encoding UTF8
    Move-Item C:\TestExport\smoke-result.tmp.json C:\TestExport\smoke-result.json -Force
    if ($script:socket) { $script:socket.Dispose() }
}
# Keep the app visible for inspection. Host stops this specific Sandbox after reviewing exports.
