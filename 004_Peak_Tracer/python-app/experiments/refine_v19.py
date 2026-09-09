"""Small declared development sweep; no PeakTrace sequence or scores are read."""
import argparse
from copy import copy
import json
from pathlib import Path
import sys
import numpy as np
from scipy.signal import find_peaks,peak_widths
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from peaktrace.config import parse_args
from peaktrace.read import read_ab1
from peaktrace.resolution import resolve_channels


def measurements(trace,channels,return_pairs=False):
    """Pair contrast and upper-crest width on the input's fixed call grid."""
    out={name:{'pairs':0,'separated':0,'contrast_sum':0.,'crest_width_sum':0.,'crests':0}
         for name in ('q3_9','q10_19','q20_39','q40_plus')}
    def bucket(q):return 'q3_9' if q<10 else 'q10_19' if q<20 else 'q20_39' if q<40 else 'q40_plus'
    positions=trace.ploc_in;pb=trace.pb_in;qv=trace.qv_in;details={}
    for i in range(1,len(pb)-2):
        if qv[i]<3 or chr(pb[i]) not in 'ACGT':continue
        a=int(positions[i]);b=int(positions[i+1]);distance=b-a
        if distance<4:continue
        signal=channels[trace.channel_of_base[chr(pb[i])]]
        radius=max(1,int(distance*.3))
        if pb[i]==pb[i+1] and min(qv[i:i+2])>=3:
            pa=a-radius+int(np.argmax(signal[a-radius:a+radius+1]))
            lower=max(pa+1,b-radius)
            if lower>=len(signal):continue
            pp=lower+int(np.argmax(signal[lower:min(len(signal),b+radius+1)]))
            crest=min(signal[pa],signal[pp])
            if crest>0 and pp>pa+1:
                contrast=1-float(signal[pa:pp+1].min())/crest
                row=out[bucket(min(qv[i:i+2]))];row['pairs']+=1
                row['separated']+=int(contrast>=.15);row['contrast_sum']+=contrast
                details[(a,b)]={'group':bucket(min(qv[i:i+2])),'index':i,'contrast':contrast}
        # Upper width at 80% peak height measures angular/narrow crests locally.
        lo=max(0,a-radius);hi=min(len(signal),a+radius+1)
        p=lo+int(np.argmax(signal[lo:hi]));height=float(signal[p])
        if height<=0:continue
        left=p;right=p
        while left>0 and signal[left-1]>=.8*height:left-=1
        while right<len(signal)-1 and signal[right+1]>=.8*height:right+=1
        # Only isolated calls: a same-dye neighbor would turn a merged mountain
        # into an apparently desirable wide crest.
        if pb[i]!=pb[i-1] and pb[i]!=pb[i+1]:
            row=out[bucket(qv[i])];row['crests']+=1
            row['crest_width_sum']+=(right-left+1)/distance
    return (out,details) if return_pairs else out


SWEEPS={
 1:[('v18',.75,24,0.,0.),('r90_w14',.90,40,.14,1.),('r90_w18',.90,40,.18,1.),('r95_w18',.95,48,.18,1.),('r95_w22',.95,48,.22,1.),('r95_w18_n3',.95,48,.18,3.)],
 2:[('v18',.75,24,0.,0.),('r80_w06',.80,40,.06,1.),('r85_w10',.85,40,.10,1.),('r90_w12',.90,48,.12,1.),('r90_w16',.90,48,.16,1.),('r95_w14',.95,48,.14,1.)],
 3:[('v18',.75,24,0.,0.),('r80_w06',.80,40,.06,1.),('adaptive22',.80,40,.22,1.),('adaptive24',.80,40,.24,1.),('adaptive26',.80,40,.26,1.),('adaptive24_n3',.80,40,.24,3.)],
 4:[('v18',.75,24,0.,0.),('adaptive24_global',.80,40,.24,1.),('adaptive24_local',.80,40,.24,1.)],
}


def main():
    p=argparse.ArgumentParser();p.add_argument('--input',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True);p.add_argument('--sweep',type=int,choices=(1,2,3,4),default=4);args=p.parse_args()
    variants=SWEEPS[args.sweep]
    paths=sorted(args.input.glob('*.ab1'))
    # Deterministic coverage across filenames plus the two requested diagnostics.
    selected=set(paths[::8])
    selected.update(p for p in paths if p.name.startswith('POS1') or p.name.startswith('U0827P1A8._.ZV270402._.ZV270402-F1'))
    settings=parse_args(['--input-dir','unused','--output-dir','unused']);rows=[]
    for path in sorted(selected):
        trace=read_ab1(path)
        for name,strength,iterations,width,noise in variants:
            cfg=copy(settings);cfg.resolution_model='v18' if name=='v18' else 'v19'
            cfg.resolution_strength=strength;cfg.resolution_iterations=iterations
            cfg.peak_width=width;cfg.noise_regularization=noise
            cfg.adaptive_peak_width=name.startswith('adaptive')
            cfg.kernel_cap=5. if args.sweep==1 else 8.
            cfg.local_noise=name.endswith('_local')
            channels,diag=resolve_channels(trace,cfg)
            rows.append({'file':path.name,'variant':name,'metrics':measurements(trace,channels),'diagnostics':diag})
        print(path.name,flush=True)
    summary={}
    for name,*_ in variants:
        subset=[r for r in rows if r['variant']==name]
        summary[name]={group:{key:sum(r['metrics'][group][key] for r in subset)
                            for key in subset[0]['metrics'][group]} for group in subset[0]['metrics']}
    args.output.write_text(json.dumps({'sweep':args.sweep,'variants':variants,'files':[p.name for p in sorted(selected)],
                                      'summary':summary,'rows':rows},indent=2),encoding='utf-8')
    for name,groups in summary.items():
        print(name,{g:{'separated':round(r['separated']/max(r['pairs'],1)*100,2),
                       'upper_width':round(r['crest_width_sum']/max(r['crests'],1),3)} for g,r in groups.items()})


if __name__=='__main__':main()
