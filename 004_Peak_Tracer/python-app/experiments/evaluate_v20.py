"""Reproducible TraceTuner experiment; all source files remain untouched.

PT is a comparator, never a calibration target. Engine output and stderr are
retained per read, including failed experiments. No engine defaults are tuned.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time
import numpy as np
from Bio import SeqIO
from task_paths import relocated


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def abi(path):
    t=SeqIO.read(path,'abi').annotations['abif_raw']
    return dict(seq=t['PBAS2'].decode(), q=list(t['PCON2']), p=list(t['PLOC2']))


def phd(path):
    lines=path.read_text().splitlines()
    start=lines.index('BEGIN_DNA')+1; end=lines.index('END_DNA')
    rows=[line.split() for line in lines[start:end] if line.strip()]
    return dict(seq=''.join(r[0].upper() for r in rows),q=[int(r[1]) for r in rows],p=[int(r[2]) for r in rows])


def stats(r):
    q=np.asarray(r['q'])
    return dict(bases=len(q),q20=int((q>=20).sum()),q30=int((q>=30).sum()),
                n=r['seq'].count('N'),nonincreasing_positions=int((np.diff(r['p'])<=0).sum()),
                regions={f'{lo+1}-{hi}':dict(bases=len(q[lo:hi]),q20=int((q[lo:hi]>=20).sum()),
                          mean_q=float(q[lo:hi].mean()) if len(q[lo:hi]) else None)
                         for lo,hi in [(0,300),(300,600),(600,900),(900,1200)]})


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--task',type=Path,required=True);p.add_argument('--engine',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True);p.add_argument('--all',action='store_true')
    p.add_argument('--plate',choices=('sample4','sample5'),default='sample4')
    a=p.parse_args();a.output.mkdir(parents=True,exist_ok=True);engine=a.engine.resolve()
    source=(a.task/'v1.8_validation/sample4/2-P1905969_2026-08-28' if a.plate=='sample4'
            else a.task/'analysis_v1.7/samples/sample5/2-P1905972_2026-09-01')
    source=relocated(a.task,source)
    manifest=json.loads(relocated(a.task,a.task/f'v1.9_validation/{a.plate}/6-v1.9/run_manifest.json').read_text())
    pairs=sorted(manifest['files'],key=lambda x:Path(x['src']).name)
    if not a.all:
        selected=pairs[::8]
        for item in pairs:
            if 'POS1' in item['src'] or ('ZV270402-F1' in item['src'] and 'U0827P1A8.' in item['src']):
                if item not in selected:selected.append(item)
        pairs=selected
    report=dict(plate=a.plate,engine=str(engine),engine_sha256=sha(engine),subset=not a.all,reads=[])
    for index,item in enumerate(pairs):
        src=source/Path(item['src']).name; enhanced=relocated(a.task,item['out'])
        row=dict(name=src.name,sources={},runs={})
        for label,path in [('seq7',src),('v19',enhanced)]:
            original=abi(path); row['sources'][label]=dict(path=str(path),sha256=sha(path),stats=stats(original))
            for mode,flags in [('nocall',['-nocall']),('recalln',['-recalln']),('full',[])]:
                work=a.output/f'r{index:03d}'/f'{label}-{mode}';work.mkdir(parents=True,exist_ok=True)
                staged=work/'trace.ab1';shutil.copyfile(path,staged)
                command=[str(engine),'-3730',*flags,'-p','trace.ab1']; started=time.monotonic()
                result=dict(command=command,source_sha256=sha(path))
                try:
                    run=subprocess.run(command,cwd=work,capture_output=True,timeout=60)
                    (work/'stdout.txt').write_bytes(run.stdout);(work/'stderr.txt').write_bytes(run.stderr)
                    result['returncode']=run.returncode
                    outputs=list(work.glob('*.phd.1'))
                    if run.returncode or len(outputs)!=1:raise ValueError('Engine failed or missing PHD')
                    called=phd(outputs[0]);result.update(stats=stats(called),phd=str(outputs[0]),
                         sequence_unchanged=called['seq']==original['seq'],positions_unchanged=called['p']==original['p'],
                         qualities_unchanged=called['q']==original['q'])
                    if len(called['q'])==len(original['q']):
                        q=np.array(called['q']);old=np.array(original['q'])
                        result.update(qv_increases=int((q>old).sum()),qv_decreases=int((q<old).sum()),
                                      substitutions=sum(x!=y for x,y in zip(called['seq'],original['seq'])))
                except (subprocess.TimeoutExpired,ValueError) as e:result['error']=str(e)
                result['seconds']=round(time.monotonic()-started,3)
                if sha(path)!=row['sources'][label]['sha256']:raise RuntimeError('Source changed')
                row['runs'][f'{label}-{mode}']=result
        report['reads'].append(row)
        (a.output/'results.json').write_text(json.dumps(report,indent=2))
        print(f'{a.plate} {index+1}/{len(pairs)} {src.name}',flush=True)


if __name__=='__main__':main()
