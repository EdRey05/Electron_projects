"""Native trace-evidence diagnostics, deliberately not a Phred estimator.

Features refer to source call indices. Models fit original analyzed signal,
never a reference or PT output. Fitted-model BIC differences are descriptive:
residuals are correlated and the Gaussian family is approximate.
"""
from copy import copy
from functools import lru_cache
import numpy as np
from scipy.ndimage import percentile_filter
from scipy.signal import savgol_filter
from scipy.optimize import least_squares
from .resolution import resolve_channels


def _signal(channels, spacing):
    a=np.array([channels[k] for k in range(9,13)],float)
    if not np.all(np.isfinite(a)):raise ValueError('Non-finite evidence signal')
    return np.maximum(a-percentile_filter(a,5,size=(1,max(7,int(spacing*25)|1)),mode='reflect'),0)


def _noise(a):
    if a.shape[-1]<7:return 0.
    r=a-savgol_filter(a,7,2,axis=-1)
    return float(1.4826*np.median(np.abs(r-np.median(r))))


def _features(a,ch,p,d):
    radius=max(1,int(round(.25*d)));lo=max(0,p-radius);hi=min(a.shape[1],p+radius+1)
    peaks=a[:,lo:hi].max(axis=1);height=float(peaks[ch]);other=float(np.max(np.delete(peaks,ch)))
    crest=lo+int(np.argmax(a[ch,lo:hi]));noise=_noise(a[:,max(0,p-int(2*d)):min(a.shape[1],p+int(2*d)+1)])
    return dict(height=height,competitor_ratio=other/height if height>0 else None,
                noise=noise,noise_fraction=noise/height if height>0 else None,
                crest_offset_base=float((crest-p)/d),dominant_dye=int(np.argmax(peaks)))


def valley(signal,a,b):
    if b-a<3:return None
    radius=max(1,int((b-a)*.25))
    lo=max(0,a-radius);hi=min(len(signal),b+radius+1)
    left=lo+int(np.argmax(signal[lo:min(a+radius+1,b)]))
    right=max(left+1,b-radius)+int(np.argmax(signal[max(left+1,b-radius):hi]))
    height=min(signal[left],signal[right])
    return float(1-signal[left:right+1].min()/height) if height>0 else None


@lru_cache(maxsize=256)
def _templates(distance):
    x=np.arange(-distance,2*distance+1)/distance
    widths=(.20,.30,.40,.50,.65,.85,1.10)
    one=[];one_params=[];two=[];two_params=[]
    for width in widths:
        for center in np.linspace(-.25,1.25,13):
            one.append(np.exp(-.5*((x-center)/width)**2));one_params.append((center,width))
        for c1 in (-.15,0.,.15):
            for c2 in (.85,1.,1.15):
                two.append([np.exp(-.5*((x-c1)/width)**2),np.exp(-.5*((x-c2)/width)**2)])
                two_params.append((c1,c2,width))
    return np.array(one),np.array(two),one_params,two_params


def fit_pair(signal,left,right):
    """Grid-initialized continuous fits with a fixed fifth-percentile baseline.

    One-peak width can widen to 1.1 spacings; two peaks share width, with
    independent amplitudes and bounded center offsets. Do not interpret delta
    BIC as a confidence probability or proof of an additional biological base.
    """
    d=int(right-left)
    if d<4 or d>100:return dict(available=False,reason='spacing outside model range')
    if left-d<0 or right+d>=len(signal):return dict(available=False,reason='edge window')
    y=np.asarray(signal[left-d:right+d+1],float)
    if not np.all(np.isfinite(y)):raise ValueError('Non-finite pair signal')
    background=float(np.percentile(y,5));y=np.maximum(y-background,0)
    energy=float(y@y)
    if energy<=1e-12:return dict(available=False,reason='zero signal')
    one,two,p1,p2=_templates(d)
    coef=np.maximum(one@y/np.sum(one*one,axis=1),0)
    sse1=np.sum((one*coef[:,None]-y)**2,axis=1);i=int(np.argmin(sse1))
    a,b=two[:,0],two[:,1];aa=np.sum(a*a,axis=1);bb=np.sum(b*b,axis=1);ab=np.sum(a*b,axis=1)
    ay=a@y;by=b@y;det=np.maximum(aa*bb-ab*ab,1e-12)
    ca=(ay*bb-by*ab)/det;cb=(by*aa-ay*ab)/det
    # Exact active-set solution for two nonnegative amplitudes.
    neg_a=ca<0;neg_b=cb<0
    ca=np.where(neg_b,np.maximum(ay/aa,0),ca);cb=np.where(neg_b,0,cb)
    cb=np.where(neg_a,np.maximum(by/bb,0),cb);ca=np.where(neg_a,0,ca)
    sse2=np.sum((a*ca[:,None]+b*cb[:,None]-y)**2,axis=1);j=int(np.argmin(sse2))
    # Refine BOTH families continuously: a coarse single-peak grid otherwise
    # gives the more flexible double model a spurious advantage.
    x=np.arange(-d,2*d+1)/d;scale=float(y.max());normalized=y/scale
    def g(center,width):return np.exp(-.5*((x-center)/width)**2)
    single=least_squares(lambda p:p[0]*g(p[1],p[2])-normalized,
                         [coef[i]/scale,*p1[i]],bounds=([0,-.25,.20],[3,1.25,1.10]),max_nfev=100)
    double=least_squares(lambda p:p[0]*g(p[2],p[4])+p[1]*g(p[3],p[4])-normalized,
                         [ca[j]/scale,cb[j]/scale,*p2[j]],
                         bounds=([0,0,-.15,.85,.20],[3,3,.15,1.15,1.10]),max_nfev=100)
    if not single.success or not double.success:
        return dict(available=False,reason='continuous fit did not converge')
    e1=float(single.fun@single.fun)*scale**2;e2=float(double.fun@double.fun)*scale**2
    floor=energy*1e-12;n=len(y)
    delta=float(n*np.log(max(e1,floor)/max(e2,floor))-2*np.log(n))
    maximum=max(double.x[:2]);ratio=float(min(double.x[:2])/maximum) if maximum>0 else 0.
    return dict(available=True,delta_bic_two_over_one=delta,
                single_relative_rms=float(np.sqrt(e1/energy)),
                double_relative_rms=float(np.sqrt(e2/energy)),minor_major_amplitude_ratio=ratio,
                single_center_base=float(single.x[1]),single_sigma_base=float(single.x[2]),
                double_centers_base=double.x[2:4].tolist(),double_sigma_base=float(double.x[4]),
                width_boundary=bool(any(abs(w-bound)<1e-4 for w in (single.x[2],double.x[4]) for bound in (.20,1.10))))


