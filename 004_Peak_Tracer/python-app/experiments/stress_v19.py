"""Compare frozen v1.8 and v1.9 on known peaks and imperfect position anchors."""
from copy import copy
import argparse
import json
from pathlib import Path
import sys
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from peaktrace.config import parse_args
from peaktrace.read import Trace
from peaktrace.resolution import resolve_channels
from resolution_stress import score


def main():
    p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);args=p.parse_args()
    settings=parse_args(['--input-dir','unused','--output-dir','unused']);rows=[]
    for anchor_error in (0.,1.5):
        for noise in (0.,.02,.05,.10):
            for seed in range(8):
                rng=np.random.default_rng(seed)
                seq=np.frombuffer((('ACGT'*10+'ATTTTC'+'ACGT'*10+'CAAAAG')*2).encode(),np.uint8)
                positions=np.rint(30+np.cumsum(rng.uniform(11,13,len(seq)))).astype(int)
                x=np.arange(positions[-1]+50);clean={k:np.zeros(len(x)) for k in range(9,13)}
                for i,(base,position) in enumerate(zip(seq,positions)):
                    width=4.+2.5*i/len(seq);amplitude=rng.uniform(80,120)
                    clean[9+'GATC'.index(chr(base))]+=amplitude*np.exp(-.5*((x-position)/width)**2)
                measured={k:np.maximum(v+2+rng.normal(0,noise*100,len(x)),0) for k,v in clean.items()}
                anchors=positions+np.rint(rng.uniform(-anchor_error,anchor_error,len(positions))).astype(int)
                trace=Trace(Path('synthetic'),measured,seq,np.full(len(seq),40,np.uint8),anchors,{'FWO_1':b'GATC'})
                row={'noise':noise,'anchor_error':anchor_error,'seed':seed,'input':score(measured,seq,positions,clean)}
                for model in ('v18','v19'):
                    cfg=copy(settings);cfg.resolution_model=model
                    cfg.resolution_strength=.75 if model=='v18' else .80
                    cfg.resolution_iterations=24 if model=='v18' else 40
                    result,_=resolve_channels(trace,cfg);row[model]=score(result,seq,positions,clean)
                rows.append(row)
    summary=[]
    for anchor_error in (0.,1.5):
        for noise in (0.,.02,.05,.10):
            rs=[r for r in rows if r['noise']==noise and r['anchor_error']==anchor_error]
            summary.append({'noise':noise,'anchor_error':anchor_error,
                            **{stage:{key:sum(r[stage][key] for r in rs) for key in rs[0][stage]}
                               for stage in ('input','v18','v19')}})
    args.output.write_text(json.dumps({'summary':summary,'trials':rows},indent=2),encoding='utf-8')
    print(json.dumps(summary,indent=2))


if __name__=='__main__':main()
