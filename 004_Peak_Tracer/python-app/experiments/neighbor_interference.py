"""Paired same-dye neighbor challenge; diagnostic screen, not basecall accuracy."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import sys
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from peaktrace.config import parse_args
from peaktrace.evidence import fit_pair, _signal
from peaktrace.provenance import processor_identity
from peaktrace.read import Trace
from peaktrace.resolution import resolve_channels


def make_trace(family, width, noise, seed, side='none', distance=0., amplitude=0.):
    sequence='ACGT'*10+'CAAG'+'ACGT'*10
    positions=np.arange(len(sequence))*20+40
    x=np.arange(positions[-1]+60)
    left,right=map(int,positions[41:43])
    channels={k:np.zeros(len(x)) for k in range(9,13)}
    for i,(base,pos) in enumerate(zip(sequence,positions)):
        if i not in (41,42):
            channels[9+'GATC'.index(base)]+=100*np.exp(-.5*((x-pos)/6)**2)
    centers=[left+.44*20] if family=='single' else [left,right]
    target=sum(a*np.exp(-.5*((x-c)/(width*20))**2)
               for a,c in zip([100,65],centers))
    neighbor_center=left-distance*20 if side=='left' else right+distance*20
    neighbor=amplitude*100*np.exp(-.5*((x-neighbor_center)/8)**2) if side!='none' else np.zeros(len(x))
    channels[10]+=target+neighbor
    rng=np.random.default_rng(seed)
    channels={k:np.maximum(a+2+rng.normal(0,noise*100,len(x)),0) for k,a in channels.items()}
    trace=Trace(Path('synthetic'),channels,np.frombuffer(sequence.encode(),np.uint8),
                np.full(len(sequence),30,np.uint8),positions,{'FWO_1':b'GATC'})
    return trace,left,right,dict(target_centers=centers,neighbor_center=neighbor_center if side!='none' else None)


def passes(fit):
    return bool(fit['available'] and fit['delta_bic_two_over_one']>10
                and fit['double_relative_rms']<.15 and fit['minor_major_amplitude_ratio']>.15)


def boundary(fit, model):
    return bool(fit.get('fit_diagnostics',{}).get(model,{}).get('boundary_parameters',[]))


def summarize(rows):
    result={}
    for stage in ('original','resolved'):
        groups={}
        for family in ('single','double'):
            selected=[r for r in rows if r['family']==family]
            fits=[r[stage] for r in selected]
            accepted=[f for f in fits if passes(f)]
            groups[family]=dict(n=len(fits),unavailable=sum(not f['available'] for f in fits),
                screen_pass=len(accepted),screen_not_pass=len(fits)-len(accepted),
                passing_with_single_bound=sum(boundary(f,'single') for f in accepted),
                passing_with_double_bound=sum(boundary(f,'double') for f in accepted),
                passing_with_either_bound=sum(boundary(f,'single') or boundary(f,'double') for f in accepted),
                passing_with_no_bounds=sum(not boundary(f,'single') and not boundary(f,'double') for f in accepted),
                boundaries={model:dict(flagged=sum(boundary(f,model) for f in fits),
                    flagged_pass=sum(boundary(f,model) and passes(f) for f in fits),
                    unflagged=sum(not boundary(f,model) for f in fits),
                    unflagged_pass=sum(not boundary(f,model) and passes(f) for f in fits))
                    for model in ('single','double')})
        result[stage]=groups
    return result


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    if args.output.exists():parser.error('Use a fresh output directory')
    args.output.mkdir(parents=True)
    config=parse_args(['--input-dir','unused','--output-dir','unused'])
    rows=[]
    for family in ('single','double'):
        for width in (.30,.45,.60):
            for noise in (.02,.08):
                for seed in range(60,64):
                    conditions=[('none',0.,0.)]+[(side,d,a) for side in ('left','right')
                        for d in (.5,1.,1.5) for a in (.25,.75,1.5)]
                    for side,distance,amplitude in conditions:
                        trace,left,right,truth=make_trace(family,width,noise,seed,side,distance,amplitude)
                        resolved,_=resolve_channels(trace,config)
                        row=dict(family=family,width=width,noise=noise,seed=seed,side=side,
                                 distance=distance,amplitude=amplitude,truth=truth)
                        for stage,channels in [('original',trace.channels),('resolved',resolved)]:
                            row[stage]=fit_pair(_signal(channels,20)[1],left,right)
                        rows.append(row)
    controls={(r['family'],r['width'],r['noise'],r['seed']):r for r in rows if r['side']=='none'}
    contaminated=[r for r in rows if r['side']!='none']
    transitions={}
    for stage in ('original','resolved'):
        transitions[stage]={}
        for family in ('single','double'):
            selected=[r for r in contaminated if r['family']==family]
            pairs=[(passes(controls[(r['family'],r['width'],r['noise'],r['seed'])][stage]),passes(r[stage])) for r in selected]
            transitions[stage][family]=dict(n=len(pairs),new_pass=sum(not a and b for a,b in pairs),
                lost_pass=sum(a and not b for a,b in pairs),both_pass=sum(a and b for a,b in pairs),neither_pass=sum(not a and not b for a,b in pairs))
    report=dict(schema='neighbor-interference-experiment-v1',processor=processor_identity(),
        experiment_sha256=hashlib.sha256(Path(__file__).read_bytes().replace(b'\r\n',b'\n')).hexdigest(),
        design=dict(seeds=list(range(60,64)),widths=[.3,.45,.6],noise=[.02,.08],distances=[.5,1.,1.5],amplitudes=[.25,.75,1.5],neighbor_sigma=.4,
            scope='Target peak count inside candidate pair; extra neighbor outside anchors is nuisance, not a target second base. Source anchors are fixed, including intentionally wrong double anchors for single truth.',
            screen='delta > 10, double relative RMS < .15, minor/major > .15; unchanged, illustrative only',
            preprocessing='Same per-dye slow fifth-percentile subtraction as app evidence before fit_pair; both original and default v1.9-resolved channels.',
            limitations='Paired conditions reuse noise and controls; trials are not independent biological observations. Added neighbor can overlap existing synthetic context; not a full sequence simulation. No saturation, drift, mixtures or empirical QV calibration.'),
        controls=summarize(list(controls.values())),contaminated=summarize(contaminated),paired_transitions=transitions,
        by_condition=[dict(side=side,distance=d,amplitude=a,counts=summarize([r for r in contaminated if r['side']==side and r['distance']==d and r['amplitude']==a]))
                      for side in ('left','right') for d in (.5,1.,1.5) for a in (.25,.75,1.5)])
    with gzip.open(args.output/'trials.json.gz','wt',encoding='utf-8') as f:json.dump(rows,f,allow_nan=False)
    (args.output/'summary.json').write_text(json.dumps(report,indent=2,allow_nan=False),encoding='utf-8')
    print(json.dumps({k:report[k] for k in ('controls','contaminated','paired_transitions')},indent=2))


if __name__=='__main__':main()
