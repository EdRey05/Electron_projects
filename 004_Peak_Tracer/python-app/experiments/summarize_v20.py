"""Aggregate engine experiments and PT agreement (not accuracy)."""
import argparse
import json
from pathlib import Path
import numpy as np
from evaluate_v20 import abi,phd,stats
from compare_plate import agreement
from task_paths import archived_path


def main():
    p=argparse.ArgumentParser();p.add_argument('--results',type=Path,required=True)
    p.add_argument('--pt',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    a=p.parse_args();d=json.loads(a.results.read_text());totals={};rows=[]
    for r in d['reads']:
        outname=Path(r['sources']['v19']['path']).name
        matches=list(a.pt.rglob(outname))
        if not matches:
            matches=list(a.pt.rglob(Path(r['name']).name))
        if len(matches)!=1:raise ValueError(f'PT pairing ambiguous/missing: {outname}, {matches}')
        ref=abi(matches[0]);row={'name':r['name'],'methods':{}}
        methods={'seq7':abi(archived_path(r['sources']['seq7']['path'])),'v19':abi(archived_path(r['sources']['v19']['path'])),'pt':ref}
        for key,v in r['runs'].items():
            if 'error' not in v:methods[key]=phd(Path(v['phd']))
        for key,called in methods.items():
            st=stats(called);ag=agreement(called,ref)
            row['methods'][key]={'stats':st,'agreement':ag}
            agg=totals.setdefault(key,dict(reads=0,bases=0,q20=0,q30=0,nonincreasing_positions=0,
                                          q20_pt_mismatches=0,q20_pt_compared=0,insertions=0,deletions=0))
            agg['reads']+=1
            for field in ('bases','q20','q30','nonincreasing_positions'):agg[field]+=st[field]
            agg['q20_pt_mismatches']+=ag['q20_mismatches'];agg['q20_pt_compared']+=ag['q20_compared']
            agg['insertions']+=ag['internal_query_insertions'];agg['deletions']+=ag['internal_query_deletions']
        rows.append(row)
    a.output.write_text(json.dumps(dict(plate=d['plate'],totals=totals,reads=rows),indent=2))
    print(json.dumps(totals,indent=2))


if __name__=='__main__':main()
