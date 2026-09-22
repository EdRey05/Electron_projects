"""Read-only real-window audit. Descriptive shape flags are not saturation labels."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import sys
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from peaktrace.config import parse_args
from peaktrace.evidence import _signal, fit_pair
from peaktrace.provenance import processor_identity
from peaktrace.read import read_ab1
from peaktrace.resolution import resolve_channels
from neighbor_interference import passes, boundary
from task_paths import relocated

TARGETS={'POS1-G12_G12.ab1':[('pos1_resolution','CGCGAATTTT'),('pos1_insertions','CGAGACG')],
'U0827P1A8._.ZV270402._.ZV270402-F1._.U0827_B01.ab1':[('u0827_resolution','CTGGCGATATCAAAATT')]}


def flat_crests(signal,minimum=3):
    """Exact positive constant runs bracketed by lower samples, not a classifier."""
    a=np.asarray(signal);cuts=np.r_[0,np.flatnonzero(np.diff(a)!=0)+1,len(a)]
    return [dict(start=int(lo),end=int(hi),length=int(hi-lo),height=float(a[lo]))
            for lo,hi in zip(cuts[:-1],cuts[1:]) if hi-lo>=minimum and lo>0 and hi<len(a)
            and a[lo]>0 and a[lo-1]<a[lo] and a[hi]<a[lo]]


def geometry(signal,background,lo,hi):
    y=np.asarray(signal[lo:hi],float);peak=float(y.max())
    if peak<=0:return dict(available=False)
    crests=[r for r in flat_crests(signal) if lo<=r['start'] and r['end']<=hi and r['height']>=.8*peak]
    return dict(available=True,peak=peak,local_p05_over_peak=float(np.percentile(y,5)/peak),
                slow_background_range_over_peak=float(np.ptp(background[lo:hi])/peak),
                edge_max_over_peak=float(max(y[0],y[-1])/peak),high_flat_crests=crests)


def census(trace):
    result={}
    for key in [f'DATA{i}' for i in (1,2,3,4,9,10,11,12)]:
        a=np.asarray(trace.tags[key]);p99=float(np.percentile(a,99))
        runs=[r for r in flat_crests(a) if r['height']>=.8*p99]
        result[key]=dict(minimum=float(a.min()),maximum=float(a.max()),p99=p99,high_flat_crests=runs)
    return result


def main():
    p=argparse.ArgumentParser();p.add_argument('--task',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    p.add_argument('--scope',choices=['targets','plates'],default='targets');args=p.parse_args()
    if args.output.exists():p.error('Use a fresh output directory')
    args.output.mkdir(parents=True);config=parse_args(['--input-dir','unused','--output-dir','unused'])
    rows=[];windows=[]
    for plate,expected in [('sample4',78),('sample5',68)]:
        folder=args.task/'v2.0_validation/native_evidence'/plate/'9-v2.0-native-evidence-refined'
        manifest=json.loads((folder/'run_manifest.json').read_text())
        items=[r for r in manifest['files'] if r['status']=='ok'];assert len(items)==expected
        for item in items:
            source=relocated(args.task,Path(item['src']))
            if args.scope=='targets' and (plate!='sample4' or source.name not in TARGETS):continue
            trace=read_ab1(source)
            old=json.loads(Path(item['evidence']).read_text())
            sha=hashlib.sha256(source.read_bytes()).hexdigest();assert sha==old['provenance']['source_sha256']
            row=dict(plate=plate,file=source.name,source_sha256=sha,census=census(trace))
            if args.scope=='targets':
                resolved,_=resolve_channels(trace,config)
                spacing=float(np.median(np.diff(np.unique(trace.ploc_in))))
                original=_signal(trace.channels,spacing);enhanced=_signal(resolved,spacing)
                background=np.array([trace.channels[k] for k in range(9,13)])-original
                sequence=bytes(trace.pb_in).decode();pairs=[];matched=0
                for pair in old['pairs']:
                    if not pair['isolated_double']:continue
                    i=pair['left_index'];j=pair['right_index'];left,right=map(int,trace.ploc_in[[i,j]])
                    ch=trace.channel_of_base[pair['base']]-9
                    entry=dict(left_index=i,right_index=j,base=pair['base'])
                    for stage,a in [('original',original),('resolved',enhanced)]:
                        fit=fit_pair(a[ch],left,right);prior=pair[stage+'_fit']
                        # Added optimizer details may differ; every old result field must match.
                        assert all(fit[k]==v for k,v in prior.items()),(source.name,i,stage)
                        entry[stage]=fit
                    matched+=1
                    d=right-left;lo=max(0,left-d);hi=min(trace.n_scans,right+d+1)
                    entry['shape']=geometry(trace.channels[ch+9],background[ch],lo,hi)
                    pairs.append(entry)
                row.update(pairs=pairs,prior_pair_fields_exact_match=matched)
                # Saved trace remains immutable; no serialized output is produced here.
                ptroot=next((args.task/'shared_resources/samples'/plate).glob('3-*'))
                stem=Path(item['out']).stem
                ptfiles=list(ptroot.glob(stem+'*.ab1'));assert len(ptfiles)==1,(stem,ptfiles)
                pt=read_ab1(ptfiles[0])
                for label,motif in TARGETS[source.name]:
                    start=sequence.find(motif);assert start>=0 and sequence.count(motif)==1
                    begin=max(0,start-2);end=min(len(sequence)-1,start+(24 if label=='pos1_insertions' else len(motif)+7))
                    lo,hi=map(int,trace.ploc_in[[begin,end]])
                    w=dict(label=label,file=source.name,motif=motif,source_start_call=begin+1,source_end_call=end,
                           source_scan_bounds=[lo,hi],stages=[],repeat_runs=[])
                    for stage,t,channels in [('original',trace,trace.channels),('resolved',trace,resolved),('PT comparator',pt,pt.channels)]:
                        seq=bytes(t.pb_in).decode();s=seq.find(motif)
                        if s<0 or seq.count(motif)!=1:
                            w['stages'].append(dict(stage=stage,available=False,reason='motif absent or nonunique'));continue
                        b=max(0,s-2);e=min(len(seq)-1,s+(24 if label=='pos1_insertions' else len(motif)+7))
                        low,high=map(int,t.ploc_in[[b,e]])
                        w['stages'].append(dict(stage=stage,available=True,x=(np.arange(low,high)-int(t.ploc_in[s])).tolist(),
                            channels={base:channels[ch][low:high].tolist() for base,ch in t.channel_of_base.items()},
                            calls=seq[b:e],positions=(t.ploc_in[b:e]-t.ploc_in[s]).tolist(),qv=t.qv_in[b:e].tolist(),
                            baseline={base:background[ch-9,low:high].tolist() for base,ch in t.channel_of_base.items()} if stage=='original' else None))
                    i=0
                    while i<end:
                        j=i+1
                        while j<len(sequence) and sequence[j]==sequence[i]:j+=1
                        if j-i>=2 and j>begin and sequence[i] in 'ACGT':
                            ch=trace.channel_of_base[sequence[i]]-9
                            left,right=map(int,trace.ploc_in[[i,j-1]])
                            d=max(1,int(spacing));g=geometry(trace.channels[ch+9],background[ch],max(0,left-d),min(trace.n_scans,right+d+1))
                            w['repeat_runs'].append(dict(base=sequence[i],count=j-i,start_call=i+1,end_call=j,qv=trace.qv_in[i:j].tolist(),
                                model_eligible=j-i==2,shape=g))
                        i=j
                    w['pairs']=[v for v in pairs if begin<=v['left_index']<end]
                    windows.append(w)
            rows.append(row)
            print(f"audited {plate}/{source.name}",flush=True)
    report=dict(scope=args.scope,processor=processor_identity(),experiment_sha256=hashlib.sha256(Path(__file__).read_bytes().replace(b'\r\n',b'\n')).hexdigest(),files=len(rows),source_hashes_verified=True,
        definition='Exact positive flat crest >=3 scans, bracketed by lower values. Census height >=80% of per-channel p99; local window height >=80% of window maximum. Descriptive, not a saturation detector. Raw DATA1-4 are indexed only; no raw/analyzed coordinate mapping inferred.',
        limitations='Quantization can create plateaus; no known instrument ceiling or calibrated baseline truth. Local floor and edges can contain real neighboring peaks. PT is a comparator, not truth.',
        rows=rows,windows=windows)
    with gzip.open(args.output/'audit.json.gz','wt',encoding='utf-8') as f:json.dump(report,f,allow_nan=False)
    summary=dict(scope=args.scope,files=len(rows),source_hashes_verified=True,
        high_flat_crest_reads={group:sum(any(r['census'][f'DATA{i}']['high_flat_crests'] for i in indices) for r in rows)
                              for group,indices in [('raw',(1,2,3,4)),('analyzed',(9,10,11,12))]},
        target_windows=[{k:v for k,v in w.items() if k not in ('stages','pairs')} for w in windows],
        target_pairs=[dict(file=r['file'],n=len(r.get('pairs',[])),prior_fields_exact_match=r.get('prior_pair_fields_exact_match'),
            **{stage:dict(unavailable=sum(not p[stage]['available'] for p in r.get('pairs',[])),passes=sum(passes(p[stage]) for p in r.get('pairs',[])),passing_with_double_bound=sum(passes(p[stage]) and boundary(p[stage],'double') for p in r.get('pairs',[]))) for stage in ('original','resolved')}) for r in rows] if args.scope=='targets' else [])
    (args.output/'summary.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
    print(json.dumps(summary,indent=2))


if __name__=='__main__':main()
