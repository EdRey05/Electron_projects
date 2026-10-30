import {useEffect,useRef,useState} from 'react';
export function usePythonJob() {
  const [running,setRunning]=useState(false),[logs,setLogs]=useState([]),[error,setError]=useState(''),[status,setStatus]=useState('Ready');
  const active=useRef(null);
  const [prompt,setPrompt]=useState(null);
  useEffect(()=>{
    const off=window.api.onPythonProgress(event=>{
      if(event.requestId!==active.current)return;
      if(event.prompt){setPrompt(event.prompt);setStatus('Waiting for input…');}
      else setLogs(old=>[...old.slice(-499),event.message]);
    });
    return()=>{off();if(active.current)window.api.cancelPythonJob(active.current);};
  },[]);
  const run=async(action,input)=>{
    const requestId=crypto.randomUUID();active.current=requestId;setRunning(true);setError('');setLogs([]);setStatus('Processing…');
    try {
      const result=await window.api.runPythonJob(requestId,action,input);
      if(result.canceled){setStatus('Canceled.');return null;}
      if(!result.ok)throw new Error(result.error);
      setStatus('Complete.');return result.data;
    }catch(e){setError(e.message);setStatus('Failed.');return null;}
    finally{if(active.current===requestId){active.current=null;setPrompt(null);setRunning(false);}}
  };
  const cancel=()=>active.current&&window.api.cancelPythonJob(active.current);
  const answer=(choice,data={})=>{if(active.current&&prompt){window.api.answerPythonJob(active.current,prompt.promptId,choice,data);setPrompt(null);setStatus('Processing…');}};
  return {run,cancel,running,logs,error,status,prompt,answer};
}
