import React,{useEffect,useState} from 'react';
import {AppHeader,Panel,Button,PathInput,DataTable,LogPanel,C} from '../../ui/kit.jsx';
import {ValidatedPath} from '../../ui/ValidatedPath.jsx';
import {usePythonJob} from '../../ui/usePythonJob.js';

export default function UploadPrep({onBack,initialPaths,workflows,onWorkflowChange}){
 const [workbook,setWorkbook]=useState(initialPaths.job_log_path||''),[output,setOutput]=useState(''),[received,setReceived]=useState(initialPaths.output_folder||''),[shipping,setShipping]=useState(initialPaths.shipping_list_path||''),[date,setDate]=useState(''),[data,setData]=useState(null),[checked,setChecked]=useState(new Set()),[revision,setRevision]=useState(0),[done,setDone]=useState(null);
 const job=usePythonJob();
 useEffect(()=>{let stale=false;window.api.getLayout().then(layout=>{if(!stale)setOutput(layout.desktopFolder.replace(/[\\/]+$/,'')+'/QC_to_upload');});return()=>{stale=true;};},[]);
 const request=()=>({workbook,outputFolder:output,date,paths:{QC_Output_Folder:received,Shipping_List:shipping}});
 useEffect(()=>{
  let stale=false;setData(null);setChecked(new Set());setDone(null);
  if(!workbook||!output)return;
  const timer=setTimeout(()=>job.run('qc-upload',request()).then(result=>{if(!stale&&result){setData(result);setChecked(new Set(result.rows.map(row=>row.index)));}}),400);
  return()=>{stale=true;clearTimeout(timer);};
 },[workbook,output,received,shipping,date,revision]);
 const run=async()=>{setDone(null);const result=await job.run('qc-upload',{...request(),date:data.date,stamp:data.stamp,execute:true,checked:[...checked]});if(result)setDone(result);};
 const field=(label,value,setValue,kind='directory')=><Panel title={label}><ValidatedPath aria-label={label} value={value} kind={kind} requiredSheets={kind==='file'?['Master Shipping Log']:[]} readOnly={false} disabled={job.running} onChange={setValue}><Button disabled={job.running} onClick={async()=>{const path=kind==='file'?await window.api.chooseFile({filter:'.xlsx'}):await window.api.chooseOutputDir(value);if(path)setValue(path);}}>Browse</Button></ValidatedPath></Panel>;
 return <div className="h-full flex flex-col" style={{background:C.paper,color:C.ink}}><AppHeader title="QC File Prep" subtitle="Upload Prep" onBack={onBack}/><main className="flex-1 overflow-auto p-6"><div className="max-w-7xl mx-auto space-y-4">
 <Panel title="Workflow"><select aria-label="QC workflow" value="upload" disabled={job.running} onChange={e=>onWorkflowChange(e.target.value)} style={{padding:12,width:'100%',background:C.surface}}>{workflows.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></Panel>
 {field('In-House Progress workbook',workbook,setWorkbook,'file')}
 <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">{field('QC files received',received,setReceived)}{field('Shipping list root',shipping,setShipping)}</div>
 <Panel title="Output folder"><div className="flex gap-2"><PathInput value={output} readOnly={false} disabled={job.running} onChange={setOutput}/><Button disabled={job.running} onClick={async()=>{const path=await window.api.chooseOutputDir(output);if(path)setOutput(path);}}>Browse</Button></div><p className="mt-2">Copies are organized here. Received originals are archived to the sibling “3.6.6 QC files uploaded” folder only after verified copying succeeds.</p></Panel>
 <Panel title="Review shipment" actions={<Button disabled={job.running} onClick={()=>setRevision(v=>v+1)}>Reload table</Button>}>
 {data&&<label>Shipment date <select aria-label="Shipment date" value={data.date||''} disabled={job.running} onChange={e=>setDate(e.target.value)} style={{padding:8,background:C.surface}}>{data.dates.map(value=><option key={value}>{value}</option>)}</select></label>}
 <DataTable maxHeight={420} rows={data?.rows||[]} rowStyle={row=>({background:row.state==='ready'?'#DFF0D8':row.state==='problem'?'#FFF3C4':'#FFE2B5'})} columns={[{key:'check',label:'Process',render:row=><input aria-label={`Process ${row.bbi} ${row.tube}`} type="checkbox" disabled={job.running} checked={checked.has(row.index)} onChange={e=>setChecked(old=>{const next=new Set(old);e.target.checked?next.add(row.index):next.delete(row.index);return next;})}/>},...['bbi','tube','tubes','email','qcf','scenario','zipStatus'].map(key=>({key,label:({bbi:'BBI ID',tube:'Tube ID',tubes:'Tubes',email:'Customer email',qcf:'QC folder',scenario:'Scenario',zipStatus:'ZIP status'})[key]}))]}/>
 {!!data?.setupProblems.length&&<ul style={{color:C.amber}}>{data.setupProblems.map((message,i)=><li key={i}>{message}</li>)}</ul>}
 </Panel>
 <Panel><div className="flex gap-4 items-center"><Button variant="primary" disabled={job.running||!data||!checked.size||!data.rows.some(row=>checked.has(row.index)&&row.state==='ready')} onClick={run}>Process checked rows</Button>{job.running&&<Button variant="danger" onClick={job.cancel}>Stop</Button>}<progress aria-label="Upload execution progress" max={1} value={job.progress??(done?1:0)} style={{width:200,accentColor:C.teal}}/><span role={job.error?'alert':'status'} style={{color:job.error?C.coral:C.inkMuted}}>{job.error||job.status}</span></div></Panel>
 <Panel title="Processing log"><LogPanel logs={job.logs}/></Panel>
 </div></main></div>;
}
