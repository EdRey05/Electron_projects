"""Plot the frozen neighbor experiment without refitting or tuning a screen."""
import argparse
import json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--results',type=Path,required=True)
    args=parser.parse_args();data=json.loads((args.results/'summary.json').read_text())
    fig,axes=plt.subplots(1,2,figsize=(12,5),layout='constrained')
    for ax,family,label,field in zip(axes,('single','double'),('False target doubles','Missed target doubles'),('screen_pass','screen_not_pass')):
        for i,stage in enumerate(('original','resolved')):
            counts=[data[group][stage][family] for group in ('controls','contaminated')]
            values=[100*c[field]/c['n'] for c in counts]
            bars=ax.bar(np.arange(2)+(i-.5)*.34,values,.34,label=stage,color=('#6b7880','#008899')[i])
            ax.bar_label(bars,labels=[f"{c[field]}/{c['n']}" for c in counts],padding=3)
        ax.set(xticks=[0,1],xticklabels=['No added neighbor','Added same-dye neighbor'],ylim=(0,110),ylabel='Trials (%)',title=label)
        ax.legend();ax.spines[['top','right']].set_visible(False)
    fig.suptitle('Same-dye interference challenge: fixed illustrative screen\nPaired synthetic conditions; not biological accuracy or QV calibration')
    fig.savefig(args.results/'neighbor-screen.png',dpi=160);plt.close(fig)
    fig,axes=plt.subplots(1,2,figsize=(12,5),layout='constrained')
    for ax,stage in zip(axes,('original','resolved')):
        for i,family in enumerate(('single','double')):
            c=data['contaminated'][stage][family]
            counts=[c['screen_pass'],c['screen_pass']-c['passing_with_double_bound'],c['passing_with_no_bounds']]
            bars=ax.bar(np.arange(3)+(i-.5)*.34,counts,.34,label='False target double' if family=='single' else 'True target double',color=('#b35b38','#008899')[i])
            ax.bar_label(bars,padding=3)
        ax.set(xticks=[0,1,2],xticklabels=['Current screen','Also reject double\nboundaries','Also reject either\nmodel boundary'],ylabel='Passing cases (432 per truth class)',title=stage)
        ax.legend();ax.spines[['top','right']].set_visible(False)
    fig.suptitle('Boundary rejection tradeoff — retrospective counterfactual, not an app rule')
    fig.savefig(args.results/'neighbor-boundaries.png',dpi=160);plt.close(fig)


if __name__=='__main__':main()
