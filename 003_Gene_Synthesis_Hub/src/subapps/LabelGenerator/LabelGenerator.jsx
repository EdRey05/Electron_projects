import React,{useRef,useState} from 'react';
import {AppHeader,Panel,Button,DataTable,LogPanel,C} from '../../ui/kit.jsx';
import {usePythonJob} from '../../ui/usePythonJob.js';
const key=row=>JSON.stringify([row.SO,row['BBI ID'],row['Plasmid No.'],row['Gene Name']]);
export default function LabelGenerator({onBack}) {
  const job=usePythonJob(),picker=useRef();
  const [files,setFiles]=useState([]),[records,setRecords]=useState([]),[columns,setColumns]=useState([]),[selected,setSelected]=useState(new Set()),[labels,setLabels]=useState([]),[notice,setNotice]=useState('');
  const read=async()=>{setRecords([]);setSelected(new Set());setNotice('');const data=await job.run('labels',{files:files.map(f=>f.path)});if(data){setRecords(data.records);setColumns(data.columns);setSelected(new Set());setNotice('Select constructs to add.');}};
  const add=all=>{const next=all?records:records.filter(r=>selected.has(key(r)));setLabels(old=>[...new Map([...old,...next].map(r=>[key(r),r])).values()]);setNotice(`${next.length} construct(s) added.`);};
  const copy=async()=>{try{const text=[columns,...labels.map(row=>columns.map(c=>row[c]??''))].map(r=>r.join('\t')).join('\n');await navigator.clipboard.writeText(text);setNotice('Copied with headers.');}catch(error){setNotice(error.message);}};
  const save=async()=>{const cell=v=>/[",\r\n]/.test(String(v??''))?'"'+String(v??'').replaceAll('"','""')+'"':String(v??'');const text=[columns,...labels.map(r=>columns.map(c=>r[c]??''))].map(r=>r.map(cell).join(',')).join('\n')+'\n';try{const ok=await window.api.saveResultsCsv('Shipping_labels.csv',new TextEncoder().encode(text).buffer);setNotice(ok?'Saved.':'Save canceled.');}catch(error){setNotice(error.message);}};
  const tableColumns=columns.map(c=>({key:c,label:c}));
  return <div className="h-full flex flex-col" style={{background:C.paper,color:C.ink}}><AppHeader title="Label Generator" subtitle="Prepare shipping-label rows from Sg shipping lists" onBack={onBack}/>
    <main className="flex-1 overflow-auto p-6"><div className="max-w-7xl mx-auto space-y-4">
      <Panel title="Shipping lists" actions={<><Button disabled={job.running} onClick={()=>picker.current.click()}>Add files</Button><Button disabled={job.running||!files.length} onClick={()=>setFiles([])}>Clear files</Button></>}>
        <input type="file" accept=".xlsx,.xls" multiple hidden ref={picker} onChange={event=>{const added=Array.from(event.target.files).map(f=>({name:f.name,path:window.api.getPathForFile(f)})).filter(f=>f.path);setFiles(old=>[...new Map([...old,...added].map(f=>[f.path.toLowerCase(),f])).values()]);event.target.value='';setRecords([]);setSelected(new Set());}}/>
        {files.length?<ul>{files.map(f=><li key={f.path} style={{padding:'4px 0',fontSize:16}}>{f.name}</li>)}</ul>:<p>Choose one or more XLS/XLSX shipping lists.</p>}
        <div className="flex gap-3 mt-3"><Button variant="primary" disabled={!files.length||job.running} onClick={read}>Read shipping lists</Button>{job.running&&<Button variant="danger" onClick={job.cancel}>Stop</Button>}</div>
      </Panel>
      <div style={{minHeight:28,color:job.error?C.coral:C.inkMuted}} role={job.error?'alert':'status'}>{job.error||(job.running?job.status:notice||job.status)}</div>
      <Panel title="Available constructs" actions={<><Button disabled={!selected.size} onClick={()=>add(false)}>Add selected</Button><Button disabled={!records.length} onClick={()=>add(true)}>Add all</Button></>}>
        <DataTable rows={records} columns={[{key:'select',label:'Select',render:r=><input aria-label={`Select ${r['BBI ID']}`} type="checkbox" checked={selected.has(key(r))} onChange={e=>setSelected(old=>{const next=new Set(old);e.target.checked?next.add(key(r)):next.delete(key(r));return next;})}/>} ,...tableColumns]}/>
      </Panel>
      <Panel title={`Label rows · ${labels.length}`} actions={<><Button disabled={!labels.length} onClick={()=>setLabels([])}>Clear labels</Button><Button variant="primary" disabled={!labels.length} onClick={copy}>Copy labels</Button><Button variant="primary" disabled={!labels.length} onClick={save}>Save CSV</Button></>}><DataTable rows={labels} columns={tableColumns}/></Panel>
      <details><summary style={{cursor:'pointer'}}>Processing log</summary><LogPanel logs={job.logs}/></details>
    </div></main></div>;
}