def measure_evidence(trace,resolved,args,stability=True):
    positions=np.asarray(trace.ploc_in);unique=np.unique(positions)
    spacing=float(np.median(np.diff(unique))) if len(unique)>1 else 1.
    original=_signal(trace.channels,spacing);enhanced=_signal(resolved,spacing)
    variants=[];strengths=[]
    if stability and len(unique)>=20 and args.resolve_peaks and args.resolution_strength>0:
        for strength in sorted({max(0.,args.resolution_strength-.05),min(.95,args.resolution_strength+.05)}):
            if strength==args.resolution_strength:continue
            config=copy(args);config.resolution_strength=strength
            channels,_=resolve_channels(trace,config);variants.append(_signal(channels,spacing));strengths.append(strength)
    rows=[];pairs=[];sequence=bytes(trace.pb_in).decode('ascii')
    for i,(base,p) in enumerate(zip(sequence,positions)):
        p=int(p);lo=max(0,i-3);hi=min(len(positions),i+4);gaps=np.diff(positions[lo:hi]);positive=gaps[gaps>0]
        d=float(np.median(positive)) if len(positive) else spacing
        row=dict(index=i,base=base,position=p,input_qv=int(trace.qv_in[i]))
        if base not in 'ACGT' or len(gaps) and np.any(gaps<=0):
            row.update(available=False,reason='ambiguous base or duplicate neighboring positions');rows.append(row);continue
        ch=trace.channel_of_base[base]-9
        before=_features(original,ch,p,d);after=_features(enhanced,ch,p,d)
        varied=[_features(v,ch,p,d) for v in variants]
        crests=[after['crest_offset_base']]+[v['crest_offset_base'] for v in varied]
        ratios=[v['competitor_ratio'] for v in [after]+varied if v['competitor_ratio'] is not None]
        row.update(available=True,spacing_ratio=float(max(positive)/min(positive)) if len(positive) else None,
                   original=before,resolved=after,stability_measured=bool(varied),
                   crest_span_base=float(max(crests)-min(crests)) if varied else None,
                   competitor_ratio_span=float(max(ratios)-min(ratios)) if varied and ratios else None,
                   dominant_dye_changed=bool(any(v['dominant_dye']!=after['dominant_dye'] for v in varied)) if varied else None)
        rows.append(row)
        if i+1<len(sequence) and sequence[i+1]==base and positions[i+1]>p:
            right=int(positions[i+1]);isolated=(i==0 or sequence[i-1]!=base) and (i+2==len(sequence) or sequence[i+2]!=base)
            pair=dict(left_index=i,right_index=i+1,base=base,
                      input_qv_min=int(min(trace.qv_in[i:i+2])),
                      original_valley=valley(original[ch],p,right),resolved_valley=valley(enhanced[ch],p,right),
                      isolated_double=isolated)
            pair['original_fit']=fit_pair(original[ch],p,right) if isolated else dict(available=False,reason='longer repeat run requires a joint model')
            pair['resolved_fit']=fit_pair(enhanced[ch],p,right) if isolated else dict(available=False,reason='longer repeat run requires a joint model')
            pairs.append(pair)
    available=[r for r in rows if r['available']]
    return dict(schema='peaktrace-native-evidence-v1',coordinate_system='source analyzed samples; zero-based source call indices',
                meaning='Diagnostic measurements only; not calibrated quality scores or basecall corrections',
                hypothesis_family='Grid-initialized continuous Gaussian fits with shared double width; delta BIC is descriptive, not a probability',
                stability_strengths=strengths,
                summary=dict(source_bases=len(rows),measured_bases=len(available),same_base_pairs=len(pairs),
                    modeled_pairs=sum(p['original_fit']['available'] for p in pairs),
                    unstable_dominant_dyes=sum(r['dominant_dye_changed'] is True for r in available)),
                bases=rows,pairs=pairs)
