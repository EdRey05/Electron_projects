"""Separate baseline-drift and hard-clipping challenges; no new app decisions."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import sys
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from neighbor_interference import make_trace, passes, summarize
from peaktrace.config import parse_args
from peaktrace.evidence import _signal, fit_pair
from peaktrace.provenance import processor_identity
from peaktrace.resolution import resolve_channels


def perturb(channels,left,right,kind,level):
    """Perturb only the analyzed A dye; keep identical pre-artifact noise.

    Clipping is an idealized post-noise ceiling, not a detector/ABI saturation
    model. Drift is added to the already nonnegative simulated measurement.
    Returned artifact truth is for audit only, never an input to fitting.
    """
    result={k:v.copy() for k,v in channels.items()}
    d=right-left;x=np.arange(len(result[10]));mid=(left+right)/2
    window=slice(left-d,right+d+1)
    details={}
    if kind.startswith('drift_'):
        if kind=='drift_rise':shape=.5*(1+np.tanh((x-mid)/(3*d)))
        elif kind=='drift_fall':shape=.5*(1-np.tanh((x-mid)/(3*d)))
        elif kind=='drift_hump':shape=np.exp(-.5*((x-mid)/(1.5*d))**2)
        else:raise ValueError(kind)
        baseline=100*level*shape
        result[10]+=baseline
        details=dict(added_baseline_local_min=float(baseline[window].min()),
                     added_baseline_local_max=float(baseline[window].max()))
    elif kind=='clipping':
        cap=100*level
        details=dict(ceiling=cap,clipped_local_samples=int(np.sum(result[10][window]>cap)),
                     local_samples=len(result[10][window]))
        result[10]=np.minimum(result[10],cap)
    elif kind!='control':raise ValueError(kind)
    return result,details


def main():
    p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);args=p.parse_args()
    if args.output.exists():p.error('Use a fresh output directory')
    args.output.mkdir(parents=True)
    config=parse_args(['--input-dir','unused','--output-dir','unused'])
    conditions=[('control',0.)]+[(k,a) for k in ('drift_rise','drift_fall','drift_hump') for a in (.25,.75,1.5)]+[('clipping',c) for c in (.9,.6,.35)]
    rows=[]
    for family in ('single','double'):
        for width in (.3,.45,.6):
            for noise in (.02,.08):
                for seed in range(80,84):
                    for kind,level in conditions:
                        trace,left,right,truth=make_trace(family,width,noise,seed)
                        trace.channels,artifact=perturb(trace.channels,left,right,kind,level)
                        resolved,_=resolve_channels(trace,config)
                        row=dict(family=family,width=width,noise=noise,seed=seed,kind=kind,level=level,
                                 truth=truth,artifact_truth=artifact)
                        for stage,channels in [('original',trace.channels),('resolved',resolved)]:
                            row[stage]=fit_pair(_signal(channels,20)[1],left,right)
                        rows.append(row)
    key=lambda r:(r['family'],r['width'],r['noise'],r['seed'])
    controls={key(r):r for r in rows if r['kind']=='control'}
    groups={'control':list(controls.values()),'drift':[r for r in rows if r['kind'].startswith('drift_')],
            'clipping':[r for r in rows if r['kind']=='clipping']}
    transitions={}
    for group in ('drift','clipping'):
        transitions[group]={}
        for stage in ('original','resolved'):
            transitions[group][stage]={}
            for family in ('single','double'):
                paired=[(passes(controls[key(r)][stage]),passes(r[stage])) for r in groups[group] if r['family']==family]
                transitions[group][stage][family]=dict(n=len(paired),new_pass=sum(not a and b for a,b in paired),
                    lost_pass=sum(a and not b for a,b in paired),both_pass=sum(a and b for a,b in paired),neither_pass=sum(not a and not b for a,b in paired))
    report=dict(schema='baseline-saturation-experiment-v1',processor=processor_identity(),
        source_sha256={f:hashlib.sha256((Path(__file__).parent/f).read_bytes().replace(b'\r\n',b'\n')).hexdigest() for f in ('baseline_saturation.py','neighbor_interference.py')},
        design=dict(seeds=list(range(80,84)),widths=[.3,.45,.6],noise=[.02,.08],conditions=conditions,
            baseline='A dye only. Rise/fall: 100*level*.5*(1 +/- tanh((x-mid)/(3*spacing))); hump: 100*level*exp(-.5*((x-mid)/(1.5*spacing))**2). Added after noise and nonnegative clipping.',
            saturation='A dye only, hard ceiling 100*level after noise. Entire analyzed channel capped; no ADC, raw-tag or detector behavior simulated.',
            screen='Unchanged delta > 10, double RMS < .15, amplitude ratio > .15; descriptive, not calibrated.',
            scope='48 paired controls, 432 drift cases, 144 clipping cases; no combined artifacts. Target anchors and noise preserved. Both stages use app baseline preprocessing.',
            limitations='Repeated controls/noise are not independent observations. Artificial post-noise analyzed-channel perturbations, not instrument-calibrated effects. No biological accuracy or QV inference.'),
        groups={k:summarize(v) for k,v in groups.items()},paired_transitions=transitions,
        by_condition=[dict(kind=k,level=v,counts=summarize([r for r in rows if r['kind']==k and r['level']==v])) for k,v in conditions])
    with gzip.open(args.output/'trials.json.gz','wt',encoding='utf-8') as f:json.dump(rows,f,allow_nan=False)
    (args.output/'summary.json').write_text(json.dumps(report,indent=2,allow_nan=False),encoding='utf-8')
    print(json.dumps({k:{s:{f:{n:c[n] for n in ('n','unavailable','screen_pass','screen_not_pass','passing_with_double_bound')} for f,c in v.items()} for s,v in counts.items()} for k,counts in report['groups'].items()},indent=2))


if __name__=='__main__':main()
