"""Native review table around the latest upstream Upload Prep resolver/executor."""
from datetime import date, datetime
import hashlib
from pathlib import Path
import shutil
from types import SimpleNamespace
from processors.common import load_upstream

def digest(path):
    h=hashlib.sha256()
    with open(path,'rb') as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b''):h.update(chunk)
    return h.digest()

def copy_verified(source,target):
    source,target=Path(source),Path(target)
    created=False
    try:
        with source.open('rb') as reader,target.open('xb') as writer:
            created=True
            shutil.copyfileobj(reader,writer,1024*1024)
        if digest(source)!=digest(target):raise OSError('Copied ZIP checksum mismatch.')
        shutil.copystat(source,target)
    except BaseException:
        if created:target.unlink(missing_ok=True)
        raise

def move_verified(source,target):
    copy_verified(source,target)
    Path(source).unlink()

def run(payload,root,log,progress):
    module=load_upstream('gsh_upload_prep',root/'Code/QC_file_prep/workflows/upload_prep.py')
    paths=payload.get('paths',{})
    app=SimpleNamespace(log=log,hub_paths=paths,make_path_from_config=lambda *_:None)
    workflow=module.UploadPrep(app)
    stat=Path(payload['workbook']).stat()
    stamp=f'{stat.st_mtime_ns}:{stat.st_size}'
    if payload.get('execute') and payload.get('stamp')!=stamp:raise ValueError('Workbook changed since review. Reload the table before processing.')
    output=Path(payload['outputFolder']).resolve()
    workflow._output_root=lambda:str(output)
    by_date=workflow._parse_log(payload['workbook'])
    dates=sorted(by_date,reverse=True)[:module.MAX_DATES]
    selected_date=payload.get('date') or (dates[0] if dates else None)
    rows=by_date.get(selected_date,[])
    qc_dir,ship_root,setup=workflow._resolve_sources()
    states=[]
    for rec in rows:
        state=workflow._check_row(rec,qc_dir,ship_root)
        if state['kind']=='ready' and not Path(state['target']).resolve().is_relative_to(output):
            state={'kind':'problem','short':'unsafe target path','text':'Target escapes the selected output folder.'}
        states.append(state)
    def clean(value):
        if isinstance(value,datetime):return value.date().isoformat()
        if isinstance(value,date):return value.isoformat()
        return value
    preview=[{**{k:clean(v) for k,v in rec.items()},'index':i,'state':states[i]['kind'],'zipStatus':states[i].get('short',''),'scenario':module.name_for_entry(states[i].get('sid')) if states[i].get('sid') else 'Unmatched'} for i,rec in enumerate(rows)]
    if not payload.get('execute'):
        return {'dates':dates,'date':selected_date,'rows':preview,'setupProblems':setup,'stamp':stamp}
    checked=payload.get('checked',[])
    if any(type(i) is not int or i<0 or i>=len(rows) for i in checked):raise ValueError('The selected row list is invalid. Reload the review table.')
    safe={i for i in checked if states[i]['kind']=='ready'}
    entries,problems,setup=workflow._preflight(rows,safe)
    for entry in entries:
        if not Path(entry['dst_dir']).resolve().is_relative_to(output):raise ValueError('Unsafe destination folder.')
    for i in checked:
        if i not in safe:log('Skipped: '+states[i].get('text','Row is not ready.'))
    for text in setup:log(text)
    # Reuse upstream scenario classification, output routing and two-phase execution.
    # Replace only copy/move primitives with exclusive, checksum-verified operations.
    module.shutil=SimpleNamespace(copy2=copy_verified,move=move_verified)
    app.after=lambda _delay,callback,*args:callback(*args)
    workflow._progress_set=progress
    workflow._execute(entries)
    return {'dates':dates,'date':selected_date,'rows':preview,'planned':len(entries),'problems':list(problems.values()),'outputFolder':str(output)}
