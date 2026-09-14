"""Diagnostic raw/KB correspondence. Never changes calls, QVs or trace output.

Anchors pair independently detected raw peak identities with high-Q KB calls.
The acceptance gate uses held-out coordinate prediction, not a length-ratio R².
No extrapolation beyond accepted anchors is permitted.
"""
import numpy as np
from Bio import Align
from scipy.ndimage import percentile_filter, gaussian_filter1d
from scipy.signal import find_peaks


def validate_anchors(anchors, min_anchors=50):
    """Return a monotone mapping only after held-out interpolation passes."""
    anchors=np.asarray(anchors,dtype=float)
    rejected={'accepted':False,'reason':'insufficient distinct anchors'}
    if anchors.ndim!=2 or anchors.shape[1]!=2 or len(anchors)<min_anchors:return rejected
    if not np.all(np.isfinite(anchors)) or np.any(np.diff(anchors,axis=0)<=0):
        return {'accepted':False,'reason':'nonmonotone or invalid anchors'}
    held=np.arange(len(anchors))%5==2
    train=anchors[~held];test=anchors[held]
    error=np.abs(np.interp(test[:,0],train[:,0],train[:,1])-test[:,1])
    # Adjacent high-Q anchors can skip calls. This scale describes anchor spacing,
    # not a claim of raw sample spacing per biological base.
    spacing=float(np.median(np.diff(anchors[:,1])))
    median=float(np.median(error));p95=float(np.percentile(error,95))
    accepted=median<=.35*spacing and p95<=spacing
    return {'accepted':accepted,'reason':'held-out interpolation passed' if accepted else 'held-out residual gate failed',
            'anchor_count':len(anchors),'held_out_count':len(test),
            'median_raw_anchor_spacing':spacing,'median_error_raw_samples':median,'p95_error_raw_samples':p95,
            'analyzed_bounds':anchors[[0,-1],0].astype(int).tolist(),
            'raw_bounds':anchors[[0,-1],1].astype(int).tolist(),
            'anchors':anchors.astype(int).tolist() if accepted else []}


def predict_raw(mapping, analyzed_positions):
    if not mapping.get('accepted'):raise ValueError('Raw mapping was not accepted')
    anchors=np.asarray(mapping['anchors'],float)
    return np.interp(analyzed_positions,anchors[:,0],anchors[:,1],left=np.nan,right=np.nan)


def map_raw_anchors(trace):
    channels=[trace.tags.get(f'DATA{k}') for k in range(1,5)]
    if any(x is None for x in channels):return {'accepted':False,'reason':'raw channels absent'}
    if len({len(x) for x in channels})!=1:return {'accepted':False,'reason':'raw lengths differ'}
    raw=np.asarray(channels,float)
    if raw.shape[1]<100:return {'accepted':False,'reason':'raw signal too short'}
    raw=np.maximum(raw-percentile_filter(raw,5,size=(1,201),mode='reflect'),0)
    raw=gaussian_filter1d(raw,.7,axis=1)
    candidates=[]
    for ch,signal in enumerate(raw):
        peaks,_=find_peaks(signal,prominence=max(10,float(np.percentile(signal,99))*.015),distance=5)
        candidates.extend((int(p),ch,float(signal[p])) for p in peaks if signal[p]>=raw[:,p].max()*.9)
    candidates.sort();calls=[]
    for item in candidates:
        if calls and item[0]-calls[-1][0]<=4:
            if item[2]>calls[-1][2]:calls[-1]=item
        else:calls.append(item)
    if not 50<=len(calls)<=5000:return {'accepted':False,'reason':'raw peak count outside diagnostic limits','raw_peaks':len(calls)}
    raw_seq=''.join(trace.base_order[ch] for _,ch,_ in calls)
    kb=bytes(trace.pb_in).decode('ascii')
    if not kb or len(kb)>5000:return {'accepted':False,'reason':'KB call count outside diagnostic limits'}
    aligner=Align.PairwiseAligner();aligner.match_score=2;aligner.mismatch_score=-2
    aligner.open_gap_score=-4;aligner.extend_gap_score=-1
    aligner.open_end_gap_score=0;aligner.extend_end_gap_score=0
    coordinates=aligner.align(kb,raw_seq)[0].coordinates;anchors=[];indexes=[]
    for k in range(coordinates.shape[1]-1):
        i,j=coordinates[:,k];ii,jj=coordinates[:,k+1]
        if ii>i and jj>j:
            for a,b in zip(range(i,ii),range(j,jj)):
                if kb[a]==raw_seq[b] and trace.qv_in[a]>=30:
                    pair=(int(trace.ploc_in[a]),calls[b][0])
                    if not anchors or pair[0]>anchors[-1][0]:anchors.append(pair);indexes.append(int(a))
    result=validate_anchors(anchors)
    high_q=int(np.count_nonzero(trace.qv_in>=30))
    result.update(raw_peaks=len(calls),kb_q30_calls=high_q,
                  matched_q30_fraction=len(anchors)/max(high_q,1),
                  kb_base_bounds=[indexes[0],indexes[-1]] if indexes else [],
                  interpretation='Coordinate correspondence only; not a basecaller or calibrated confidence')
    if result.get('accepted') and len(anchors)/max(high_q,1)<.25:
        result.update(accepted=False,reason='insufficient high-Q sequence coverage',anchors=[])
    return result
