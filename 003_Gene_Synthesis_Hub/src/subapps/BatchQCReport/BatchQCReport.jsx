import React,{useState} from 'react';
import {ValidatedPath} from '../../ui/ValidatedPath.jsx';
import {AppHeader,Panel,Button,PathInput,DataTable,LogPanel,Modal,C} from '../../ui/kit.jsx';
import {usePythonJob} from '../../ui/usePythonJob.js';
const OD_FIELDS=[['od260','OD260'],['od280','OD280'],['od_ratio','OD260/OD280'],['ng_ul','ng/uL']];
export default function BatchQCReport({onBack}) {
  const [folder,setFolder]=useState(''),[output,setOutput]=useState(''),[allowWord,setAllowWord]=useState(false),[result,setResult]=useState(null);
  const [review,setReview]=useState(null),[entries,setEntries]=useState({});
  const job=usePythonJob();
  const browse=async(value,setter)=>{const selected=await window.api.chooseOutputDir(value);if(selected){setter(selected);setResult(null);setReview(null);}};
  const process=async()=>{setResult(null);setReview(null);setEntries({});
    const data=await job.run('batch-report',{inputFolder:folder,outputFolder:output,allowWord});
    if(!data)return;
    if(data.step==='review'){
      setEntries(Object.fromEntries(data.review.readable.map(row=>[String(row.index),Object.fromEntries(OD_FIELDS.map(([field])=>[field,row.values[field]==null?'':String(row.values[field])]))])));
      setReview(data);
    }else setResult(data);
  };
  // The upstream tkinter review applies each row independently and rejects
  // non-numeric typed values naming the record; an apply error keeps this
  // modal open with the worker's message (mirrors the dialog staying up).
  const apply=async(skipped)=>{if(!review||job.running)return;
    const data=await job.run('batch-report',{step:'apply',token:review.token,records:review.records,warnings:review.warnings,entered:skipped?{}:entries,skipped,outputFolder:output||folder});
    if(data){setReview(null);setEntries({});setResult(data);}
  };
  const sequenceLength=key=>({key,label:key==='insert_seq'?'Insert bp':'Final vector bp',render:row=>row[key]?.length??'—'});
  return <div className="h-full flex flex-col" style={{background:C.paper,color:C.ink}}><AppHeader title="BATCH QC Report" subtitle="Extract identifiers, sequences and OD measurements from BATCH ZIP files" onBack={onBack}/>
    <main className="flex-1 overflow-auto p-6"><div className="max-w-7xl mx-auto space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">{[['BATCH ZIP folder',folder,setFolder],['Output folder',output,setOutput]].map(([label,value,setter])=><Panel key={label} title={label} subtitle={label==='Output folder'?'Defaults to the input folder.':undefined}><ValidatedPath aria-label={label} value={value} readOnly={false} onChange={v=>{setter(v);setResult(null);setReview(null);}} disabled={job.running}><Button disabled={job.running} onClick={()=>browse(value,setter)}>Browse</Button></ValidatedPath></Panel>)}</div>
      <Panel title="Process report"><div className="flex gap-5 items-center flex-wrap"><label><input type="checkbox" checked={allowWord} disabled={job.running} onChange={e=>setAllowWord(e.target.checked)}/> Convert legacy .doc with Word</label><span style={{fontSize:14,color:C.inkMuted}}>DOCX works directly. Legacy DOC conversion requires Microsoft Word.</span><Button variant="primary" disabled={!folder||job.running} onClick={process}>Create QC report</Button>{job.running&&<Button variant="danger" onClick={job.cancel}>Stop</Button>}</div>
        <div className="flex gap-4 items-center mt-4" style={{minHeight:32}}><progress aria-label="QC report progress" max={1} value={job.running?undefined:result?1:0} style={{width:220,accentColor:C.teal}}/><span role={job.error?'alert':'status'} style={{color:job.error?C.coral:C.inkMuted}}>{job.error||job.status}</span></div>
      </Panel>
      <Modal open={!!review} title={`OD value review - ${review?.review.readable.length} record(s)`} width={960}
        footer={<div className="flex items-center gap-3 justify-end flex-wrap"><span role="alert" style={{color:C.coral,fontSize:13}}>{job.error}</span><Button variant="primary" disabled={job.running} onClick={()=>apply(false)}>Save entered values</Button><Button disabled={job.running} onClick={()=>apply(true)}>Leave all pending</Button></div>}>
        {!!review?.review.noInput.length&&<div className="mb-4 p-3" style={{background:'#FDECEA',border:'1px solid '+C.coral,borderRadius:8}}>
          <p style={{fontSize:13,fontWeight:600,color:C.coral,marginBottom:6}}>Records without an OD table (no entry possible; they stay PENDING):</p>
          <ul>{review.review.noInput.map(row=><li key={row.index} style={{fontSize:13}}><b>{row.zipName}</b> - {row.bbiId}: {row.reason}</li>)}</ul>
        </div>}
        <p style={{fontSize:12,color:C.inkMuted,marginBottom:8}}>Type corrected numbers for rows you trust; a row left partially empty stays PENDING in its flagged fields.</p>
        <div className="space-y-2" style={{maxHeight:'55vh',overflow:'auto'}}>
          {review?.review.readable.map(row=><div key={row.index} className="p-3" style={{border:'1px solid '+C.inkMuted,borderRadius:8}}>
            <div className="flex items-start gap-4">
              <div style={{width:150}}><b>{row.bbiId}</b><div style={{fontSize:12,color:C.inkMuted}}>{row.zipName}</div>{row.flags.map((flag,i)=><div key={i} style={{fontSize:11,color:C.amber}}>{flag}</div>)}</div>
              <div style={{width:230,maxHeight:110,overflow:'hidden'}}>{row.image?<img alt={`OD table for ${row.bbiId}`} src={`data:image/png;base64,${row.image}`} style={{maxWidth:'100%',maxHeight:110}}/>:<span style={{fontSize:12,fontStyle:'italic'}}>No image</span>}</div>
              <div className="flex gap-3 flex-wrap">{OD_FIELDS.map(([field,label])=><label key={field} style={{fontSize:12}}><div style={{marginBottom:2}}>{label}</div><input aria-label={`${label} for ${row.bbiId}`} value={entries[String(row.index)]?.[field]??''} onChange={e=>setEntries(old=>({...old,[String(row.index)]:{...(old[String(row.index)]||{}),[field]:e.target.value}}))} style={{width:110,border:'1px solid '+C.inkMuted,borderRadius:6,padding:'6px 8px'}}/></label>)}</div>
            </div>
          </div>)}
        </div>
      </Modal>
      <Panel title="Report preview" actions={result&&<Button variant="primary" onClick={()=>window.api.revealPath(result.outputPath)}>Show report</Button>}>
        <DataTable rows={result?.records??[]} columns={[{key:'zip_name',label:'ZIP'},{key:'bbi_id',label:'BBI ID'},{key:'plasmid_no',label:'Plasmid No.'},{key:'od260',label:'OD260'},{key:'od280',label:'OD280'},{key:'od_ratio',label:'OD260/OD280'},{key:'ng_ul',label:'ng/uL'},sequenceLength('insert_seq'),sequenceLength('final_vector_seq')]}/>
        {!!result?.warnings.length&&<details className="mt-3"><summary style={{color:C.amber,cursor:'pointer'}}>Review {result.warnings.length} item(s)</summary><ul>{result.warnings.map((warning,i)=><li key={i}>{warning}</li>)}</ul></details>}
        {result&&<p className="mt-3" style={{fontSize:14,color:C.inkMuted}}>Review OCR values against the source image in the saved workbook.</p>}
      </Panel>
      <details open={job.running}><summary style={{cursor:'pointer'}}>Processing log</summary><LogPanel logs={job.logs}/></details>
    </div></main></div>;
}
