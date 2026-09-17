"""Render separate drift and saturation outcomes, with unchanged screen."""
import argparse
import json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np


def main():
    p=argparse.ArgumentParser();p.add_argument('--results',type=Path,required=True);args=p.parse_args()
    data=json.loads((args.results/'summary.json').read_text())
    fig,axes=plt.subplots(1,2,figsize=(12,5),layout='constrained')
    for ax,family,field,title in zip(axes,('single','double'),('screen_pass','screen_not_pass'),('False target doubles','Missed target doubles')):
        for i,stage in enumerate(('original','resolved')):
            counts=[data['groups'][g][stage][family] for g in ('control','drift','clipping')]
            bars=ax.bar(np.arange(3)+(i-.5)*.34,[100*c[field]/c['n'] for c in counts],.34,
                        label=stage,color=('#6b7880','#008899')[i])
            ax.bar_label(bars,labels=[f"{c[field]}/{c['n']}" for c in counts],padding=3)
        ax.set(xticks=[0,1,2],xticklabels=['Control','Baseline drift','Hard clipping'],ylim=(0,110),ylabel='Trials (%)',title=title)
        ax.legend();ax.spines[['top','right']].set_visible(False)
    fig.suptitle('Separate analyzed-signal artifact challenges\nPaired synthetic conditions; not instrument validation or QV calibration')
    fig.savefig(args.results/'artifact-screen.png',dpi=160);plt.close(fig)
    conditions=data['by_condition'][1:]
    fig,axes=plt.subplots(1,2,figsize=(12,7),layout='constrained')
    for ax,family,field,title in zip(axes,('single','double'),('screen_pass','screen_not_pass'),('False target doubles (%)','Missed target doubles (%)')):
        values=np.array([[100*c['counts'][s][family][field]/c['counts'][s][family]['n'] for s in ('original','resolved')] for c in conditions])
        im=ax.imshow(values,vmin=0,vmax=100,cmap='YlOrRd',aspect='auto')
        for row in range(len(conditions)):
            for col in range(2):ax.text(col,row,f'{values[row,col]:.1f}',ha='center',va='center',color='white' if values[row,col]>65 else 'black')
        ax.set(xticks=[0,1],xticklabels=['Original','Resolved'],yticks=range(len(conditions)),
               yticklabels=[f"{c['kind']} {c['level']:g}" for c in conditions],title=title)
    fig.colorbar(im,ax=axes,shrink=.65,label='Percent of 24 trials per truth class / condition')
    fig.suptitle('Artifact strength breakdown (no combined drift + clipping)')
    fig.savefig(args.results/'artifact-conditions.png',dpi=160);plt.close(fig)


if __name__=='__main__':main()
