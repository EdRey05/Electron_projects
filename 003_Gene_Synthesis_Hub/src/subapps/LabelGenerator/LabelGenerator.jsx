import React,{useEffect,useMemo,useRef,useState} from 'react';
import {AppHeader,Panel,Button,DataTable,LogPanel,Tabs,Modal,C} from '../../ui/kit.jsx';
import {usePythonJob} from '../../ui/usePythonJob.js';
const key=row=>JSON.stringify([row.SO,row['BBI ID'],row['Plasmid No.']]);
export default function LabelGenerator({onBack,initialPaths={}}){
 const job=usePythonJob(),discovery=usePythonJob(),picker=useRef();
 const [files,setFiles]=useState([]),[records,setRecords]=useState([]),[columns,setColumns]=useState([]),[selected,setSelected]=useState([]),[query,setQuery]=useState(''),[tab,setTab]=useState('all'),[notice,setNotice]=useState('');
 const [baseReady,setBaseReady]=useState(false),[choices,setChoices]=useState(null),[dates,setDates]=useState(new Set());
 const base=initialPaths.shipping_list_path||'';
 const signature=JSON.stringify(files.map(f=>f.path));
 useEffect(()=>{let stale=false;setBaseReady(false);if(base)window.api.inspectPath({filePath:base,kind:'directory'}).then(result=>{if(!stale)setBaseReady(!!result.ok);});return()=>{stale=true;};},[base]);
 useEffect(()=>{
  let stale=false;setRecords([]);setNotice('');
  if(!files.length){setSelected([]);job.cancel();return;}
 job.run('labels',{files:files.map(f=>f.path)}).then(data=>{if(!stale&&data){setRecords(data.records);setColumns(data.columns);setNotice(`${data.records.length} constructs loaded.`);}});
 return()=>{stale=true;};
},[signature]);
const addFiles=added=>setFiles(old=>[...new Map([...old,...added].map(f=>[f.path.toLowerCase(),f])).values()]);
// Selected label rows keep CHECK ORDER like the Tk wishlist: existing keys
// stay put, newly checked rows append, unchecked rows leave. Keys that no
// longer resolve after a re-parse are pruned (upstream intersects).
const recordByKey=useMemo(()=>new Map(records.map(r=>[key(r),r])),[records]);
useEffect(()=>{setSelected(old=>{const pruned=old.filter(k=>recordByKey.has(k));return pruned.length===old.length?old:pruned;});},[recordByKey]);
const labels=useMemo(()=>selected.map(k=>recordByKey.get(k)).filter(Boolean),[selected,recordByKey]);
const filtered=useMemo(()=>{const tokens=query.toLowerCase().split(/\s+/).filter(Boolean);return records.filter(row=>tokens.every(token=>columns.some(c=>String(row[c]??'').toLowerCase().includes(token))));},[records,columns,query]);
const toggle=(row,checked)=>setSelected(old=>{if(checked)return old.includes(key(row))?old:[...old,key(row)];return old.filter(k=>k!==key(row));});
// The Tk clipboard writer is a csv.writer with a tab delimiter: fields
// holding tabs, quotes or newlines get quoted with doubled quotes.
const csvField=v=>{const text=String(v??'');return /[",\t\r\n]/.test(text)?'"'+text.replaceAll('"','""')+'"':text;};
const copy=async()=>{try{await navigator.clipboard.writeText(labels.map(row=>columns.map(c=>csvField(row[c]??'')).join('\t')).join('\n'));setNotice('Selected rows copied without headers.');}catch(error){setNotice(error.message);}};
 const save=async()=>{const cell=v=>/[",\r\n]/.test(String(v??''))?'"'+String(v??'').replaceAll('"','""')+'"':String(v??'');const text=[columns,...labels.map(r=>columns.map(c=>r[c]??''))].map(r=>r.map(cell).join(',')).join('\n')+'\n';await window.api.saveResultsCsv('Shipping_labels.csv',new TextEncoder().encode(text).buffer);};
 const discover=async()=>{const data=await discovery.run('labels-discover',{folder:base});if(data){setChoices(data.folders);setDates(new Set());}};
 const tableColumns=columns.map(c=>({key:c,label:c}));
 return <div className="h-full flex flex-col" style={{background:C.paper,color:C.ink}}><AppHeader title="Label Generator" subtitle="Sg Relabeling" onBack={onBack}/><main className="flex-1 overflow-auto p-6"><div className="max-w-7xl mx-auto space-y-4">
 <Panel title="Shipping lists" actions={<><Button disabled={discovery.running} onClick={()=>picker.current.click()}>Add</Button>{job.running&&<Button variant="danger" onClick={job.cancel}>Stop</Button>}<Button disabled={!files.length} onClick={()=>{setFiles([]);setSelected([]);setQuery('');}}>Clear files</Button><Button disabled={!baseReady||discovery.running||job.running} onClick={discover}>Autodiscovery</Button></>}>
 <input type="file" accept=".xlsx,.xls,.xlsm" multiple hidden ref={picker} onChange={event=>{addFiles(Array.from(event.target.files).map(f=>({name:f.name,path:window.api.getPathForFile(f)})).filter(f=>f.path));event.target.value='';}}/>
 {files.length?<ul>{files.map(f=><li key={f.path}>{f.name}</li>)}</ul>:<p>Choose shipping lists, or discover dated folders from the configured Shipping List path.</p>}
 <p role={job.error||discovery.error?'alert':'status'} style={{marginTop:10,color:job.error||discovery.error?C.coral:C.inkMuted}}>{job.error||discovery.error||(job.running?'Reading shipping lists…':notice||job.status)}</p>
 </Panel>
 <Tabs tabs={[{id:'all',label:`All · ${records.length}`},{id:'selected',label:`Selected · ${labels.length}`}]} active={tab} onChange={setTab}/>
 {tab==='all'?<Panel title="All constructs" actions={<><Button onClick={()=>setSelected(old=>[...new Set([...old,...filtered.map(key)])])} disabled={!filtered.length}>Check all shown</Button><Button onClick={()=>setSelected([])}>Clear checks</Button></>}>
 <input aria-label="Filter constructs" placeholder="Filter constructs…" value={query} onChange={e=>setQuery(e.target.value)} style={{padding:10,background:C.surface,border:'1px solid '+C.border,borderRadius:6,marginBottom:12}}/>
 <DataTable rows={filtered} columns={[{key:'select',label:'Check',render:r=><input aria-label={`Select ${r['BBI ID']} ${r['Plasmid No.']}`} type="checkbox" checked={selected.includes(key(r))} onChange={e=>toggle(r,e.target.checked)}/>},...tableColumns]}/>
 </Panel>:<Panel title="Selected label rows" actions={<><Button disabled={!labels.length} onClick={copy} variant="primary">Copy Selected</Button><Button disabled={!labels.length} onClick={save}>Save CSV</Button></>}><DataTable rows={labels} columns={tableColumns}/></Panel>}
 <details><summary>Processing log</summary><LogPanel logs={job.logs.concat(discovery.logs)}/></details>
 <Modal open={choices!==null} title="Discover shipping lists" onCancel={()=>setChoices(null)} footer={<><Button onClick={()=>setChoices(null)}>Cancel</Button><Button variant="primary" disabled={!dates.size} onClick={()=>{addFiles(choices.filter(c=>dates.has(c.date)).flatMap(c=>c.files.map(path=>({path,name:path.split(/[\\/]/).pop()}))));setChoices(null);}}>Proceed</Button></>}>
 {choices?.length?choices.map(c=><label key={c.date} className="block p-2"><input type="checkbox" checked={dates.has(c.date)} onChange={e=>setDates(old=>{const next=new Set(old);e.target.checked?next.add(c.date):next.delete(c.date);return next;})}/> {c.date} · {c.files.length} file(s)</label>):<p>No dated folders with shipping list files found.</p>}
 </Modal></div></main></div>;
}