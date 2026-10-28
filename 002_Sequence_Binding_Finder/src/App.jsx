import React, { useState, useRef, useEffect, useMemo } from "react";
import * as XLSX from "xlsx";
import { Dna, Upload, Play, CheckCircle2, XCircle, AlertTriangle, Download, RotateCcw, ChevronDown, ChevronUp } from "lucide-react";
import { inspectSequence, detectHeader, parseRows, parseFasta } from "./engine/input.mjs";
import { sortResults } from "./engine/search.mjs";
import { RESULT_COLUMNS, resultRows, csvText, filename, databaseRows } from "./engine/exports.mjs";

const THRESHOLDS = [80, 85, 90, 95, 100];
const palette = { ink: "#18372B", paper: "#C9DDD2", dark: "#12372E", primary: "#116B55", deep: "#0B5140", border: "#88A895", mint: "#A9DEC2", surface: "#DFEBE1", input: "#F2F5EF", muted: "#435F50", amber: "#865509", error: "#983D2D" };
const primary = { background: palette.primary, color: "white", borderColor: palette.primary };
const smallButton = "sbf-btn-primary sbf-small-button";
function StepTitle({ number, title, note }) {
  return <><div className="sbf-step-title flex items-center gap-2"><span className="sbf-mono sbf-step-number">{number}</span><h2 className="sbf-display text-base font-semibold">{title}</h2></div><p className="sbf-step-note text-xs">{note}</p></>;
}
function summary(entries) {
  if (!entries.length) return null;
  const lengths = entries.map(e => e.seq.length).sort((a,b) => a-b), categories = {};
  for (const entry of entries) { const category = (entry.provenance.match(/phage|adapter|primer|linker|plasmid|vector/i) || ["Other headers"])[0].toLowerCase(); categories[category] = (categories[category] || 0) + 1; }
  const middle = Math.floor(lengths.length / 2);
  return { median: lengths.length % 2 ? lengths[middle] : (lengths[middle-1]+lengths[middle])/2, categories: Object.entries(categories).sort((a,b)=>b[1]-a[1]).slice(0,5) };
}
export default function SequenceBindingFinder() {
  const [mode, setMode] = useState("database"), [reference, setReference] = useState(""), [refName, setRefName] = useState("");
  const [sheetRows, setSheetRows] = useState([]), [headerOverride, setHeaderOverride] = useState(null), [fileName, setFileName] = useState("");
  const [source, setSource] = useState("excel"), [fetchedEntries, setFetchedEntries] = useState([]), [fetchMeta, setFetchMeta] = useState(null);
  const [fetching, setFetching] = useState(false), [fetchProgress, setFetchProgress] = useState(null), [error, setError] = useState("");
  const [threshold, setThreshold] = useState(90), [results, setResults] = useState(null), [progress, setProgress] = useState(null), [status, setStatus] = useState("");
  const [onlyMatches, setOnlyMatches] = useState(true), [sortOrders, setSortOrders] = useState({database:"identity",screen:"identity"}), [expanded, setExpanded] = useState(null);
  const [version, setVersion] = useState({version:"1.2.0",buildDate:"development"});
  const fileInputRef = useRef(null), textInputRef = useRef(null), workerRef = useRef(null), fetchId = useRef(null), loadId = useRef(0);
  const running = progress !== null;
  const inspected = useMemo(() => inspectSequence(reference), [reference]);
  const firstHeader = headerOverride ?? detectHeader(sheetRows);
  const parsed = useMemo(() => parseRows(sheetRows, firstHeader), [sheetRows, firstHeader]);
  const entries = source === "ncbi" ? fetchedEntries : parsed.entries;
  const metadata = useMemo(() => source === "ncbi" ? summary(entries) : null, [source, entries]);
  const currentResults = useMemo(() => results ? sortResults(results.map(r=>({...r,status:r.identity===null?"error":r.identity>=threshold?"match":"no-match"})),sortOrders[mode]) : [], [results,threshold,sortOrders,mode]);
  const displayed = onlyMatches ? currentResults.filter(r=>r.status==="match") : currentResults;
  const counts = {high:currentResults.filter(r=>r.identity>=95).length,mid:currentResults.filter(r=>r.identity>=90&&r.identity<95).length,below:currentResults.filter(r=>r.identity===null||r.identity<90).length};
  const canRun = !!inspected.seq && !inspected.error && entries.length>0 && !fetching;
  function invalidate() { setResults(null); setExpanded(null); setStatus(""); setError(""); }
  function stop() { workerRef.current?.terminate(); workerRef.current=null;setProgress(null);setResults(null);setStatus("Analysis canceled."); }
  function reset() { workerRef.current?.terminate();workerRef.current=null;loadId.current++;setProgress(null);setReference("");setRefName("");setSheetRows([]);setHeaderOverride(null);setFileName("");setFetchedEntries([]);setFetchMeta(null);setSource("excel");setError("");setResults(null);setStatus("");setExpanded(null);if(fileInputRef.current)fileInputRef.current.value=""; }
  useEffect(() => { window.api?.getVersion?.().then(setVersion).catch(()=>{});return ()=>workerRef.current?.terminate(); }, []);
  async function handleFile(file) {
    const id=++loadId.current;invalidate();setFileName(file.name);setSource("excel");setSheetRows([]);
    try {const wb=XLSX.read(new Uint8Array(await file.arrayBuffer()),{type:"array"});const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,blankrows:false});if(id===loadId.current)setSheetRows(rows);}
    catch {if(id===loadId.current)setError("Could not read this Excel file.");}
  }
  async function loadText(file) {
    const id=++loadId.current;
    try {const loaded=file?{name:file.name,text:await file.text()}:await window.api?.loadText?.();if(!loaded||id!==loadId.current)return;const checked=inspectSequence(loaded.text,{file:true});if(checked.error)throw Error(checked.error);invalidate();setReference(checked.seq);setRefName(loaded.name.replace(/\.[^.]+$/,""));}
    catch(e){setError(e.message);}
  }
  async function saveWorkbook(database=false) {
    if(!database&&!results)return;
    try {
      const rows=database?databaseRows(entries):resultRows(currentResults);
      const header=database?["Name","Source / provenance","Sequence"]:RESULT_COLUMNS;
      const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([header,...rows]),database?"Reference database":"Results");
      const name=database?`NCBI_${fetchMeta?.source||"database"}.xlsx`:filename(refName|| (mode==="database"?"probe":"reference"));
      if(window.api?.saveResultsXlsx){const saved=await window.api.saveResultsXlsx(name,XLSX.write(wb,{bookType:"xlsx",type:"array"}));setStatus(saved?`Saved ${name}.`:saved===false?"Save failed.":"Save canceled.");}
      else {XLSX.writeFile(wb,name);setStatus("Workbook download requested.");}
    }catch(e){setError(`Save failed: ${e.message}`);}
  }
  async function exportCSV() {
    if(!results)return;
    try {const name=filename(refName||(mode==="database"?"probe":"reference"),"csv"),text=csvText(currentResults);
      if(window.api?.pickSavePath){const target=await window.api.pickSavePath(name);if(!target){setStatus("Save canceled.");return;}const saved=await window.api.writeXlsx(target,new TextEncoder().encode(text));setStatus(saved?`Saved ${name}.`:"Save failed.");}
      else {const url=URL.createObjectURL(new Blob([text],{type:"text/csv;charset=utf-8;"}));const a=document.createElement("a");a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setStatus("CSV download requested.");}
    }catch(e){setError(`Save failed: ${e.message}`);}
  }
  function runAnalysis() {
    if(running){stop();return;}if(!canRun)return;
    invalidate();const requestId=crypto.randomUUID(),worker=new Worker(new URL("./engine/search.worker.js",import.meta.url),{type:"module"});workerRef.current=worker;setProgress({done:0,total:entries.length});
    worker.onmessage=({data})=>{if(workerRef.current!==worker||data.requestId!==requestId)return;
      if(data.type==="progress")setProgress({done:data.done,total:data.total});
      else {worker.terminate();workerRef.current=null;setProgress(null);if(data.type==="complete"){setResults(data.results);setStatus("Results ready — use the Save buttons below to export.");setExpanded(null);}else setError(data.message);}
    };
    worker.onerror=e=>{if(workerRef.current!==worker)return;worker.terminate();workerRef.current=null;setProgress(null);setError(e.message||"Analysis failed.");};
    worker.postMessage({requestId,entries,pasted:inspected.seq,mode,threshold});
  }
  async function fetchDatabase(which,force=false) {
    if(!window.api?.fetchUnivec){setError("NCBI fetching is available in the desktop app.");return;}
    invalidate();setFetching(true);setFetchProgress(null);const requestId=crypto.randomUUID();fetchId.current=requestId;
    const off=window.api.onUnivecProgress?.(p=>{if(p.requestId===fetchId.current)setFetchProgress(p);});
    try {const meta=await window.api.fetchUnivec({which,force,requestId});const list=parseFasta(meta.fasta);loadId.current++;setFetchedEntries(list);setSource("ncbi");setFileName(`NCBI ${which}`);setFetchMeta({...meta,fasta:undefined});setStatus(`Loaded ${list.length.toLocaleString()} entries from NCBI ${which} (${(meta.bytes/1e6).toFixed(2)} MB downloaded, refreshed ${new Date(meta.fetchedAt).toLocaleString()}).`);if(meta.warning)setError(meta.warning);}
    catch(e){setError(`NCBI fetch failed: ${e.message}`);}finally{off?.();setFetching(false);fetchId.current=null;}
  }
  useEffect(()=>{const listener=e=>{if(e.target.closest?.("input,textarea,select,[contenteditable=true]"))return;
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="r"){e.preventDefault();runAnalysis();}
    else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="s"){e.preventDefault();if(!running)saveWorkbook();}
    else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="o"){e.preventDefault();if(!running&&!fetching)fileInputRef.current?.click();}
    else if(e.key==="Escape"&&!fetching){e.preventDefault();reset();}
  };window.addEventListener("keydown",listener);return()=>window.removeEventListener("keydown",listener);});
  const p=palette;
  const analysisTotal=progress?.total??results?.length??entries.length;
  const analysisDone=progress?.done??(results?results.length:0);
  const analysisState=running?"Searching":results?"Complete":status==="Analysis canceled."?"Canceled":canRun?"Ready":"Waiting";
  return <div className="sbf-app" style={{background:p.paper,color:p.ink,minHeight:"100%",fontFamily:"'IBM Plex Sans', sans-serif"}}><div className="sbf-shell">
    <header className="sbf-header flex items-start justify-between border-b" style={{borderColor:p.border}}><div className="flex items-center gap-3"><div className="sbf-logo"><Dna size={22} color={p.mint}/></div><div><h1 className="sbf-display text-2xl font-semibold tracking-tight">Binding Search</h1><p className="text-sm mt-0.5">Ungapped sequence identity · both orientations · masked N bases</p></div></div><button onClick={reset} disabled={fetching} className={smallButton} style={primary}><RotateCcw size={14}/>Reset</button></header>
    <div className="sbf-modes" role="tablist" aria-label="Search mode" onKeyDown={e=>{if(running||fetching||!["ArrowLeft","ArrowRight","Home","End"].includes(e.key))return;e.preventDefault();const next=e.key==="Home"?"database":e.key==="End"?"screen":mode==="database"?"screen":"database";setMode(next);invalidate();document.getElementById(`mode-${next}`)?.focus();}}><button id="mode-database" role="tab" aria-controls="mode-inputs" aria-selected={mode==="database"} tabIndex={mode==="database"?0:-1} disabled={running||fetching} onClick={()=>{setMode("database");invalidate();}}>Search sequence against a database</button><button id="mode-screen" role="tab" aria-controls="mode-inputs" aria-selected={mode==="screen"} tabIndex={mode==="screen"?0:-1} disabled={running||fetching} onClick={()=>{setMode("screen");invalidate();}}>Screen candidates against a reference</button></div>
    <div className="sbf-setup-grid" id="mode-inputs" role="tabpanel" aria-labelledby={`mode-${mode}`}>
      <section className="sbf-setup-section"><StepTitle number="01" title={mode==="database"?"Probe sequence":"Reference sequence"} note={mode==="database"?"Paste one sequence · guidance: up to 100 kb":"Screen Excel candidates · guidance: up to 100 kb"}/>
        <div className="sbf-reference border rounded-lg overflow-hidden" style={{borderColor:p.border}}><input type="text" value={refName} disabled={running} onChange={e=>{setRefName(e.target.value);}} placeholder={mode==="database"?"Probe name (optional)":"Reference name (optional)"} className="w-full px-4 py-2 text-sm outline-none border-b" style={{borderColor:p.border,background:p.input}}/>
          <textarea className="sbf-textarea sbf-mono w-full px-4 py-3 text-xs outline-none resize-none" style={{background:p.dark,color:"#EAF3F1",lineHeight:1.6}} value={reference} disabled={running} onChange={e=>{setReference(e.target.value);invalidate();}} placeholder="Paste sequence only (ACGT / ACGU / N)" rows={6}/>
          <div className="sbf-base-count">{inspected.seq.length.toLocaleString()} valid bp</div></div>
        <button className={smallButton+" sbf-load-text"} style={primary} disabled={running||fetching} onClick={()=>window.api?.loadText?loadText():textInputRef.current?.click()}>Load from .fasta/.txt</button><input type="file" accept=".fa,.fasta,.fna,.txt" className="hidden" ref={textInputRef} onChange={e=>e.target.files?.[0]&&loadText(e.target.files[0])}/>
        {inspected.error&&<p className="sbf-error">{inspected.error}</p>}{inspected.notices.map(n=><p className="sbf-notice" key={n}>{n}</p>)}
      </section>
      <section className="sbf-setup-section"><StepTitle number="02" title={mode==="database"?"Reference database":"Sequences to test"} note="Columns A + B: name · C: sequence"/>
        <div className="sbf-drop rounded-lg border-2 border-dashed flex flex-col items-center justify-center text-center cursor-pointer transition-colors" style={{borderColor:p.border,background:p.input}} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();if(!running&&!fetching&&e.dataTransfer.files[0])handleFile(e.dataTransfer.files[0]);}} onClick={()=>!running&&!fetching&&fileInputRef.current?.click()}><Upload size={22} color={p.primary} className="mb-2"/><p className="text-sm font-medium">{fileName||(mode==="database"?"Drop the reference database .xlsx":"Drop candidates .xlsx or click to browse")}</p>{entries.length>0&&<p className="text-xs mt-1">{entries.length.toLocaleString()} entries loaded</p>}<input ref={fileInputRef} disabled={running||fetching} type="file" accept=".xlsx,.xls" className="hidden" onChange={e=>e.target.files?.[0]&&handleFile(e.target.files[0])}/></div>
        {source==="excel"&&<label className="sbf-header-toggle"><input type="checkbox" checked={firstHeader} disabled={running} onChange={e=>{setHeaderOverride(e.target.checked);invalidate();}}/>First row is a header</label>}
        {source==="excel"&&parsed.skipped.length>0&&<p className="sbf-notice">{parsed.skipped.length} row(s) skipped: {parsed.skipped.slice(0,3).join(", ")}</p>}
        {mode==="database"&&<>
        {metadata&&<div className="sbf-database-summary"><strong>{entries.length.toLocaleString()} entries · median {metadata.median.toLocaleString()} bp</strong><div>Last refreshed {Math.max(0,Math.floor((Date.now()-fetchMeta.fetchedAt)/3600000))}h ago {fetchMeta.cached?"· cached":""}</div><div>{metadata.categories.map(([n,c])=>`${n}: ${c}`).join(" · ")}</div></div>}
        <div className="sbf-fetch-buttons"><button className={smallButton} style={primary} disabled={fetching||running} onClick={()=>fetchDatabase("UniVec")}>Fetch UniVec</button><button className={smallButton} style={primary} disabled={fetching||running} onClick={()=>fetchDatabase("UniVec_Core")}>Fetch UniVec_Core</button><button className={smallButton} style={primary} disabled={fetching||running||source!=="ncbi"} title={source!=="ncbi"?"Fetch an NCBI database first":undefined} onClick={()=>saveWorkbook(true)}>Save as Excel</button><button className={smallButton} style={primary} disabled={fetching||running||source!=="ncbi"} title={source!=="ncbi"?"Fetch an NCBI database first":undefined} onClick={()=>fetchDatabase(fetchMeta.source,true)}>Refresh now</button></div>
        {fetching&&<p className="sbf-notice" role="status">Downloading from NCBI… {fetchProgress?`${(fetchProgress.bytes/1e6).toFixed(2)} MB`:""}</p>}
</>}
      </section>

    </div>
    <section className="sbf-analysis" aria-label="Analysis controls">
      <div className="sbf-analysis-toolbar">
        <div className="sbf-analysis-heading"><StepTitle number="03" title="Identity threshold" note="Choose the minimum identity"/>
          <div className="sbf-progress" data-state={analysisState.toLowerCase()}><div className="sbf-progress-caption" role="status"><span className="sbf-progress-state">{results?<CheckCircle2 size={12} aria-hidden="true"/>:<span className="sbf-progress-dot" aria-hidden="true"/>}{analysisState}</span><span>{analysisTotal?`${analysisDone.toLocaleString()} / ${analysisTotal.toLocaleString()} entries`:"0 entries"}</span></div><progress max={analysisTotal||1} value={analysisDone} aria-label="Analysis progress"/></div>
        </div>
        <div className="sbf-analysis-threshold"><div className="sbf-thresholds rounded-md overflow-hidden border" style={{borderColor:p.border}}>{THRESHOLDS.map(t=><button key={t} aria-pressed={threshold===t} disabled={running} onClick={()=>setThreshold(t)} style={{background:threshold===t?p.primary:p.input,color:threshold===t?"white":p.ink,borderRight:t!==100?`1px solid ${p.border}`:"none"}}>{t}%</button>)}</div>
          <label className="sbf-slider-label">Custom: <output>{threshold}%</output><input type="range" min="50" max="100" step="1" value={threshold} disabled={running} onChange={e=>setThreshold(Number(e.target.value))} aria-label="Identity threshold"/></label>
        </div>
        <div className="sbf-analysis-action"><button className="sbf-run sbf-btn-primary flex items-center gap-2 rounded-md text-sm font-semibold" style={primary} disabled={!running&&!canRun} onClick={runAnalysis}><Play size={15}/>{running?"Stop":"Run analysis"}</button></div>
      </div>
      <div className="sbf-analysis-status" aria-label="Analysis messages" tabIndex={status||error?0:-1}>
        <p className={error?"sbf-error":"sbf-status"} role={error?"alert":"status"}>{error||status||(running?"Searching sequences…":canRun?"Ready to analyze.":"Load inputs to begin.")}</p>
      </div>
    </section>
    <section className="sbf-results" data-state={results?"ready":running?"running":"empty"}><div className="sbf-results-header"><div className="flex items-center gap-2"><span className="sbf-mono sbf-step-number">04</span><h2 className="sbf-display text-base font-semibold">Results</h2><span className="sbf-result-count">{results?`${currentResults.filter(r=>r.status==="match").length} / ${currentResults.length} ≥ ${threshold}%`:"Not analyzed"}</span></div><div className="sbf-result-actions"><label><input type="checkbox" disabled={!results} checked={onlyMatches} onChange={e=>setOnlyMatches(e.target.checked)}/> Show matches only</label><select disabled={!results} aria-label="Result order" value={sortOrders[mode]} onChange={e=>setSortOrders({...sortOrders,[mode]:e.target.value})}><option value="identity">Identity (high→low)</option><option value="original">Original order</option></select><button className={smallButton} style={primary} disabled={!results} onClick={()=>saveWorkbook()}><Download size={13}/>Save .xlsx…</button><button className={smallButton} style={primary} disabled={!results} onClick={exportCSV}><Download size={13}/>Save .csv…</button></div></div>
      <p className="sbf-distribution">{results?`${counts.high} ✓ high (≥95%) · ${counts.mid} ~ mid (90–95%) · ${counts.below} ✗ below 90%`:"Identity · orientation · position · coverage"}</p>
      <div className="sbf-results-list rounded-lg border overflow-hidden" style={{borderColor:p.border}}>{!results?<div className="sbf-results-empty" role="status"><Dna size={26} aria-hidden="true"/><strong>{running?"Searching sequences…":"Results will appear here"}</strong><span>{running?"Progress is shown above. You can stop at any time.":"Load your inputs, then run analysis."}</span></div>:displayed.length===0?<div className="py-10 text-center text-sm">No sequence reaches the {threshold}% threshold.</div>:displayed.map(r=>{const isOpen=expanded===r.inputOrder, axis=r.hitAxis==="probe"?"probe":mode==="database"?"database entry":"reference";return <div key={r.inputOrder} className="sbf-result" data-entry={r.label||r.name}><div className="sbf-row flex items-center gap-3 px-4 py-3 cursor-pointer" onClick={()=>setExpanded(isOpen?null:r.inputOrder)}>
        {r.status==="match"?<CheckCircle2 size={17} color={p.primary}/>:r.status==="error"?<AlertTriangle size={17} color={p.error}/>:<XCircle size={17} color={p.amber}/>}
        <div className="min-w-0 flex-1"><div className="sbf-result-name text-sm font-medium truncate">{r.label||r.name}</div><div className="sbf-result-detail">{r.error||`${r.orientation==="revcomp"?"Reverse complement":"Forward"} · ${axis} ${r.hitStart}–${r.hitEnd} · ${r.hitLength} bp · coverage ${r.coverage.toFixed(1)}%`}</div>{r.provenance&&<div className="sbf-provenance truncate" title={r.provenance}>{r.provenance}</div>}<div className="sbf-sequence-preview sbf-mono">{r.seq.slice(0,30)}{r.seq.length>30?"…":""}</div></div>
        <span className="sbf-identity" style={{color:r.status==="match"?p.deep:p.amber}}>{r.identity===null?"N/A":`${r.identity.toFixed(2)}%`}</span>{isOpen?<ChevronUp size={16}/>:<ChevronDown size={16}/>}</div>
        {isOpen&&<div className="sbf-expanded"><div className="sbf-alignment sbf-scroll sbf-mono" aria-label="Aligned bases">{[...(r.probeSegment||"").slice(0,200)].map((base,i)=><span key={i} style={{color:base==="N"||r.referenceSegment[i]==="N"?"#B1BDB7":base===r.referenceSegment[i]?"#9EE2C5":"#F3C36B"}}>{base}</span>)}</div><p className="sbf-result-detail">{axis} {r.hitStart}–{r.hitEnd} · {r.orientation} · {r.compared??0} compared · {r.masked??0} masked · amber: mismatch · gray: N</p><p className="sbf-full-preview sbf-mono">{r.seq.slice(0,200)}{r.seq.length>200?"…":""}</p><button className={smallButton} style={primary} onClick={async()=>{try{await navigator.clipboard.writeText(r.seq);setStatus("Sequence copied.");}catch{setError("Clipboard unavailable.");}}}>Copy sequence</button>{r.seq.length>=32000&&<p className="sbf-notice">Excel sequence cell is truncated to 32,000 bp.</p>}</div>}
      </div>})}</div>
    </section>
    <footer className="sbf-footer">v{version.version} · built {version.buildDate} · ungapped identity screening, not a binding-affinity prediction</footer>
  </div></div>;
}