import React,{useEffect,useState} from 'react';
import {PathInput,ValidationStatus} from './kit.jsx';
import {validateWorkbookSheets} from './workbookValidation.js';

export function ValidatedPath({value,kind='directory',requiredSheets=[],children,...props}) {
 const [result,setResult]=useState({path:'',state:'empty'});
 const signature=JSON.stringify(requiredSheets);
 useEffect(()=>{
  let stale=false;
  if(!value){setResult({path:'',state:'empty'});return;}
  setResult({path:value,state:'checking'});
  (async()=>{
   try{
    const info=await window.api.inspectPath({filePath:value,kind});
    if(!info?.ok)throw new Error(info?.error||'Path not found.');
    if(kind==='file'&&/\.xls[xm]$/i.test(value)){
     const data=await window.api.readBinaryFile({filePath:value});
     if(!data?.ok)throw new Error(data?.error||'Cannot read workbook.');
     validateWorkbookSheets(data.bytes,JSON.parse(signature));
    }
    if(!stale)setResult({path:value,state:'valid',valid:true});
   }catch(error){if(!stale)setResult({path:value,state:'invalid',error:error.message});}
  })();
  return()=>{stale=true;};
 },[value,kind,signature]);
 const validation=result.path===value?result:{state:value?'checking':'empty'};
 return <div><div className="flex gap-2"><PathInput {...props} value={value} valid={validation.valid} invalid={!!validation.error}/>{children}</div><ValidationStatus validation={validation}/></div>;
}
