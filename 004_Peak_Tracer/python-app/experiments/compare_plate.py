"""Compare input, frozen baseline and candidate against a paired PT comparator.

No reference is passed to the processing pipeline. These are comparator
agreement metrics, not biological accuracy. Input and output arrays are plotted
on their own scan grids around independently found motifs.
"""
import argparse
import csv
import hashlib
import json
import re
from pathlib import Path
import numpy as np
from Bio import SeqIO, Align


def read(path):
    t=SeqIO.read(path,'abi').annotations['abif_raw']
    return {'path':path,'tags':t,'seq':t['PBAS2'].decode(),
            'q':np.frombuffer(t['PCON2'],np.uint8),'p':np.array(t['PLOC2']),
            'channels':{b:np.array(t[f'DATA{i+9}']) for i,b in enumerate(t['FWO_1'].decode())}}


def agreement(query,ref):
    a=Align.PairwiseAligner();a.match_score=2;a.mismatch_score=-3
    a.open_gap_score=-5;a.extend_gap_score=-1;a.open_end_gap_score=0;a.extend_end_gap_score=0
    alignment=a.align(query['seq'],ref['seq'])[0];c=alignment.coordinates
    out={'matches':0,'mismatches':0,'ambiguous':0,'q20_compared':0,'q20_mismatches':0,
         'internal_query_insertions':0,'internal_query_deletions':0,'terminal_query':0,'terminal_ref':0}
    for k in range(c.shape[1]-1):
        i,j=c[:,k];ii,jj=c[:,k+1]
        if ii>i and jj>j:
            for u,v in zip(range(i,ii),range(j,jj)):
                x,y=query['seq'][u],ref['seq'][v]
                if x not in 'ACGT' or y not in 'ACGT':out['ambiguous']+=1;continue
                out['matches' if x==y else 'mismatches']+=1
                if ref['q'][v]>=20:
                    out['q20_compared']+=1;out['q20_mismatches']+=int(x!=y)
        elif ii>i:out['terminal_query' if j in (0,len(ref['seq'])) else 'internal_query_insertions']+=int(ii-i)
        else:out['terminal_ref' if i in (0,len(query['seq'])) else 'internal_query_deletions']+=int(jj-j)
    return out


def stats(rec):
    return {'bases':len(rec['seq']),'n':rec['seq'].count('N'),'q20':int((rec['q']>=20).sum()),
            'q30':int((rec['q']>=30).sum()),'nonincreasing_ploc':int((np.diff(rec['p'])<=0).sum()),
            'scans':len(rec['channels']['A'])}


def input_coordinate_changes(rec, source):
    """Audit call changes without realigning after N masking.

    Meaningful for input/v1.8, whose analyzed coordinate grids are identical.
    Baseline positions are also on the input grid, though its raw mapping was unsafe.
    """
    lookup={}
    for i,p in enumerate(source['p']):
        if p not in lookup or source['q'][i]>source['q'][lookup[p]]:lookup[p]=i
    counts={'new_call_positions':0,'retained_position_substitutions':0,
            'retained_position_n_masked':0,'retained_position_qv_increases':0}
    if rec is source:return counts
    for j,p in enumerate(rec['p']):
        if p not in lookup:counts['new_call_positions']+=1;continue
        i=lookup[p]
        if rec['seq'][j]!=source['seq'][i]:
            counts['retained_position_n_masked' if rec['seq'][j]=='N' else 'retained_position_substitutions']+=1
        counts['retained_position_qv_increases']+=int(rec['q'][j]>source['q'][i])
    return counts


def shape_pairs(rec):
    """Local valleys for adjacent same-base Q20 calls; no gain dependence.

    This measures visual resolution, not whether the underlying call count is true.
    """
    contrasts={}
    for i in range(1,len(rec['p'])-2):
        base=rec['seq'][i]
        if base not in 'ACGT' or rec['seq'][i+1]!=base or min(rec['q'][i:i+2])<20:continue
        a,b=map(int,rec['p'][i:i+2]);distance=b-a
        if distance<4:continue
        signal=rec['channels'][base];radius=max(1,int(distance*.3))
        left=max(0,a-radius);right=min(len(signal),b+radius+1)
        pa=left+int(np.argmax(signal[left:min(a+radius+1,b)]))
        pb=max(pa+1,b-radius)+int(np.argmax(signal[max(pa+1,b-radius):right]))
        crest=min(float(signal[pa]),float(signal[pb]))
        if crest<=0 or pb<=pa+1:continue
        contrast=1-float(signal[pa:pb+1].min())/crest
        contrasts[(a,b,base)]=contrast
    return contrasts


def shape_metrics(rec):
    contrasts=list(shape_pairs(rec).values())
    separated=sum(c>=.15 for c in contrasts)
    return {'homopolymer_pairs':len(contrasts),'separated_pairs':separated,
            'valley_contrast_sum':float(sum(contrasts))}


