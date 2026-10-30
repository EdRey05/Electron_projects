"""Native UI adapter for the upstream vector-map processors."""
from pathlib import Path
from types import ModuleType, SimpleNamespace
import os
import re
import sys
import tempfile
import time
from processors.common import load_upstream

def source(root, name):
    package='gsh_vector_workflows'
    folder=root/'Code/QC_digestion_design/workflows'
    if package not in sys.modules:
        module=ModuleType(package);module.__path__=[str(folder)];sys.modules[package]=module
    return load_upstream(package+'.'+name,folder/(name+'.py'))

def prepare(payload,root):
    import pandas as pd
    helpers=source(root,'helpers')
    ids=list(dict.fromkeys(str(v).strip() for v in payload.get('workNos',[]) if str(v).strip()))
    if not ids:raise ValueError('Enter at least one Work No.')
    for value in ids:
        if re.search(r'[<>:"/\\|?*\x00-\x1f\s]',value) or value.endswith('.') or re.match(r'^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)',value,re.I):
            raise ValueError('Invalid Work No. for a map filename: '+value)
    if len({v.casefold() for v in ids})!=len(ids):raise ValueError('Work Nos differ only by capitalization.')
    book=pd.ExcelFile(payload['primerLog'],engine='openpyxl')
    frames=[pd.read_excel(book,sheet_name=n,dtype=object) for n in book.sheet_names if n.lower() in ('input addon','obsolete input addon(completed)')]
    if not frames:raise ValueError('No input addon sheet found.')
    records=[];failures=[]
    for value in ids:
        row=None
        for frame in frames:
            row=helpers.get_row_for_work_no(frame,value)
            if row is not None:break
        if row is None:failures.append({'workNo':value,'reason':'Not found'});continue
        vector=helpers.get_field_from_row(row,['Final Vector Sequence','Final Vector','FinalVector'],8)
        insert=helpers.get_field_from_row(row,['Insert Sequence','Insert Seq','InsertSeq'],7)
        vector=re.sub(r'\s','',vector).upper();insert=re.sub(r'\s','',insert).upper()
        if not vector or re.search('[^ACGTRYSWKMBDHVN]',vector+insert):reason='Missing or invalid DNA sequence'
        elif len(insert)>len(vector):reason='Insert is longer than the vector'
        elif insert and insert not in vector+vector:reason='Insert not found in circular vector'
        else:records.append((value,vector,insert));continue
        failures.append({'workNo':value,'reason':reason})
    folder=Path(payload['outputFolder']).resolve();folder.mkdir(parents=True,exist_ok=True)
    return records,failures,folder

def run(payload,root,log,ask,snapgene=False):
    records,failures,folder=prepare(payload,root)
    extension='.dna' if snapgene else '.gb'
    accepted=[]
    for record in records:
        target=folder/(record[0]+extension)
        if target.exists() and (snapgene or not payload.get('replace')):failures.append({'workNo':record[0],'reason':'Output exists; choose a new folder for SnapGene, or enable Replace for GenBank'})
        else:accepted.append(record)
    if not accepted:raise ValueError('; '.join(f["workNo"]+': '+f['reason'] for f in failures) or 'No valid records.')
    files=[]
    if snapgene:
        import win32gui
        import win32process
        import win32api
        import win32con
        def is_snapgene(hwnd):
            try:
                _,pid=win32process.GetWindowThreadProcessId(hwnd)
                handle=win32api.OpenProcess(win32con.PROCESS_QUERY_INFORMATION|win32con.PROCESS_VM_READ,False,pid)
                try:return Path(win32process.GetModuleFileNameEx(handle,0)).name.lower()=='snapgene.exe'
                finally:handle.Close()
            except Exception:return False
        windows=[]
        win32gui.EnumWindows(lambda h,_:windows.append(h) if win32gui.IsWindowVisible(h) and is_snapgene(h) else None,None)
        if not windows:raise ValueError('Open the installed SnapGene application before starting this workflow. GenBank mode does not require SnapGene.')
        module=source(root,'vector_map_prep_snapgene')
        ask('Ready for SnapGene',f'{len(accepted)} maps ready. Start, then switch to SnapGene during the 10-second countdown.',['cancel','start'])
        def countdown(seconds):
            for i in range(seconds,0,-1):log(f'Switch to SnapGene: {i}');module.pyautogui.failSafeCheck();time.sleep(1)
        countdown(10)
        processor=module.VectorMapPrepSnapGene(SimpleNamespace(log_queue=SimpleNamespace(put=log)))
        hotkey=module.pyautogui.hotkey;press=module.pyautogui.press;copy=module.pyperclip.copy
        try:
            for value,vector,insert in accepted:
                while not is_snapgene(win32gui.GetForegroundWindow()):
                    ask('SnapGene lost focus','Switch to SnapGene. Retry gives you five seconds.',['cancel','retry']);countdown(5)
                target=folder/(value+extension);saving=False
                def guarded_hotkey(*keys,**kwargs):
                    nonlocal saving
                    if not is_snapgene(win32gui.GetForegroundWindow()):raise RuntimeError('SnapGene lost focus; automation stopped.')
                    if tuple(keys)==('ctrl','s'):saving=True
                    return hotkey(*keys,**kwargs)
                def guarded_press(*keys,**kwargs):
                    if not is_snapgene(win32gui.GetForegroundWindow()):raise RuntimeError('SnapGene lost focus; automation stopped.')
                    return press(*keys,**kwargs)
                def redirected_copy(text):
                    nonlocal saving
                    if saving:text=str(target);saving=False
                    return copy(text)
                module.pyautogui.hotkey=guarded_hotkey;module.pyautogui.press=guarded_press;module.pyperclip.copy=redirected_copy
                log('Creating '+value);processor._automate_one(value,vector,insert)
                for attempt in range(20):
                    if target.is_file():break
                    time.sleep(0.5)
                if not target.is_file():raise RuntimeError('SnapGene did not save '+str(target)+'. Check its dialogs/version.')
                files.append({'workNo':value,'path':str(target)})
        finally:module.pyautogui.hotkey=hotkey;module.pyautogui.press=press;module.pyperclip.copy=copy
    else:
        from Bio.SeqFeature import CompoundLocation,FeatureLocation
        module=source(root,'vector_map_prep_biopython')
        # Upstream passes strand to CompoundLocation, unsupported in BioPython.
        module.CompoundLocation=lambda parts,strand=1:CompoundLocation([FeatureLocation(p.start,p.end,strand=strand) for p in parts])
        processor=module.VectorMapPrepBioPython(SimpleNamespace(log_queue=SimpleNamespace(put=log)))
        with tempfile.TemporaryDirectory(prefix='gsh-genbank-') as temporary:
            for value,vector,insert in accepted:
                log('Creating '+value)
                ok,message=processor.create_genbank_with_insert(value,vector,insert,temporary)
                if not ok:failures.append({'workNo':value,'reason':message});continue
                target=folder/(value+extension)
                # Rename within the destination filesystem; fail if a new file appeared.
                fd,pending=tempfile.mkstemp(prefix='.gsh-',suffix='.gb',dir=folder)
                try:
                    with os.fdopen(fd,'wb') as output:output.write(Path(message).read_bytes())
                    if payload.get('replace'):os.replace(pending,target)
                    else:os.rename(pending,target)
                finally:Path(pending).unlink(missing_ok=True)
                files.append({'workNo':value,'path':str(target)})
    return {'files':files,'failures':failures}
