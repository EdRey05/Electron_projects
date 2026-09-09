"""Seeded synthetic peak-recovery stress test, not a biological accuracy test.

Generate broadening, variable spacing, unequal dye gains, baseline and noise
from known impulses. Run the same resolution defaults used for the real plates.
Count prominent measured crests against known centers without changing calls.
"""
import argparse
import json
from pathlib import Path
import sys
import numpy as np
from scipy.signal import find_peaks
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from peaktrace.read import Trace
from peaktrace.config import parse_args
from peaktrace.resolution import resolve_channels


def score(channels,seq,positions,noise_free):
    result={'true_peaks':len(seq),'matched_peaks':0,'unmatched_peaks':0,'multiple_crests':0}
    for k in range(9,13):
        expected=positions[np.array([9+'GATC'.index(chr(b))==k for b in seq])]
        # Fixed threshold from the known noiseless peak scale, never tuned to output.
        threshold=.15*float(np.percentile(noise_free[k],99))
        peaks,_=find_peaks(channels[k],prominence=threshold,distance=3)
        assigned=set()
        for p in peaks:
            index=int(np.argmin(abs(expected-p)))
            if abs(expected[index]-p)>4:result['unmatched_peaks']+=1
            elif index in assigned:result['multiple_crests']+=1
            else:assigned.add(index);result['matched_peaks']+=1
    return result


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();settings=parse_args(['--input-dir','unused','--output-dir','unused'])
    rows=[]
    for noise in (0.,.02,.05,.10):
        for seed in range(8):
            rng=np.random.default_rng(seed)
            seq=np.frombuffer((('ACGT'*10+'ATTTTC'+'ACGT'*10+'CAAAAG')*2).encode(),np.uint8)
            positions=np.rint(30+np.cumsum(rng.uniform(11,13,len(seq)))).astype(int)
            x=np.arange(positions[-1]+50)
            clean={k:np.zeros(len(x)) for k in range(9,13)}
            for i,(base,position) in enumerate(zip(seq,positions)):
                width=4.+2.5*i/len(seq)
                amplitude=rng.uniform(80,120)
                clean[9+'GATC'.index(chr(base))]+=amplitude*np.exp(-.5*((x-position)/width)**2)
            measured={k:np.maximum(v+2+rng.normal(0,noise*100,len(x)),0) for k,v in clean.items()}
            trace=Trace(Path('synthetic'),measured,seq,np.full(len(seq),40,np.uint8),positions,{'FWO_1':b'GATC'})
            resolved,diagnostics=resolve_channels(trace,settings)
            rows.append({'noise_fraction':noise,'seed':seed,'resolved':diagnostics['resolved'],
                         'input':score(measured,seq,positions,clean),
                         'candidate':score(resolved,seq,positions,clean)})
    summaries=[]
    for noise in (0.,.02,.05,.10):
        group=[r for r in rows if r['noise_fraction']==noise]
        summaries.append({'noise_fraction':noise,'traces':len(group),
                          **{stage:{key:sum(r[stage][key] for r in group) for key in group[0][stage]}
                             for stage in ('input','candidate')}})
    result={'method':'Known synthetic centers; 15% noiseless p99 prominence; 4-sample matching tolerance',
            'parameters':{k:v for k,v in vars(settings).items() if not isinstance(v,Path)},
            'summary':summaries,'trials':rows}
    args.output.write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(summaries,indent=2))


if __name__=='__main__':main()
