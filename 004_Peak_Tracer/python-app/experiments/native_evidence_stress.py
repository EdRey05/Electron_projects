"""Known-truth stress test; model preference is not biological accuracy."""
import argparse
import json
from pathlib import Path
import sys
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from peaktrace.config import parse_args
from peaktrace.read import Trace
from peaktrace.resolution import resolve_channels
from peaktrace.evidence import fit_pair


def main():
    p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);p.add_argument('--holdout',action='store_true');args=p.parse_args()
    config=parse_args(['--input-dir','unused','--output-dir','unused'])
    sequence='ACGT'*10+'CAAG'+'ACGT'*10
    positions=np.arange(len(sequence))*20+40;x=np.arange(positions[-1]+60);left=positions[41];right=positions[42]
    rows=[]
    for family in ('single','asymmetric_single','double','unequal_width_double'):
        for width in ((.25,.38,.52,.72) if args.holdout else (.3,.45,.6)):
            for noise in ((.01,.04,.12) if args.holdout else (0.,.02,.06)):
                for seed in (range(30,36) if args.holdout else range(6)):
                    rng=np.random.default_rng(seed);channels={k:np.zeros(len(x)) for k in range(9,13)}
                    for i,(base,pos) in enumerate(zip(sequence,positions)):
                        if i in (41,42):continue
                        channels[9+'GATC'.index(base)]+=100*np.exp(-.5*((x-pos)/6)**2)
                    if family.endswith('single'):
                        center=(left+right)/2+(-2.4 if args.holdout else 1.3)
                        sigma=np.where(x<center,width*20,width*20*((2.5 if args.holdout else 1.9) if family=='asymmetric_single' else 1))
                        target=100*np.exp(-.5*((x-center)/sigma)**2)
                    else:
                        target=100*np.exp(-.5*((x-left)/ (width*20))**2)+(35 if args.holdout else 65)*np.exp(-.5*((x-right)/(width*20*((2.0 if args.holdout else 1.5) if family=='unequal_width_double' else 1)))**2)
                    channels[10]+=target
                    channels={k:np.maximum(a+2+rng.normal(0,noise*100,len(x)),0) for k,a in channels.items()}
                    trace=Trace(Path('synthetic'),channels,np.frombuffer(sequence.encode(),np.uint8),np.full(len(sequence),30,np.uint8),positions,{'FWO_1':b'GATC'})
                    resolved,_=resolve_channels(trace,config)
                    rows.append(dict(family=family,width=width,noise=noise,seed=seed,
                                     original=fit_pair(channels[10],left,right),resolved=fit_pair(resolved[10],left,right)))
    summary=[]
    for family in sorted({r['family'] for r in rows}):
        selected=[r for r in rows if r['family']==family]
        summary.append(dict(family=family,n=len(selected),**{stage:dict(
            delta_above_10=sum(r[stage]['delta_bic_two_over_one']>10 for r in selected),
            screened_two=sum(r[stage]['delta_bic_two_over_one']>10 and r[stage]['double_relative_rms']<.15 and r[stage]['minor_major_amplitude_ratio']>.15 for r in selected)) for stage in ('original','resolved')}))
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(dict(holdout=args.holdout,seed_range=list(range(30,36) if args.holdout else range(6)),screen='delta > 10, double relative RMS < .15, amplitude ratio > .15; illustrative, not calibrated',summary=summary,trials=rows),indent=2))
    print(json.dumps(summary,indent=2))


if __name__=='__main__':main()
