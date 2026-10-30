import React,{useState} from 'react';
import {AppHeader,Panel,Button,PathInput,DataTable,LogPanel,C} from '../../ui/kit.jsx';
import {usePythonJob} from '../../ui/usePythonJob.js';
export default function BatchQCReport({onBack}) {
  const [folder,setFolder]=useState(''),[output,setOutput]=useState(''),[allowWord,setAllowWord]=useState(false),[result,setResult]=useState(null);
  const job=usePythonJob();
  const browse=async(value,setter)=>{const selected=await window.api.chooseOutputDir(value);if(selected){setter(selected);setResult(null);}};
  const process=async()=>{setResult(null);const data=await job.run('batch-report',{inputFolder:folder,outputFolder:output,allowWord});if(data)setResult(data);};
  const sequenceLength=key=>({key,label:key==='insert_seq'?'Insert bp':'Final vector bp',render:row=>row[key]?.length??'—'});
  return <div className="h-full flex flex-col" style={{background:C.paper,color:C.ink}}><AppHeader title="BATCH QC Report" subtitle="Extract identifiers, sequences and OD measurements from BATCH ZIP files" onBack={onBack}/>
    <main className="flex-1 overflow-auto p-6"><div className="max-w-7xl mx-auto space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">{[['BATCH ZIP folder',folder,setFolder],['Output folder',output,setOutput]].map(([label,value,setter])=><Panel key={label} title={label} subtitle={label==='Output folder'?'Defaults to the input folder.':undefined}><div className="flex gap-2"><PathInput aria-label={label} value={value} readOnly={false} onChange={v=>{setter(v);setResult(null);}} disabled={job.running}/><Button disabled={job.running} onClick={()=>browse(value,setter)}>Browse</Button></div></Panel>)}</div>
      <Panel title="Process report"><div className="flex gap-5 items-center flex-wrap"><label><input type="checkbox" checked={allowWord} disabled={job.running} onChange={e=>setAllowWord(e.target.checked)}/> Convert legacy .doc with Word</label><span style={{fontSize:14,color:C.inkMuted}}>DOCX works directly. Legacy DOC conversion requires Microsoft Word.</span><Button variant="primary" disabled={!folder||job.running} onClick={process}>Create QC report</Button>{job.running&&<Button variant="danger" onClick={job.cancel}>Stop</Button>}</div>
        <div className="flex gap-4 items-center mt-4" style={{minHeight:32}}><progress aria-label="QC report progress" max={1} value={job.running?undefined:result?1:0} style={{width:220,accentColor:C.teal}}/><span role={job.error?'alert':'status'} style={{color:job.error?C.coral:C.inkMuted}}>{job.error||job.status}</span></div>
      </Panel>
      <Panel title="Report preview" actions={result&&<Button variant="primary" onClick={()=>window.api.revealPath(result.outputPath)}>Show report</Button>}>
        <DataTable rows={result?.records??[]} columns={[{key:'zip_name',label:'ZIP'},{key:'bbi_id',label:'BBI ID'},{key:'plasmid_no',label:'Plasmid No.'},{key:'od260',label:'OD260'},{key:'od280',label:'OD280'},{key:'od_ratio',label:'OD260/OD280'},{key:'ng_ul',label:'ng/uL'},sequenceLength('insert_seq'),sequenceLength('final_vector_seq')]}/>
        {!!result?.warnings.length&&<details className="mt-3"><summary style={{color:C.amber,cursor:'pointer'}}>Review {result.warnings.length} item(s)</summary><ul>{result.warnings.map((warning,i)=><li key={i}>{warning}</li>)}</ul></details>}
        {result&&<p className="mt-3" style={{fontSize:14,color:C.inkMuted}}>Review OCR values against the source image in the saved workbook.</p>}
      </Panel>
      <details open={job.running}><summary style={{cursor:'pointer'}}>Processing log</summary><LogPanel logs={job.logs}/></details>
    </div></main></div>;
}
