import React,{useEffect,useState} from 'react';
import {Modal,Button,PathInput,C} from './kit.jsx';
export function PythonPrompt({job}) {
  const prompt=job.prompt;
  const [values,setValues]=useState({});
  useEffect(()=>{setValues(Object.fromEntries((prompt?.fields??[]).map(f=>[f.key,f.value??''])));},[prompt?.promptId]);
  if(!prompt)return null;
  const browse=async field=>{const value=field.type==='folder'?await window.api.chooseOutputDir(values[field.key]):await window.api.chooseFile({filter:field.extension||'.xlsx'});if(value)setValues(old=>({...old,[field.key]:value}));};
  return <Modal open title={prompt.title} onCancel={()=>job.answer('cancel',values)} width={900} footer={<>{prompt.choices.map(choice=><Button key={choice} variant={choice==='cancel'?'secondary':'primary'} onClick={()=>job.answer(choice,values)}>{({ok:'Continue',start:'Start',retry:'Retry',cancel:'Cancel',proceed:'Process'})[choice]||choice}</Button>)}</>}>
    <p style={{fontSize:16,lineHeight:1.6,whiteSpace:'pre-wrap',color:C.ink}}>{prompt.message}</p>
    {(prompt.fields??[]).map(field=><label key={field.key} className="block mt-3"><span style={{fontSize:15,fontWeight:600}}>{field.label}</span><div className="flex gap-2 mt-1"><PathInput aria-label={field.label} value={values[field.key]??''} readOnly={false} onChange={v=>setValues(old=>({...old,[field.key]:v}))}/>{['file','folder'].includes(field.type)&&<Button onClick={()=>browse(field)}>Browse</Button>}</div></label>)}
  </Modal>;
}
