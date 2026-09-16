"""Summarize native diagnostics and independently audit frozen-output parity."""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
from Bio import SeqIO
from task_paths import relocated


def tags(path):return SeqIO.read(path,'abi').annotations['abif_raw']
def screen(f):return f['available'] and f['delta_bic_two_over_one']>10 and f['double_relative_rms']<.15 and f['minor_major_amplitude_ratio']>.15
def median(values):return float(np.median(values)) if values else None


def main():
    p=argparse.ArgumentParser();p.add_argument('--task',type=Path,required=True);p.add_argument('--output',type=Path,required=True);args=p.parse_args()
    args.output.mkdir(parents=True,exist_ok=True);summary={};examples=[];hashes=set()
    for plate,expected in (('sample4',78),('sample5',68)):
        folder=args.task/'v2.0_validation/native_evidence'/plate/'9-v2.0-native-evidence-refined'
        files=sorted(folder.glob('*.evidence.json'));assert len(files)==expected,(plate,len(files))
        baseline=relocated(args.task,args.task/'v1.9_validation'/plate/'6-v1.9')
        ptfolder=(args.task/'v1.8_validation/sample4/3-P1905969_2026-08-28' if plate=='sample4' else args.task/'analysis_v1.7/samples/sample5/3-P1905972_2026-09-01')
        ptfolder=relocated(args.task,ptfolder)
        manifest=json.loads((folder/'run_manifest.json').read_text())
        sources={Path(r['out']):Path(r['src']) for r in manifest['files'] if r['status']=='ok'}
        rows=[];pairs=[];q20=q30=0
        for file in files:
            data=json.loads(file.read_text());prov=data['provenance'];hashes.add(prov['processor_source_sha256'])
            out=file.with_name(file.name.removesuffix('.evidence.json')+'.ab1')
            src=relocated(args.task,sources[out])
            assert hashlib.sha256(src.read_bytes()).hexdigest()==prov['source_sha256']
            a=tags(out);b=tags(baseline/out.name)
            assert json.loads(b['PT181'])['source_sha256']==prov['source_sha256']
            for key in ['PBAS1','PBAS2','PCON1','PCON2','PLOC1','PLOC2','P1AM1','phTR1','phTR2']+[f'DATA{i}' for i in (1,2,3,4,9,10,11,12)]:assert a[key]==b[key],(out.name,key)
            assert out.with_suffix('.seq').read_bytes()==(baseline/out.name).with_suffix('.seq').read_bytes()
            q=np.frombuffer(a['PCON2'],np.uint8);q20+=int((q>=20).sum());q30+=int((q>=30).sum())
            rows.extend(data['bases'])
            for pair in data['pairs']:
                pair={**pair,'file':str(file),'source':str(src),'out':str(out)};pairs.append(pair)
                if pair['original_fit']['available'] and pair['resolved_fit']['available'] and 100<=pair['left_index']<900:examples.append(pair)
        ptq=[np.frombuffer(tags(f)['PCON2'],np.uint8) for f in ptfolder.glob('*.ab1')]
        bands=[]
        for lo,hi in ((0,100),(100,600),(600,900),(900,100000)):
            selected=[r for r in rows if lo<=r['index']<hi and r['available']]
            ps=[r for r in pairs if lo<=r['left_index']<hi and r['original_fit']['available'] and r['resolved_fit']['available']]
            bands.append(dict(start_index=lo,end_index=hi,measured_bases=len(selected),modeled_pairs=len(ps),
                original_pair_screen=sum(screen(r['original_fit']) for r in ps),resolved_pair_screen=sum(screen(r['resolved_fit']) for r in ps),
                resolved_only_screen=sum(screen(r['resolved_fit']) and not screen(r['original_fit']) for r in ps),
                original_only_screen=sum(screen(r['original_fit']) and not screen(r['resolved_fit']) for r in ps),
                dominant_dye_unstable=sum(r['dominant_dye_changed'] is True for r in selected),
                median_crest_span_base=median([r['crest_span_base'] for r in selected if r['crest_span_base'] is not None]),
                **{stage:dict(median_competitor_ratio=median([r[stage]['competitor_ratio'] for r in selected if r[stage]['competitor_ratio'] is not None]),
                             median_noise_fraction=median([r[stage]['noise_fraction'] for r in selected if r[stage]['noise_fraction'] is not None])) for stage in ('original','resolved')}))
        summary[plate]=dict(files=len(files),all_exported_arrays_and_seq_equal_v19=True,source_hashes_verified=True,
                            q20=q20,q30=q30,pt_q20=sum(int((q>=20).sum()) for q in ptq),pt_q30=sum(int((q>=30).sum()) for q in ptq),
                            source_bases=len(rows),same_base_pairs=len(pairs),unmodeled_pairs=sum(not r['original_fit']['available'] for r in pairs),bands=bands)
    assert len(hashes)==1,hashes
    result=dict(processor_source_sha256=next(iter(hashes)),plates=summary)
    (args.output/'summary.json').write_text(json.dumps(result,indent=2))
    # Select explicit diagnostic categories, not a best-looking trace gallery.
    categories={'supported_pair':lambda r:screen(r['original_fit']) and screen(r['resolved_fit']),
                'resolved_only_pair':lambda r:not screen(r['original_fit']) and screen(r['resolved_fit'])}
    selected=[]
    for label,predicate in categories.items():
        candidates=[r for r in examples if predicate(r)]
        if candidates:selected.append(dict(category=label,**max(candidates,key=lambda r:(r['resolved_valley'] or 0)-(r['original_valley'] or 0))))
    (args.output/'examples.json').write_text(json.dumps(selected,indent=2))
    print(json.dumps(result,indent=2))


if __name__=='__main__':main()
