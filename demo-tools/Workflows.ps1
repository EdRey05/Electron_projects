param([string]$DemoApp)
switch($DemoApp){
 '001_FileSync'{
  Step 'Choose two disposable folders; keep extra files safe' "(()=>{const a=[...document.querySelectorAll('input')].filter(e=>e.type==='text');if(a.length<2)throw Error('Expected folder inputs');['C:\\DemoData\\sync\\source','C:\\DemoData\\sync\\destination'].forEach((v,i)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(a[i],v);a[i].dispatchEvent(new Event('input',{bubbles:true}))});const c=document.querySelector('input[type=checkbox]');if(c&&c.checked)c.click();return true})()"
  Step 'Analyze differences before copying' (Click 'Analyze') 4
  Step 'Run the reviewed copy plan' "(()=>{const a=[...document.querySelectorAll('button')].filter(e=>/^Run(?:\s|$|\()/.test(e.innerText.trim()));if(a.length!==1||a[0].disabled)throw Error('Run unavailable');a[0].click();return true})()" 5
  foreach($f in @('README.txt','reports\summary.csv','sequence.fasta')){if((Get-FileHash "C:\DemoData\sync\source\$f").Hash -ne (Get-FileHash "C:\DemoData\sync\destination\$f").Hash){throw 'FileSync output differs'}}
  Step 'Verified: destination files match source' '' 4
 }
 '002_Sequence_Binding_Finder'{
  Step 'Enter a synthetic reference sequence' (Fill 'textarea' 'TTTTACGTACGTGGCCTTAACCGGTTTT')
  LoadFile 'C:\DemoData\binding\candidates.xlsx'
  Step 'Load three synthetic sequence candidates' '' 3
  Step 'Compute forward and reverse-complement matches' (Click 'Run analysis') 5
  if((Eval 'document.body.innerText') -notmatch '100(?:\.0)?%'){throw 'Expected perfect match missing'}
  if(!(Test-Path C:\DemoData\exports\binding_results.xlsx)){throw 'Binding workbook was not saved'}
  Step 'Inspect alignments; results workbook saved' 'window.scrollTo({top:document.body.scrollHeight,behavior:"smooth"});true' 4
 }
 '003_Gene_Synthesis_Hub'{
  Step 'Browse the gene-synthesis workflow catalog' '' 3
  # Configure only the synthetic reference workflow; no company drives are needed.
  Eval '(async()=>{const c=await window.api.loadConfig({});return window.api.saveConfig({Primer_Log:"C:\\DemoData\\hub\\synthetic_primer_log.xlsx",Reference_Sequences:"C:\\DemoData\\hub\\output"},{})})()'|Out-Null
  Step 'Find Sequencing Reference Files' (Fill 'input[placeholder="Search apps…"]' 'Sequencing Reference')
  $card=Eval 'document.body.innerText'
  Step 'Open the reference-sequence exporter' "(()=>{const a=[...document.querySelectorAll('button')].filter(e=>e.innerText.trim()==='Launch'&&!e.disabled);if(a.length!==1)throw Error('Expected one enabled reference tool');a[0].click();return true})()" 3
  LoadFile 'C:\DemoData\hub\synthetic_primer_log.xlsx'
  Step 'Load a synthetic Primer Log workbook' '' 3
  Queue @('C:\DemoData\hub\output')
  Step 'Choose a disposable output folder' "(()=>{const a=[...document.querySelectorAll('button')].filter(e=>e.innerText.trim().startsWith('Select'));if(a.length!==2)throw Error('Expected file and folder selectors');a[1].click();return true})()" 3
  $d=Observe 'reference-ready'
  Step 'Export insert and final-vector sequences' "(()=>{const a=[...document.querySelectorAll('button')].filter(e=>e.innerText.includes('Export Sequences'));if(a.length!==1||a[0].disabled)throw Error('Exporter not ready');a[0].click();return true})()" 5
  if(@(Get-ChildItem C:\DemoData\hub\output -Filter *.txt).Count -ne 6){throw 'Expected six reference sequence files'}
  Step 'Verified: six sequence files created from three rows' '' 4
 }
 '004_Peak_Tracer'{
  Queue @('C:\DemoData\peak\input','C:\DemoData\peak\output')
  Step 'Choose three synthetic 160-base AB1 traces' "(()=>{const a=[...document.querySelectorAll('button')].filter(e=>e.innerText.trim()==='Pick');if(a.length!==2)throw Error('Expected two folder pickers');a[0].click();return true})()" 3
  Step 'Keep outputs separate from raw input' "(()=>{const a=[...document.querySelectorAll('button')].filter(e=>e.innerText.trim()==='Pick');a[1].click();return true})()" 3
  Step 'Use PT only for these clean synthetic filenames' "(()=>{const e=[...document.querySelectorAll('label,button,div')].find(e=>e.innerText.trim()==='PT only');if(!e)throw Error('PT mode option missing');e.click();return true})()" 2
  Step 'Process the traces using the bundled scientific core' "(()=>{const a=[...document.querySelectorAll('button')].filter(e=>/^Run(?:\s|$)/.test(e.innerText.trim()));if(a.length!==1||a[0].disabled)throw Error('Run not available');a[0].click();return true})()" 8
  if(@(Get-ChildItem C:\DemoData\peak\output -Recurse -Filter *.ab1).Count -lt 3){throw 'Expected processed AB1 outputs'}
  Step 'Inspect per-file QC and the processing log' 'window.scrollTo({top:document.body.scrollHeight,behavior:"smooth"});true' 4
 }
 '005_KM_Plotter'{
  Queue @('C:\DemoData\km\clinical_demo.tsv')
  Step 'Load a synthetic cohort of 80 patients' "(()=>{const a=[...document.querySelectorAll('button')].filter(e=>e.innerText.includes('Choose clinical file'));if(a.length!==1)throw Error('Clinical file button missing');a[0].click();return true})()" 4
  Step 'Map Alive to censored and Dead to observed events' "(()=>{for(const [v,t] of [['Alive','Label as no event (0)'],['Dead','Label as event (1)']]){const cell=[...document.querySelectorAll('td')].find(e=>e.title===v||e.innerText.trim()===v);if(!cell)throw Error('Status missing: '+v);const b=[...cell.closest('tr').querySelectorAll('button')].find(e=>e.title===t);b.click()}return true})()" 3
  Step 'Generate a Kaplan-Meier curve with confidence intervals' (Click 'Generate plot') 6
  if(!(Eval 'document.querySelector("svg") && document.body.innerText.includes("Median")')){throw 'Survival results not shown'}
  Step 'Review the survival curve and at-risk table' 'window.scrollTo({top:0,behavior:"smooth"});true' 4
  Step 'Export the computed survival data to Excel' "(()=>{const a=[...document.querySelectorAll('button')].filter(e=>/Excel|XLSX/.test(e.innerText));if(a.length!==1)throw Error('Excel export button missing');a[0].click();return true})()" 4
  if(@(Get-ChildItem C:\DemoData\exports -Filter *.xlsx).Count -lt 2){throw 'KM export missing'}
 }
}
