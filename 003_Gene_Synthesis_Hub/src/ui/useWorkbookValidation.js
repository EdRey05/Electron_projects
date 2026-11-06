import {useEffect,useState} from 'react';
import {validateWorkbookSheets} from './workbookValidation.js';

// A changed path fails closed immediately; late reads cannot validate a newer selection.
export function useWorkbookValidation(filePath, requiredSheets = []) {
  const [result,setResult] = useState({path:'',state:'empty',error:''});
  const signature = JSON.stringify(requiredSheets);
  useEffect(() => {
    let stale = false;
    if (!filePath) {setResult({path:'',state:'empty',error:''});return;}
    setResult({path:filePath,state:'checking',error:''});
    (async () => {
      try {
        const data = await window.api.readBinaryFile({filePath});
        if (!data?.ok) throw new Error(data?.error || 'Cannot read this file.');
        validateWorkbookSheets(data.bytes, JSON.parse(signature));
        if (!stale) setResult({path:filePath,state:'valid',error:''});
      } catch (error) {
        if (!stale) setResult({path:filePath,state:'invalid',error:error.message});
      }
    })();
    return () => {stale = true;};
  }, [filePath,signature]);
  const current = result.path === filePath ? result : {state:filePath?'checking':'empty',error:''};
  return {...current,valid:current.state==='valid'};
}

export function useWorkbookSetValidation(paths, requiredSheets = []) {
  const key = JSON.stringify([paths,requiredSheets]);
  const [result,setResult] = useState({key:'',entries:[]});
  useEffect(() => {
    let stale=false;
    const [files,sheets]=JSON.parse(key);
    Promise.all(files.map(async filePath => {
      try {
        const data=await window.api.readBinaryFile({filePath});
        if(!data?.ok)throw new Error(data?.error || 'Cannot read this file.');
        validateWorkbookSheets(data.bytes,sheets);
        return {path:filePath,valid:true};
      }catch(error){return {path:filePath,valid:false,error:error.message};}
    })).then(entries=>{if(!stale)setResult({key,entries});});
    return ()=>{stale=true;};
  },[key]);
  const entries=result.key===key?result.entries:paths.map(path=>({path,valid:false,checking:true}));
  return {entries,valid:paths.length>0&&result.key===key&&entries.every(entry=>entry.valid)};
}
