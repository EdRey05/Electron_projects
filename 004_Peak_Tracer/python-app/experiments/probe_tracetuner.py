"""Black-box controls for analyzed-channel scoring and FWO mapping."""
import argparse
from dataclasses import replace
import itertools
import json
from pathlib import Path
import subprocess
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from peaktrace.abif import read_entries,pack_entries
from evaluate_v20 import phd


def main():
    p=argparse.ArgumentParser();p.add_argument('--input',type=Path,required=True)
    p.add_argument('--engine',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    a=p.parse_args();entries=read_entries(a.input.read_bytes());bykey={e.key:e for e in entries}
    order=bykey[(b'FWO_',1)].data.decode();cases={'baseline':entries}
    cases['raw_zero']=[replace(e,data=bytes(len(e.data))) if e.name==b'DATA' and 1<=e.number<=4 else e for e in entries]
    cases['qv_42']=[replace(e,data=bytes([42])*len(e.data)) if e.name==b'PCON' else e for e in entries]
    cases['analyzed_zero']=[replace(e,data=bytes(len(e.data))) if e.name==b'DATA' and 9<=e.number<=12 else e for e in entries]
    for perm in itertools.permutations('ACGT'):
        neworder=''.join(perm);updated=[]
        for e in entries:
            if e.key==(b'FWO_',1):e=replace(e,data=neworder.encode())
            elif e.name==b'DATA' and 9<=e.number<=12:
                other=bykey[(b'DATA',9+order.index(neworder[e.number-9]))];e=replace(e,data=other.data)
            updated.append(e)
        cases['fwo_'+neworder]=updated
    results={};base=None
    for name,data in cases.items():
        folder=a.output/name;folder.mkdir(parents=True,exist_ok=True)
        (folder/'trace.ab1').write_bytes(pack_entries(data))
        run=subprocess.run([str(a.engine.resolve()),'-3730','-recalln','-p','trace.ab1'],cwd=folder,capture_output=True,timeout=60)
        (folder/'stderr.txt').write_bytes(run.stderr)
        output=list(folder.glob('*.phd.1'));r={'returncode':run.returncode,'phd_count':len(output)}
        if len(output)==1 and not run.returncode:
            calls=phd(output[0])
            if name=='baseline':base=calls
            r['same_as_baseline']=calls==base
        results[name]=r
    (a.output/'probes.json').write_text(json.dumps(results,indent=2));print(json.dumps(results,indent=2))
    assert results['raw_zero']['same_as_baseline'] and results['qv_42']['same_as_baseline']
    assert all(results[k]['same_as_baseline'] for k in results if k.startswith('fwo_'))
    assert not results['analyzed_zero'].get('same_as_baseline',False)


if __name__=='__main__':main()
