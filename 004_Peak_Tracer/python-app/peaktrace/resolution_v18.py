"""Signal-driven resolution on a locally uniform base-spacing grid.

The input call positions define a coordinate grid, not synthetic peaks. Widths
are estimated from isolated measured peaks. Regularized Richardson-Lucy updates
act on measured signal; no reference sequence or comparator is accepted here.
This is a resolution model, not an empirically calibrated quality model.
"""
import numpy as np
from scipy.ndimage import gaussian_filter1d, percentile_filter, median_filter
from scipy.signal import find_peaks, peak_widths, savgol_filter


def _restore(observed, sigma, iterations):
    if sigma<0.35:return observed.copy()
    floor=max(float(np.percentile(observed,95))*.002,1e-6)
    estimate=np.maximum(observed,floor)
    for _ in range(iterations):
        prediction=gaussian_filter1d(estimate,sigma,mode='reflect')
        ratio=observed/np.maximum(prediction,floor)
        correction=gaussian_filter1d(ratio,sigma,mode='reflect')
        # Damped updates and a small smoothness penalty limit noise amplification.
        estimate*=np.clip(correction,0.2,5.)**0.8
        estimate=gaussian_filter1d(estimate,.35,mode='reflect')
    return np.maximum(estimate,0)


def resolve_channels(trace, args):
    signal=np.array([trace.channels[k] for k in range(9,13)],float)
    positions=np.unique(trace.ploc_in)
    if len(positions)<20:return {k:signal[k-9] for k in range(9,13)},{'resolved':False,'reason':'too few anchors'}
    spacing=float(np.median(np.diff(positions)))
    baseline_window=max(31,int(spacing*25)|1)
    if args.baseline_smooth:
        signal-=percentile_filter(signal,5,size=(1,baseline_window),mode='reflect')
    signal=np.maximum(signal,0)
    if args.do_smooth and signal.shape[1]>=args.smooth_window:
        signal=np.maximum(savgol_filter(signal,args.smooth_window,2,axis=1),0)
    if not args.resolve_peaks or args.resolution_strength==0:
        return {k:signal[k-9] for k in range(9,13)},{'resolved':False,'reason':'disabled'}
    # Include acquisition margins, maintaining the spacing trend at either end.
    base_x=np.arange(len(positions),dtype=float)
    knots=np.r_[0,positions[positions>0],trace.n_scans-1]
    knots=np.unique(knots)
    units=np.interp(knots,positions,base_x)
    units[0]=-(positions[0]/max(spacing,1))
    units[-1]=len(positions)-1+(trace.n_scans-1-positions[-1])/max(spacing,1)
    samples_per_base=8
    grid=np.arange(units[0],units[-1]+1/samples_per_base,1/samples_per_base)
    scan_grid=np.interp(grid,units,knots)
    measured=np.array([np.interp(scan_grid,np.arange(trace.n_scans),x) for x in signal])
    # Learn broadening from isolated peaks; exclude unresolved same-dye shoulders.
    width_x=[];width_y=[]
    for x in measured:
        peaks,properties=find_peaks(x,prominence=max(float(np.percentile(x,95))*.08,1),distance=4)
        if len(peaks)<3:continue
        widths=peak_widths(x,peaks,rel_height=.5)[0]
        gap_left=np.r_[np.inf,np.diff(peaks)];gap_right=np.r_[np.diff(peaks),np.inf]
        good=(gap_left>16)&(gap_right>16)&(widths>2)&(widths<20)
        width_x.extend(peaks[good]);width_y.extend(widths[good])
    if len(width_x)<10:
        return {k:signal[k-9] for k in range(9,13)},{'resolved':False,'reason':'insufficient isolated peak widths'}
    width_x=np.array(width_x);width_y=np.array(width_y)
    # Overlap/add each locally stationary window. Same kernel for all four dyes
    # preserves relative gain; the width trend can change over the read.
    total=np.zeros_like(measured);weights=np.zeros(len(grid));sigmas=[]
    block=1024;step=256
    for center in range(0,len(grid)+step,step):
        lo=max(0,center-block//2);hi=min(len(grid),center+block//2)
        if hi<=lo:continue
        nearest=np.argsort(np.abs(width_x-center))[:min(30,len(width_x))]
        fwhm=float(np.median(width_y[nearest]))
        observed_sigma=fwhm/2.355
        # Leave finite width: a fully inverted impulse train would misrepresent evidence.
        kernel_sigma=max(.35,observed_sigma*args.resolution_strength)
        kernel_sigma=min(kernel_sigma,5.)
        sigmas.append(kernel_sigma)
        w=np.maximum(np.hanning(hi-lo),1e-4)
        for ch in range(4):
            total[ch,lo:hi]+=_restore(measured[ch,lo:hi],kernel_sigma,args.resolution_iterations)*w
        weights[lo:hi]+=w
    restored=total/np.maximum(weights,1e-9)
    out={k:np.interp(np.arange(trace.n_scans),scan_grid,restored[k-9]) for k in range(9,13)}
    return out,{'resolved':True,'method':'local-width regularized Richardson-Lucy',
                'width_anchors':len(width_x),'median_kernel_sigma_base':float(np.median(sigmas)/samples_per_base),
                'strength':args.resolution_strength,'iterations':args.resolution_iterations}
