"""Model selection, finite-width output and conservative noise behavior."""
import contextlib
import io
from pathlib import Path
import sys
import unittest
import numpy as np
from scipy.ndimage import gaussian_filter1d
from scipy.signal import find_peaks
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from peaktrace.config import parse_args
from peaktrace.resolution import _recover,resolve_channels
from peaktrace.resolution_v18 import resolve_channels as old_resolve
from peaktrace.read import Trace


class ResolutionV19Tests(unittest.TestCase):
    def test_legacy_model_uses_exact_old_defaults(self):
        args=parse_args(['--input-dir','a','--output-dir','b','--resolution-model','v18'])
        self.assertEqual((args.resolution_strength,args.resolution_iterations),(.75,24))
        p=np.arange(60)*12+30;pb=np.frombuffer(b'ACGT'*15,np.uint8)
        channels={k:np.zeros(p[-1]+40) for k in range(9,13)}
        for base,x in zip(pb,p):channels[9+'GATC'.index(chr(base))][x]=1000
        channels={k:gaussian_filter1d(v,4.) for k,v in channels.items()}
        trace=Trace(Path('synthetic'),channels,pb,np.full(60,40,np.uint8),p,{'FWO_1':b'GATC'})
        actual,_=resolve_channels(trace,args);expected,_=old_resolve(trace,args)
        for k in actual:np.testing.assert_array_equal(actual[k],expected[k])

    def test_isolated_peak_rounding_does_not_split_peak(self):
        x=np.arange(200);signal=100*np.exp(-.5*((x-100)/5.)**2)
        latent=_recover(signal,4.,40,.5);rounded=gaussian_filter1d(latent,1.5)
        peaks,_=find_peaks(rounded,prominence=5)
        np.testing.assert_array_equal(peaks,[100])
        # Integer width counts can tie even when a sub-sample crest becomes rounder.
        curvature=lambda y:(2*y[100]-y[99]-y[101])/y[100]
        self.assertLess(curvature(rounded),curvature(latent))

    def test_flat_zero_and_noisy_floor_finite(self):
        for value in (0.,50.):
            out=_recover(np.full(200,value),4.,40,2.)
            self.assertTrue(np.all(np.isfinite(out)))
            self.assertLess(float(np.ptp(out)),1e-8)
        rng=np.random.default_rng(12)
        observed=np.maximum(5+rng.normal(0,2,200),0)
        weak=_recover(observed,4.,40,.1);regularized=_recover(observed,4.,40,10.)
        self.assertLess(np.std(regularized),np.std(weak))

    def test_new_flags_reject_nonfinite_and_out_of_bounds(self):
        for flag in ('--peak-width','--noise-regularization'):
            for value in ('nan','inf','-1','100'):
                with contextlib.redirect_stderr(io.StringIO()),self.assertRaises(SystemExit):
                    parse_args(['--input-dir','a','--output-dir','b',flag+'='+value])


if __name__=='__main__':unittest.main()
