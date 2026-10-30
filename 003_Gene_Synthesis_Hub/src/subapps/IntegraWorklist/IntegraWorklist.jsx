import React,{useState} from 'react';
import {AppHeader,Button,Panel,Tabs,DataTable,C} from '../../ui/kit.jsx';
import {FIELDS,LABELS,WELLS,parsePaste,buildBulk,transfer,worklistCsv,validationCsv,validationRows} from './engine.mjs';

export default function IntegraWorklist({onBack}) {
  const [mode,setMode]=useState('bulk'),[paste,setPaste]=useState(''),[input,setInput]=useState([]);
  const [outputs,setOutputs]=useState({bulk:[],single:[]});const rows=outputs[mode];
  const setRows=value=>setOutputs(previous=>({...previous,[mode]:typeof value==='function'?value(previous[mode]):value}));
  const [options,setOptions]=useState({source:'B',target:'C',volume:85,pool:true,autoWells:true,autoSort:true});
  const [workNo,setWorkNo]=useState(''),[sourceWell,setSourceWell]=useState(''),[targetWell,setTargetWell]=useState('');
  const [name,setName]=useState('integra_worklist'),[error,setError]=useState(''),[status,setStatus]=useState('');
  const change=(key,value)=>{setOptions(o=>({...o,[key]:value}));if(mode==='bulk')setRows([]);setError('');};
  const save=async(text,suffix)=>{
    try {const ok=await window.api.saveResultsCsv((name.trim()||'integra_worklist')+suffix+'.csv',new TextEncoder().encode(text).buffer);setStatus(ok?'Saved.':'Save canceled.');}
    catch(e){setError(e.message);}
  };
  const generate=()=>{try{setRows(buildBulk(input,options));setError('');setStatus('Worklist ready.');}catch(e){setRows([]);setError(e.message);}};
  const add=()=>{try{const row=transfer({work_no:workNo,Source_well:sourceWell,Target_well:targetWell},options);setRows(old=>[...old,row]);setSourceWell('');setTargetWell('');setError('');setStatus('Sample added.');}catch(e){setError(e.message);}};
  const wellGrid=(columns,selected,onSelect,label)=><Panel title={label}><div style={{display:'grid',gridTemplateColumns:`repeat(${columns},minmax(0,1fr))`,gap:4}}>{'ABCDEFGH'.split('').flatMap(r=>Array.from({length:columns},(_,c)=>r+(c+1))).map(w=><button key={w} aria-label={`${label} ${w}`} aria-pressed={selected===w} onClick={()=>onSelect(w)} style={{padding:'8px 2px',border:'1px solid '+C.border,borderRadius:4,background:selected===w?C.navy:C.subtle,color:selected===w?'white':C.ink,fontSize:14}}>{w}</button>)}</div></Panel>;
  return <div className="h-full flex flex-col" style={{background:C.paper,color:C.ink}}>
    <AppHeader title="Integra Worklist" subtitle="Prepare transfer worklists and validation data" onBack={onBack}/>
    <main className="flex-1 overflow-auto p-6"><div className="max-w-7xl mx-auto space-y-4">
      <Tabs tabs={[{id:'bulk',label:'Bulk mode'},{id:'single',label:'Single entries'}]} active={mode} onChange={next=>{setMode(next);setStatus('');setError('');}}/>
      <Panel title="Transfer settings"><div className="flex gap-6 items-center flex-wrap">
        {['source','target'].map(key=><label key={key}>{key==='source'?'Source spot':'Target spot'} <select aria-label={`${key} spot`} value={options[key]} onChange={e=>change(key,e.target.value)} style={{padding:8,background:C.surface,border:'1px solid '+C.border,borderRadius:5}}>{['A','B','C'].map(v=><option key={v}>{v}</option>)}</select></label>)}
        <label>Volume (µL) <input aria-label="Transfer volume" type="number" min="5" max="200" step="5" value={options.volume} onChange={e=>change('volume',Number(e.target.value))} style={{width:85,padding:8,background:C.surface,border:'1px solid '+C.border,borderRadius:5}}/></label>
        {mode==='bulk'&&[['pool','Pool replicates'],['autoWells','Auto-assign wells'],['autoSort','Sort by reactions']].map(([key,label])=><label key={key}><input type="checkbox" checked={options[key]} onChange={e=>change(key,e.target.checked)}/> {label}</label>)}
      </div></Panel>
      {mode==='bulk'?<>
        <Panel title="Samples" subtitle="Paste Excel rows, with or without the header row." actions={<Button onClick={()=>navigator.clipboard.writeText(LABELS.join('\t'))}>Copy headers</Button>}>
          <textarea aria-label="Paste samples" rows={4} value={paste} onChange={e=>setPaste(e.target.value)} placeholder={LABELS.join(' · ')} style={{width:'100%',padding:12,background:C.surface,border:'1px solid '+C.border,borderRadius:6,fontSize:15}}/>
          <div className="flex gap-3 mt-3"><Button onClick={()=>{setInput(parsePaste(paste));setRows([]);setError('');}}>Load rows</Button><Button variant="primary" disabled={!input.length} onClick={generate}>Create worklist</Button><span>{input.length} / 96 rows</span></div>
          {!!input.length&&<div className="overflow-auto mt-3"><table style={{fontSize:14,width:'100%'}}><thead><tr>{LABELS.map((label,i)=><th key={label} style={{padding:6,textAlign:'left',minWidth:i===2?160:115}}>{label}</th>)}</tr></thead><tbody>{input.map((row,index)=><tr key={index}>{FIELDS.map(key=><td key={key}><input aria-label={`${LABELS[FIELDS.indexOf(key)]} row ${index+1}`} value={row[key]} onChange={e=>{setInput(old=>old.map((r,i)=>i===index?{...r,[key]:e.target.value}:r));setRows([]);}} style={{width:'100%',padding:7,background:C.surface,border:'1px solid '+C.border}}/></td>)}</tr>)}</tbody></table></div>}
        </Panel>
      </>:<>
        <Panel title="Sample"><div className="flex gap-4 items-center flex-wrap"><label>Work No. <input aria-label="Work No." value={workNo} onChange={e=>setWorkNo(e.target.value)} style={{padding:9,background:C.surface,border:'1px solid '+C.border,borderRadius:5}}/></label><span>From {sourceWell||'—'} → {targetWell||'—'}</span><Button variant="primary" onClick={add}>Add sample</Button></div></Panel>
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4"><div className="xl:col-span-2">{wellGrid(12,sourceWell,setSourceWell,'Source well')}</div>{wellGrid(6,targetWell,setTargetWell,'Target well')}</div>
      </>}
      <div style={{minHeight:30}} role={error?'alert':'status'}><span style={{color:error?C.coral:C.inkMuted}}>{error||status}</span></div>
      <Panel title="Worklist" actions={<Button disabled={!rows.length} onClick={()=>setRows([])}>Clear</Button>}>
        <DataTable rows={rows} columns={[{key:'work_no',label:'Work No.'},{key:'Source_spot',label:'Source spot'},{key:'Source_well',label:'Source well'},{key:'Target_spot',label:'Target spot'},{key:'Target_well',label:'Target well'},{key:'Transfer_volume',label:'µL'}]}/>
        <div className="flex gap-3 items-center mt-4 flex-wrap"><label>File name <input aria-label="File name" value={name} onChange={e=>setName(e.target.value)} style={{padding:8,background:C.surface,border:'1px solid '+C.border,borderRadius:5}}/></label><Button variant="primary" disabled={!rows.length} onClick={()=>save(worklistCsv(rows),'')}>Save worklist</Button>{mode==='bulk'&&<Button variant="primary" disabled={!rows.length} onClick={()=>save(validationCsv(rows,options.pool),'_validation')}>Save validation</Button>}</div>
      </Panel>
      {mode==='bulk'&&!!rows.length&&<Panel title="Validation preview"><DataTable rows={validationRows(rows,options.pool).map(values=>Object.fromEntries(values.map((v,i)=>[FIELDS[i],v])))} columns={FIELDS.slice(0,8).map((key,i)=>({key,label:LABELS[i]}))}/></Panel>}
    </div></main>
  </div>;
}
