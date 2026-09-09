"""Report base-aware raw/KB anchor diagnostics without altering AB1 outputs."""
import argparse
import json
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from peaktrace.read import read_ab1
from peaktrace.raw_mapping import map_raw_anchors


def main():
    p=argparse.ArgumentParser();p.add_argument('--input',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True);args=p.parse_args()
    rows=[]
    for path in sorted(args.input.glob('*.ab1')):
        result=map_raw_anchors(read_ab1(path));rows.append({'file':path.name,**result})
    summary={'reads':len(rows),'accepted':sum(r['accepted'] for r in rows),
             'rejected':[{'file':r['file'],'reason':r['reason']} for r in rows if not r['accepted']]}
    args.output.write_text(json.dumps({'summary':summary,'files':rows},indent=2),encoding='utf-8')
    print(json.dumps(summary,indent=2))


if __name__=='__main__':main()
