"""Conservative low-quality substitutions supported by both signal views.

No reference, sequence-length target or PT quality scores are used. This does
not insert/delete bases or promote quality. Changes remain explicitly recorded.
"""
import numpy as np
from scipy.ndimage import median_filter


def recall_supported(trace, channels, pb, positions, qv):
    bases=pb.copy();qualities=qv.copy();changes=[]
    original=np.array([trace.channels[k] for k in range(9,13)],float)
    resolved=np.array([channels[k] for k in range(9,13)],float)
    order=trace.base_order
    if len(pb)<30:return bases,qualities,changes
    # Isolated substitutions only, within locally supported parts of the read.
    for i in range(5,len(pb)-5):
        if not 3<=int(qv[i])<=15:continue
        if np.count_nonzero(qv[i-3:i+4]>=20)<2:continue
        p=int(positions[i]);space=float(np.median(np.diff(positions[max(0,i-10):i+11])))
        radius=max(2,int(min(space*.35,12)))
        lo=max(0,p-radius);hi=min(original.shape[1],p+radius+1)
        evidence=resolved[:,lo:hi].sum(axis=1)
        rank=np.argsort(evidence);ch=int(rank[-1]);base=ord(order[ch])
        if base==pb[i] or evidence[ch]<=0:continue
        if evidence[ch]<4*max(evidence[rank[-2]],1.):continue
        raw_evidence=original[:,lo:hi].sum(axis=1)
        if raw_evidence[ch]<1.8*max(np.max(np.delete(raw_evidence,ch)),1.):continue
        # Reject shoulders: the selected peak must crest close to the call center.
        local=resolved[ch,max(0,p-radius*2):min(original.shape[1],p+radius*2+1)]
        peak_at=int(np.argmax(local))+max(0,p-radius*2)
        if abs(peak_at-p)>max(2,int(space*.25)):continue
        noise_region=original[ch,max(0,p-150):min(original.shape[1],p+151)]
        residual=noise_region-median_filter(noise_region,size=5,mode='reflect')
        noise=max(1.,1.4826*float(np.median(np.abs(residual-np.median(residual)))))
        if resolved[ch,peak_at]<10*noise:continue
        bases[i]=base
        # The newly inferred call has no calibrated QV. Never increase the old
        # confidence; cap it below Q20 and keep its provenance in the manifest.
        qualities[i]=min(int(qv[i]),10)
        changes.append({'index':int(i),'position':p,'old':chr(int(pb[i])),
                        'new':chr(base),'qv':int(qualities[i]),
                        'resolved_ratio':float(evidence[ch]/max(evidence[rank[-2]],1.))})
    return bases,qualities,changes
