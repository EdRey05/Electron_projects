"""Plot fixed original issue windows; PT uses its own motif coordinates."""
import argparse,gzip,json
from pathlib import Path
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt


def main():
    p=argparse.ArgumentParser();p.add_argument('--results',type=Path,required=True);args=p.parse_args()
    data=json.loads(gzip.decompress((args.results/'audit.json.gz').read_bytes()))
    colors={'A':'#249645','C':'#2675cd','G':'#222222','T':'#d54a49','N':'#777777'}
    for w in data['windows']:
        fig,axes=plt.subplots(3,1,figsize=(13,9),layout='constrained')
        for ax,stage in zip(axes,w['stages']):
            ax.set_title(stage['stage'],loc='left')
            if not stage['available']:
                ax.text(.1,.5,stage['reason'],transform=ax.transAxes);continue
            gain=max(1,max(max(v) for v in stage['channels'].values()))
            for base,signal in stage['channels'].items():
                ax.plot(stage['x'],np.array(signal)/gain,color=colors[base],label=base,lw=1.2)
                if stage['baseline'] is not None:
                    ax.plot(stage['x'],np.array(stage['baseline'][base])/gain,color=colors[base],ls=':',alpha=.8,lw=.8)
            for base,pos in zip(stage['calls'],stage['positions']):
                ax.text(pos,1.06,base,color=colors.get(base,'#777'),ha='center',fontsize=8)
            ax.set(ylim=(-.02,1.16),xlabel='Analyzed samples from motif start (each panel has its own grid)',ylabel='Relative intensity')
            ax.spines[['top','right']].set_visible(False)
        axes[0].legend(ncol=4,loc='upper right')
        fig.suptitle(w['label'].replace('_',' ').title()+f" | source calls {w['source_start_call']}–{w['source_end_call']}\nOriginal and recomputed floating-point resolution; PT comparator is not truth. Dotted: slow baseline estimate.",fontsize=11)
        fig.savefig(args.results/(w['label']+'.png'),dpi=160);plt.close(fig)


if __name__=='__main__':main()
