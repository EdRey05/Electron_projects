"""Final analysis contract shared by AB1, sequence export and run reports."""
from dataclasses import dataclass,field
import numpy as np
from .resolution import resolve_channels


@dataclass
class AnalysisResult:
    channels: dict
    bases: np.ndarray
    positions: np.ndarray
    qualities: np.ndarray
    clear_range: tuple
    diagnostics: dict=field(default_factory=dict)


def clear_range(qv, threshold=9, window=40):
    """3-prime-only arithmetic-Q window trim; half-open indices.

    Explicit local policy, not a claim of reproducing proprietary ABI limits.
    An entirely failing read has an empty clear range. A short read is assessed
    using its full length rather than silently bypassing the criterion.
    """
    if not len(qv):return 0,0
    if threshold<=0:return 0,len(qv)
    window=min(window,len(qv))
    means=np.convolve(np.asarray(qv,float),np.ones(window)/window,mode='valid')
    passing=np.flatnonzero(means>=threshold)
    return (0,int(passing[-1])+window) if len(passing) else (0,0)


def analyze(trace,args):
    channels,diagnostics=resolve_channels(trace,args)
    pb=trace.pb_in.copy();qv=trace.qv_in.copy();ploc=trace.ploc_in.copy()
    # A duplicate input coordinate cannot safely be represented as two peaks.
    # Retain the best supported call, explicitly recording this structural repair.
    keep=[]
    for i,p in enumerate(ploc):
        if keep and p==ploc[keep[-1]]:
            if qv[i]>qv[keep[-1]]:keep[-1]=i
        else:keep.append(i)
    diagnostics['duplicate_input_positions_removed']=len(pb)-len(keep)
    pb,qv,ploc=pb[keep],qv[keep],ploc[keep]
    diagnostics['lead_dropped']=False
    if args.lead_drop_enabled and len(pb)>1 and qv[0]<args.lead_drop_qv:
        pb,qv,ploc=pb[1:],qv[1:],ploc[1:];diagnostics['lead_dropped']=True
    diagnostics['revised_calls']=[]
    if args.recall_low_quality:
        from .recall import recall_supported
        pb,qv,changes=recall_supported(trace,channels,pb,ploc,qv)
        diagnostics['revised_calls']=changes
    if args.qv_to_n_threshold:
        mask=(qv<=args.qv_to_n_threshold)&(pb!=ord('N'))
        diagnostics['n_downgraded']=int(mask.sum());pb[mask]=ord('N')
    else:diagnostics['n_downgraded']=0
    diagnostics['quality_source']='KB retained; revised calls conservatively capped, not recalibrated'
    return AnalysisResult(channels,pb,ploc,qv,clear_range(qv,args.trim_quality,args.trim_window),diagnostics)
