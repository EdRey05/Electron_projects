import {useEffect,useRef,useState} from 'react';
export function usePythonJob() {
  const [running,setRunning]=useState(false),[logs,setLogs]=useState([]),[error,setError]=useState(''),[status,setStatus]=useState('Ready');
  const active=useRef(null);
  const pending=useRef(Promise.resolve());
  const [progress,setProgress]=useState(null);
  const [prompt,setPrompt]=useState(null);
  useEffect(()=>{
    const off=window.api.onPythonProgress(event=>{
      if(event.requestId!==active.current)return;
      if(Number.isFinite(event.fraction)){setProgress(event.fraction);}
      else if(event.prompt){setPrompt(event.prompt);setStatus('Waiting for input…');}
      else setLogs(old=>[...old.slice(-499),event.message]);
    });
    return()=>{off();if(active.current)window.api.cancelPythonJob(active.current);};
  },[]);
  const run=async(action,input)=>{
    const previous=active.current,previousRun=pending.current;
    const requestId=crypto.randomUUID();active.current=requestId;setRunning(true);setError('');setLogs([]);setProgress(null);setStatus('Processing…');
    try {
      if(previous)await window.api.cancelPythonJob(previous);
      await previousRun.catch(()=>{});
      if(active.current!==requestId)return null;
      pending.current=window.api.runPythonJob(requestId,action,input);
      const result=await pending.current;
      if(active.current!==requestId)return null;
      if(result.canceled){setStatus('Canceled.');return null;}
      if(!result.ok)throw new Error(result.error);
      setStatus('Complete.');return result.data;
    }catch(e){if(active.current===requestId){setError(e.message);setStatus('Failed.');}return null;}
    finally{if(active.current===requestId){active.current=null;setPrompt(null);setRunning(false);}}
  };
  const cancel=()=>active.current&&window.api.cancelPythonJob(active.current);
  const answer=(choice,data={})=>{if(active.current&&prompt){window.api.answerPythonJob(active.current,prompt.promptId,choice,data);setPrompt(null);setStatus('Processing…');}};
  return {run,cancel,running,logs,error,status,prompt,answer,progress};
}
