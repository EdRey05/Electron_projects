"""Fixed-input-region resolution audit: improvements AND regressions versus v1.8."""
import argparse
import json
from pathlib import Path
import re
import sys
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from peaktrace.read import read_ab1
from refine_v19 import measurements


def main():
    p=argparse.ArgumentParser()
    for name in ('input','baseline','candidate','output'):p.add_argument('--'+name,type=Path,required=True)
    args=p.parse_args();rows=[]
    for src in sorted(args.input.glob('*.ab1')):
        trace=read_ab1(src);name=re.sub(r'_[A-H]\d{2}$','',src.stem)+'.ab1'
        baseline=read_ab1(args.baseline/name);candidate=read_ab1(args.candidate/name)
        metrics={};pairs={}
        for stage,channels in [('input',trace.channels),('v18',baseline.channels),('v19',candidate.channels)]:
            metrics[stage],pairs[stage]=measurements(trace,channels,return_pairs=True)
        changes={g:{'common_pairs':0,'gained':0,'lost':0} for g in metrics['input']}
        regions={g:{'common_pairs':0,'v18_separated':0,'v19_separated':0,'gained':0,'lost':0}
                 for g in ('bases_1_300','bases_301_600','bases_601_900','bases_901_plus')}
        for key in pairs['v18'].keys()&pairs['v19'].keys():
            before=pairs['v18'][key];after=pairs['v19'][key]
            old=before['contrast']>=.15;new=after['contrast']>=.15
            row=changes[before['group']];row['common_pairs']+=1
            row['gained']+=int(new and not old);row['lost']+=int(old and not new)
            index=before['index'];group='bases_1_300' if index<300 else 'bases_301_600' if index<600 else 'bases_601_900' if index<900 else 'bases_901_plus'
            region=regions[group];region['common_pairs']+=1
            region['v18_separated']+=int(old);region['v19_separated']+=int(new)
            region['gained']+=int(new and not old);region['lost']+=int(old and not new)
        provenance18=json.loads(baseline.tags['PT181'].decode())
        provenance19=json.loads(candidate.tags['PT181'].decode())
        contract={'calls_identical':bool(np.array_equal(baseline.pb_in,candidate.pb_in)),
                  'qualities_identical':bool(np.array_equal(baseline.qv_in,candidate.qv_in)),
                  'positions_identical':bool(np.array_equal(baseline.ploc_in,candidate.ploc_in)),
                  'same_source_hash':provenance18['source_sha256']==provenance19['source_sha256'],
                  'sequence_exports_identical':(args.baseline/name).with_suffix('.seq').read_bytes()==(args.candidate/name).with_suffix('.seq').read_bytes()}
        rows.append({'file':src.name,'metrics':metrics,'changes':changes,'regions':regions,'version_contract':contract})
    summary={stage:{g:{k:sum(r['metrics'][stage][g][k] for r in rows) for k in rows[0]['metrics'][stage][g]}
                    for g in rows[0]['metrics'][stage]} for stage in ('input','v18','v19')}
    changes={g:{k:sum(r['changes'][g][k] for r in rows) for k in rows[0]['changes'][g]} for g in rows[0]['changes']}
    regions={g:{k:sum(r['regions'][g][k] for r in rows) for k in rows[0]['regions'][g]} for g in rows[0]['regions']}
    per_read_net=[sum(x['gained']-x['lost'] for x in r['changes'].values()) for r in rows]
    result={'reads':len(rows),'summary':summary,'paired_changes':changes,'regions':regions,
            'reads_net_gain':sum(v>0 for v in per_read_net),'reads_net_loss':sum(v<0 for v in per_read_net),
            'files':rows}
    result['version_contract_pass_counts']={k:sum(r['version_contract'][k] for r in rows) for k in rows[0]['version_contract']}
    args.output.write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in result.items() if k!='files'},indent=2))


if __name__=='__main__':main()
