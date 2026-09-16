"""Audit saved v2.0 AB1s and report fixed-call QV changes vs frozen v1.9.

PT confidence-discordance curves are descriptive, not empirical calibration:
they exclude indels/ambiguous calls and PT itself is not independent truth.
"""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
from Bio import SeqIO,Align
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from evaluate_v20 import abi,stats
from task_paths import relocated


def main():
    p=argparse.ArgumentParser();p.add_argument('--task',type=Path,required=True)
    p.add_argument('--plate',choices=('sample4','sample5'),required=True);p.add_argument('--output',type=Path,required=True)
    a=p.parse_args();a.output.mkdir(parents=True,exist_ok=True)
    baseline=a.task/f'v1.9_validation/{a.plate}/6-v1.9';candidate=a.task/f'v2.0_validation/{a.plate}/7-v2.0-experimental-qv'
    baseline=relocated(a.task,baseline)
    pt=(a.task/'v1.8_validation/sample4/3-P1905969_2026-08-28' if a.plate=='sample4' else
        a.task/'analysis_v1.7/samples/sample5/3-P1905972_2026-09-01')
    pt=relocated(a.task,pt)
    manifest=json.loads((candidate/'run_manifest.json').read_text());rows=[];failures=[]
    aggregates={k:dict(bases=0,q20=0,q30=0,n=0) for k in ('v19','v20','pt')}
    bins=[(0,10),(10,20),(20,30),(30,40),(40,94)]
    discord={k:[dict(compared=0,disagree=0) for _ in bins] for k in ('v19','v20')}
    profiles={k:[] for k in aggregates};region_counts={k:[dict(n=0,q20=0,q30=0) for _ in range(4)] for k in aggregates}
    aligner=Align.PairwiseAligner();aligner.match_score=2;aligner.mismatch_score=-3
    aligner.open_gap_score=-5;aligner.extend_gap_score=-1;aligner.open_end_gap_score=0;aligner.extend_end_gap_score=0
    for item in manifest['files']:
        if 'out' not in item:failures.append(item);continue
        path=Path(item['out'])
        if not path.exists():failures.append(item);continue
        oldpath=baseline/path.name;old=abi(oldpath);new=abi(path)
        oldtags=SeqIO.read(oldpath,'abi').annotations['abif_raw'];tags=SeqIO.read(path,'abi').annotations['abif_raw']
        source=relocated(a.task,item['src']);originaltags=SeqIO.read(source,'abi').annotations['abif_raw']
        provenance=json.loads(tags['PT181'])
        refpaths=list(pt.rglob(path.name))
        if len(refpaths)!=1:raise ValueError('PT pairing failed: '+path.name)
        ref=abi(refpaths[0]);checks=dict(
            sequence_retained=old['seq']==new['seq'],positions_retained=old['p']==new['p'],
            signal_retained=all(oldtags[f'DATA{i}']==tags[f'DATA{i}'] for i in range(9,13)),
            raw_retained=all(originaltags[f'DATA{i}']==tags[f'DATA{i}'] for i in range(1,5)),
            opaque_retained=all(tags.get(k)==v for k,v in oldtags.items() if k not in ('PCON1','PCON2','phTR1','phTR2','PT181')),
            call_sets_synchronized=all(tags[x+'1']==tags[x+'2'] for x in ('PBAS','PCON','PLOC')),
            source_hash=provenance['source_sha256']==hashlib.sha256(source.read_bytes()).hexdigest(),
            source_version=provenance['processor_source_sha256']==manifest['processor_source_sha256'],
            strict_positions=bool(np.all(np.diff(new['p'])>0)),
            ambiguous_q0=all(q==0 for b,q in zip(new['seq'],new['q']) if b not in 'ACGT'))
        start,end=item['clear_start'],item['clear_end']
        checks['clear_range']=tags['phTR1']==((start,end-1) if end>start else (-1,-1))
        checks['sequence_export']=path.with_suffix('.seq').read_text()==new['seq'][start:end]
        row=dict(name=path.name,checks=checks,old=stats(old),new=stats(new),pt=stats(ref),
                 qv_increases=int((np.array(new['q'])>old['q']).sum()),qv_decreases=int((np.array(new['q'])<old['q']).sum()),
                 baseline_sha256=hashlib.sha256(oldpath.read_bytes()).hexdigest())
        for key,r in [('v19',old),('v20',new),('pt',ref)]:
            s=stats(r)
            for field in aggregates[key]:aggregates[key][field]+=s[field]
            q=np.array(r['q'])
            for i,(lo,hi) in enumerate([(0,300),(300,600),(600,900),(900,1200)]):
                region_counts[key][i]['n']+=len(q[lo:hi]);region_counts[key][i]['q20']+=int((q[lo:hi]>=20).sum())
                region_counts[key][i]['q30']+=int((q[lo:hi]>=30).sum())
        c=aligner.align(old['seq'],ref['seq'])[0].coordinates
        for index in range(c.shape[1]-1):
            x,y=c[:,index];xx,yy=c[:,index+1]
            if xx<=x or yy<=y:continue
            for u,v in zip(range(x,xx),range(y,yy)):
                if old['seq'][u] not in 'ACGT' or ref['seq'][v] not in 'ACGT' or ref['q'][v]<30:continue
                for key,r in [('v19',old),('v20',new)]:
                    q=r['q'][u];idx=next(i for i,(lo,hi) in enumerate(bins) if lo<=q<hi)
                    discord[key][idx]['compared']+=1;discord[key][idx]['disagree']+=int(old['seq'][u]!=ref['seq'][v])
        if any(not v for v in checks.values()):failures.append({'name':path.name,'checks':checks})
        rows.append(row)
        if a.plate=='sample4' and ('POS1' in path.name or ('ZV270402-F1' in path.name and 'P1A8.' in path.name)):
            fig,axes=plt.subplots(3,1,figsize=(12,8),sharex=True)
            for ax,(key,r,color) in zip(axes,[('v1.9 / inherited Seq7',old,'#777777'),('v2.0 experimental',new,'#187a83'),('PeakTrace comparator',ref,'#6954a3')]):
                q=np.array(r['q']);ax.fill_between(np.arange(1,len(q)+1),q,color=color,alpha=.55,linewidth=0)
                ax.axhline(20,color='black',lw=.6,ls='--');ax.axhline(30,color='black',lw=.6,ls=':')
                ax.set_ylim(0,65);ax.set_ylabel('QV');ax.set_title(key,loc='left',fontsize=10)
            axes[-1].set_xlabel('Base index in each output (different PT calls; not a sequence alignment)')
            fig.suptitle(path.name+'\nPublished-table estimates; independent calibration remains pending',fontsize=10)
            fig.tight_layout();fig.savefig(a.output/('pos1_quality.png' if 'POS1' in path.name else 'u0827_quality.png'),dpi=150);plt.close(fig)
    result=dict(plate=a.plate,processor_source_sha256=manifest['processor_source_sha256'],totals=aggregates,
                region_counts=region_counts,pt_q30_substitution_discordance=discord,
                failures=failures,reads=rows)
    (a.output/'audit.json').write_text(json.dumps(result,indent=2))
    fig,axes=plt.subplots(1,2,figsize=(12,4))
    for k,color,offset in [('v19','#777777',-.25),('v20','#187a83',0),('pt','#6954a3',.25)]:
        for ax,threshold in zip(axes,['q20','q30']):
            vals=[100*r[threshold]/r['n'] if r['n'] else 0 for r in region_counts[k]]
            ax.bar(np.arange(4)+offset,vals,.25,color=color,label=k)
            ax.set_xticks(range(4),['1–300','301–600','601–900','901–1200']);ax.set_ylim(0,105)
            ax.set_ylabel('% bases at '+threshold.upper()+' or above');ax.set_xlabel('Own-output base index')
    axes[1].legend();fig.suptitle(a.plate+': predicted confidence, not demonstrated accuracy');fig.tight_layout()
    fig.savefig(a.output/'quality_regions.png',dpi=150);plt.close(fig)
    print(json.dumps({k:result[k] for k in ('plate','totals','failures','pt_q30_substitution_discordance')},indent=2))


if __name__=='__main__':main()
