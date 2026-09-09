"""Scientific summary figure from saved fixed-region metrics; no processing."""
import argparse
import json
from pathlib import Path
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--docs',type=Path,required=True);args=parser.parse_args()
    fig,axes=plt.subplots(2,2,figsize=(12,8),layout='constrained')
    colors={'input':'#a1aab0','v18':'#368cbf','v19':'#e18436'}
    for row,plate in enumerate(('sample4','sample5')):
        result=json.loads((args.docs/f'{plate}_regions.json').read_text())
        groups=list(result['summary']['input']);x=np.arange(len(groups))
        for i,stage in enumerate(('input','v18','v19')):
            values=[100*result['summary'][stage][g]['separated']/result['summary'][stage][g]['pairs'] for g in groups]
            axes[row,0].bar(x+(i-1)*.24,values,width=.23,color=colors[stage],label=stage)
        axes[row,0].set_xticks(x,['Q3–9','Q10–19','Q20–39','Q40+'])
        axes[row,0].set_title(plate+' — grouped by original Seq7 quality')
        regions=result['regions'];x=np.arange(len(regions))
        for i,stage in enumerate(('v18','v19')):
            values=[100*r[stage+'_separated']/r['common_pairs'] for r in regions.values()]
            axes[row,1].bar(x+(i-.5)*.3,values,width=.29,color=colors[stage],label=stage)
        axes[row,1].set_xticks(x,['1–300','301–600','601–900','901+'])
        axes[row,1].set_title(plate+' — original Seq7 base-index region')
        for ax in axes[row]:
            ax.set_ylim(0,105);ax.set_ylabel('Separated repeated-base pairs (%)')
            ax.spines[['top','right']].set_visible(False)
            ax.legend(frameon=False,fontsize=8)
    fig.suptitle('v1.9: fixed-input pair resolution\nDescriptive valley threshold ≥15%; these are not basecalling accuracy percentages',fontsize=13)
    fig.savefig(args.docs/'figures/region_summary.png',dpi=160)


if __name__=='__main__':main()
