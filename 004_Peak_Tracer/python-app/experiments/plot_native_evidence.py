"""Static diagnostic figures; no model fitting or reference-guided calling."""
import argparse
import json
from pathlib import Path
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from Bio import SeqIO
from task_paths import archived_path


def main():
    p=argparse.ArgumentParser();p.add_argument('--results',type=Path,required=True);args=p.parse_args();root=args.results
    plt.rcParams.update({'font.size':10,'axes.spines.top':False,'axes.spines.right':False})
    data=json.loads((root/'synthetic-holdout.json').read_text())['summary']
    fig,ax=plt.subplots(figsize=(10,5),layout='constrained');x=np.arange(len(data));width=.35
    for offset,stage,color in ((-width/2,'original','#6c757d'),(width/2,'resolved','#087f8c')):
        ax.bar(x+offset,[100*r[stage]['screened_two']/r['n'] for r in data],width,label=stage,color=color)
    ax.set_xticks(x,[r['family'].replace('_','\n') for r in data]);ax.set_ylim(0,105);ax.set_ylabel('Trials passing illustrative two-peak screen (%)')
    ax.set_title('Synthetic challenge: more true pairs pass after resolution\n0/144 single-peak trials pass; this is not QV calibration');ax.legend()
    fig.savefig(root/'synthetic-challenge.png',dpi=170);plt.close(fig)
    examples=json.loads((root/'examples.json').read_text())
    if examples:
        fig,axes=plt.subplots(len(examples),1,figsize=(11,4*len(examples)),squeeze=False,layout='constrained')
        for ax,row in zip(axes[:,0],examples):
            for stage,path,color in (('original',row['source'],'#6c757d'),('resolved',row['out'],'#087f8c')):
                tags=SeqIO.read(archived_path(path),'abi').annotations['abif_raw'];order=tags['FWO_1'].decode()
                source_tags=SeqIO.read(archived_path(row['source']),'abi').annotations['abif_raw'];left,right=[source_tags['PLOC2'][i] for i in (row['left_index'],row['right_index'])]
                distance=right-left;lo=max(0,left-distance);hi=right+distance+1
                signal=np.asarray(tags[f'DATA{9+order.index(row["base"])}'],float)[lo:hi]
                signal=np.maximum(signal-np.percentile(signal,5),0);signal/=max(signal.max(),1)
                ax.plot((np.arange(lo,hi)-left)/distance,signal,label=f"{stage}; fit delta={row[stage+'_fit']['delta_bic_two_over_one']:.1f}",color=color)
            ax.axvline(0,color='#bbb',ls=':');ax.axvline(1,color='#bbb',ls=':');ax.legend()
            ax.set_title(f"{row['category'].replace('_',' ')} | {Path(row['out']).stem}\nsource calls {row['left_index']+1}–{row['right_index']+1}; {row['base']}{row['base']}",fontsize=9)
            ax.set_xlabel('Scan offset / source call spacing');ax.set_ylabel('Normalized dye intensity')
        fig.savefig(root/'real-pair-examples.png',dpi=170);plt.close(fig)
    summary=json.loads((root/'summary.json').read_text())
    fig,axes=plt.subplots(1,2,figsize=(11,4.5),layout='constrained')
    for ax,(plate,data) in zip(axes,summary['plates'].items()):
        bands=data['bands'];x=np.arange(len(bands));denom=np.array([max(1,r['modeled_pairs']) for r in bands])
        ax.bar(x-.18,[100*r['original_pair_screen']/d for r,d in zip(bands,denom)],.36,label='Original',color='#6c757d')
        ax.bar(x+.18,[100*r['resolved_pair_screen']/d for r,d in zip(bands,denom)],.36,label='Resolved',color='#087f8c')
        ax.set_xticks(x,['1–100','101–600','601–900','901+']);ax.set_ylim(0,100);ax.set_title(plate);ax.set_xlabel('Source call number');ax.set_ylabel('Modeled pairs passing screen (%)');ax.legend()
    fig.suptitle('Real traces: fit preference changes after processing\nMore passing pairs does not establish correctness')
    fig.savefig(root/'real-pair-screen.png',dpi=170);plt.close(fig)


if __name__=='__main__':main()