def plots(records,out):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    colors={'A':'#249645','C':'#2675cd','G':'#242424','T':'#d54a49','N':'#999999'}
    labels={'input':'2 - Seq7 input','reference':'3 - PeakTrace comparator','baseline':'4 - Frozen v1.7','candidate':'5 - v1.8'}
    evidence={}
    for key,(sample,motif) in {'pos1_resolution':('POS1','CGCGAATTTT'),
            'pos1_insertions':('POS1','CGAGACG'),
            'u0827_resolution':('U0827P1A8._.ZV270402._.ZV270402-F1','CTGGCGATATCAAAATT')}.items():
        matched=next((v for name,v in records.items() if name.startswith(sample)),None)
        if matched is None:continue
        fig,axes=plt.subplots(4,1,figsize=(15,11))
        fig.subplots_adjust(left=.065,right=.985,top=.91,bottom=.06,hspace=.65)
        evidence[key]={}
        for ax,stage in zip(axes,labels):
            r=matched[stage];start=r['seq'].find(motif)
            if start<0:ax.text(.1,.5,'Motif not found; see aligned metrics');continue
            count=24 if key=='pos1_insertions' else len(motif)+7
            begin=max(0,start-2);end=min(len(r['p'])-1,start+count)
            lo,hi=int(r['p'][begin]),int(r['p'][end]);anchor=int(r['p'][start])
            scale=max(float(max(v[lo:hi].max() for v in r['channels'].values())),1)
            for base,signal in r['channels'].items():ax.plot(np.arange(lo,hi)-anchor,signal[lo:hi]/scale,color=colors[base],lw=1.1)
            for i in range(begin,end):ax.text(r['p'][i]-anchor,1.04,r['seq'][i],ha='center',color=colors.get(r['seq'][i],'#777777'),fontsize=8)
            ax.set_ylim(-.02,1.17);ax.set_ylabel('Relative signal');ax.set_title(labels[stage],loc='left',fontsize=11)
            ax.set_xlabel('Analyzed samples from motif start (each file has its own grid)')
            ax.spines[['top','right']].set_visible(False)
            evidence[key][stage]={'sequence':r['seq'][begin:end],'start_base':begin+1}
        fig.suptitle(key.replace('_',' ').title()+'\nSignal drawn from saved AB1; one common dye gain within each panel.',fontsize=13)
        fig.savefig(out/(key+'.png'),dpi=150);plt.close(fig)
    sample=next((v for name,v in records.items() if name.startswith('U0827P1A8._.ZV270402._.ZV270402-F1')),None)
    if sample:
        fig,axes=plt.subplots(4,1,figsize=(15,9),layout='constrained',sharex=True)
        for ax,stage in zip(axes,labels):
            r=sample[stage];ax.plot(np.arange(len(r['q']))+1,r['q'],lw=.6,color='#3876a4');ax.axhline(20,color='gray',ls='--',lw=.7)
            ax.set_ylim(0,65);ax.set_ylabel('Stored QV');ax.set_title(labels[stage],loc='left')
        axes[-1].set_xlabel('File base index; this is not a sequence alignment')
        fig.suptitle('U0827P1A8 F1 quality: retained KB QVs are not inflated by display processing')
        fig.savefig(out/'u0827_quality.png',dpi=150);plt.close(fig)
    (out/'motifs.json').write_text(json.dumps(evidence,indent=2),encoding='utf-8')


def main():
    p=argparse.ArgumentParser();p.add_argument('--input',type=Path,required=True)
    for name in ('reference','baseline','candidate','output'):p.add_argument('--'+name,type=Path,required=True)
    p.add_argument('--plots',action='store_true');args=p.parse_args();args.output.mkdir(parents=True,exist_ok=True)
    records={};rows=[];summary={}
    for src in sorted(args.input.glob('*.ab1')):
        stem=re.sub(r'_[A-H]\d{2}$','',src.stem)
        rr={'input':read(src)}
        for stage in ('reference','baseline','candidate'):rr[stage]=read(getattr(args,stage)/(stem+'.ab1'))
        records[src.name]=rr
        for stage,rec in rr.items():
            row={'sample':src.name,'stage':stage,**stats(rec),**shape_metrics(rec)}
            if stage!='reference':
                row.update(agreement(rec,rr['reference']))
                row.update(input_coordinate_changes(rec,rr['input']))
            row['raw_preserved']=int(all(rr['input']['tags'].get(f'DATA{k}')==rec['tags'].get(f'DATA{k}') for k in range(1,5)))
            row['sha256']=hashlib.sha256(rec['path'].read_bytes()).hexdigest()
            rows.append(row)
    for stage in ('input','reference','baseline','candidate'):
        rs=[r for r in rows if r['stage']==stage]
        summary[stage]={key:sum(r.get(key,0) for r in rs) for key in rs[0] if isinstance(rs[0][key],(int,float))}
        summary[stage]['reads']=len(rs)
    keys=list(dict.fromkeys(k for row in rows for k in row))
    with (args.output/'per_read.csv').open('w',newline='',encoding='utf-8') as f:
        w=csv.DictWriter(f,fieldnames=keys);w.writeheader();w.writerows(rows)
    (args.output/'metrics.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
    if args.plots:plots(records,args.output)
    print(json.dumps(summary,indent=2))


if __name__=='__main__':main()
