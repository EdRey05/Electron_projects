"""Independent BioPython audit of serialized v1.8 outputs and paired resolution.

Run with system Python (BioPython and numpy); no processing package imports.
The comparison is restricted to identical input/candidate call coordinates.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import numpy as np
from compare_plate import read, shape_pairs
from task_paths import archived_path


def main():
    parser=argparse.ArgumentParser()
    for name in ('input','candidate','output'):
        parser.add_argument('--'+name,type=Path,required=True)
    parser.add_argument('--ablation',type=Path)
    parser.add_argument('--frozen-manifest',type=Path)
    args=parser.parse_args()
    manifest=json.loads((args.candidate/'run_manifest.json').read_text())
    params=manifest['parameters']
    rows=[];failures=[]
    permitted={'PBAS1','PBAS2','PCON1','PCON2','PLOC1','PLOC2','P1AM1',
               'DATA9','DATA10','DATA11','DATA12','phTR1','phTR2','PT181'}
    for item in manifest['files']:
        src=args.input/Path(item['src']).name;out=archived_path(item['out'])
        original=read(src);candidate=read(out)
        a,b=original['tags'],candidate['tags']
        provenance=json.loads(b['PT181'].decode())
        checks={
            'source_hash_matches':hashlib.sha256(src.read_bytes()).hexdigest()==provenance['source_sha256'],
            'source_version_matches':provenance['processor_source_sha256']==manifest['processor_source_sha256'],
            'opaque_tags_preserved':all(b.get(k)==v for k,v in a.items() if k not in permitted),
            'call_sets_synchronized':all(b[tag+'1']==b[tag+'2'] for tag in ('PBAS','PCON','PLOC')),
            'strict_positions':bool(np.all(np.diff(candidate['p'])>0)),
            'positions_in_bounds':bool(np.all((candidate['p']>=0)&(candidate['p']<len(candidate['channels']['A'])))),
            'channel_lengths_preserved':all(len(candidate['channels'][k])==len(original['channels'][k]) for k in 'ACGT'),
        }
        lookup={}
        for i,p in enumerate(original['p']):
            if p not in lookup or original['q'][i]>original['q'][lookup[p]]:lookup[p]=i
        checks['no_new_positions']=all(p in lookup for p in candidate['p'])
        checks['quality_retained']=all(candidate['q'][j]==original['q'][lookup[p]] for j,p in enumerate(candidate['p']))
        checks['only_permitted_n_changes']=all(candidate['seq'][j]==original['seq'][lookup[p]] or
            (candidate['seq'][j]=='N' and original['q'][lookup[p]]<=params['qv_to_n_threshold'])
            for j,p in enumerate(candidate['p']))
        start,end=item['clear_start'],item['clear_end']
        expected=candidate['seq'][start:end] if params['seq_range']=='clear' else candidate['seq']
        if params['seq_format']=='abi':expected=(out.stem+'      \r\n')*2+expected
        checks['sequence_export_matches']=out.with_suffix('.seq').read_bytes()==expected.encode('ascii')
        checks['clear_range_matches']=b['phTR1']==((start,end-1) if end>start else (-1,-1))
        pa,pb=shape_pairs(original),shape_pairs(candidate)
        common=pa.keys()&pb.keys()
        row={'sample':src.name,'checks':checks,'paired_homopolymers':len(common),
             'newly_separated':sum(pa[k]<.15<=pb[k] for k in common),
             'lost_separation':sum(pb[k]<.15<=pa[k] for k in common),
             'mean_input_contrast':float(np.mean([pa[k] for k in common])) if common else None,
             'mean_candidate_contrast':float(np.mean([pb[k] for k in common])) if common else None}
        if args.ablation:
            ablation=read(args.ablation/out.name);pc=shape_pairs(ablation)
            row['ablation_pairs']=len(pc);row['ablation_separated']=sum(x>=.15 for x in pc.values())
        failures += [src.name+': '+name for name,ok in checks.items() if not ok]
        rows.append(row)
    frozen_ok=None
    if args.frozen_manifest:
        frozen=json.loads(args.frozen_manifest.read_text())
        frozen_ok=all(hashlib.sha256((args.input/r['input']).read_bytes()).hexdigest()==r['sha256'] for r in frozen['files'])
        if not frozen_ok:failures.append('Input changed since baseline freeze')
    result={'reads':len(rows),'processor_source_sha256':manifest['processor_source_sha256'],
            'all_checks_pass':not failures,'failures':failures,'frozen_input_hashes_match':frozen_ok,
            'paired_homopolymers':sum(r['paired_homopolymers'] for r in rows),
            'newly_separated':sum(r['newly_separated'] for r in rows),
            'lost_separation':sum(r['lost_separation'] for r in rows),
            'reads_with_net_separation_gain':sum(r['newly_separated']>r['lost_separation'] for r in rows),
            'reads_with_net_separation_loss':sum(r['newly_separated']<r['lost_separation'] for r in rows),
            'ablation_pairs':sum(r.get('ablation_pairs',0) for r in rows),
            'ablation_separated':sum(r.get('ablation_separated',0) for r in rows),'files':rows}
    args.output.write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in result.items() if k!='files'},indent=2))
    return int(bool(failures))


if __name__=='__main__':raise SystemExit(main())
