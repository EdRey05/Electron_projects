"""Headless processing adapters. Never starts Tk or Streamlit, or installs packages."""
import contextlib
import importlib.util
import json
from pathlib import Path
import sys
import traceback
import uuid
from types import SimpleNamespace

ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT))
sys.stdout.reconfigure(encoding='utf-8')
PROTOCOL=sys.stdout
def emit(kind,**values):
    PROTOCOL.write(json.dumps({'type':kind,**values},ensure_ascii=False,allow_nan=False)+'\n')
    PROTOCOL.flush()
def log(message): emit('log',message=str(message))
class UserCanceled(BaseException): pass
def ask(title,message,choices=None,fields=None):
    choices=choices or ['cancel','ok']
    prompt_id=str(uuid.uuid4())
    emit('prompt',promptId=prompt_id,title=title,message=message,choices=choices,fields=fields or [])
    while True:
        line=sys.stdin.readline()
        if not line:raise UserCanceled()
        reply=json.loads(line)
        if reply.get('replyTo')!=prompt_id:continue
        if reply.get('choice')=='cancel':raise UserCanceled()
        if reply.get('choice') not in choices:raise ValueError('Invalid dialog reply.')
        return reply
class LogStream:
    def write(self,text):
        if text.strip():log(text.strip())
        return len(text)
    def flush(self): pass
def load_module(name,file):
    spec=importlib.util.spec_from_file_location(name,file)
    module=importlib.util.module_from_spec(spec)
    sys.modules[name]=module
    spec.loader.exec_module(module)
    return module
def labels(payload):
    root=ROOT/'Code/Label_generator'
    sys.path.insert(0,str(root))
    module=load_module('gsh_label_parser',root/'workflows/sg_relabeling.py')
    parser=module.SgRelabeling(SimpleNamespace(log=log))
    files=payload.get('files',[])
    if not files:raise ValueError('Choose at least one shipping list.')
    records=[]
    for file in files:
        if Path(file).suffix.lower() not in ('.xlsx','.xls'):raise ValueError('Shipping lists must be XLS or XLSX files.')
        log('Reading '+Path(file).name)
        records.extend(parser._read_shipping_list(file))
    records=parser._dedupe_rows(records)
    columns=[entry[0] for entry in module.TABLE_COLUMNS]
    log(f'{len(records)} constructs loaded.')
    return {'columns':columns,'records':records}
def batch_report(payload):
    from processors.batch_report import run
    return run(payload,ROOT,log)

def qc_design(payload,snapgene=False):
    from processors.qc_design import run
    return run(payload,ROOT,log,ask,snapgene)

def qc_file_prep(payload):
    from processors.qc_file_prep import run
    return run(payload,ROOT,log,ask)

def main():
    request=json.loads(sys.stdin.readline())
    actions={'qc-file-prep':qc_file_prep,'labels':labels,'batch-report':batch_report,'qc-design-bio':qc_design,'qc-design-snapgene':lambda p:qc_design(p,True)}
    if request.get('action') not in actions:raise ValueError('Unknown processing action.')
    with contextlib.redirect_stdout(LogStream()):data=actions[request['action']](request.get('input') or {})
    emit('result',data=data)
if __name__=='__main__':
    try:main()
    except UserCanceled:
        emit('canceled')
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        emit('error',message=str(error))
        sys.exit(1)
