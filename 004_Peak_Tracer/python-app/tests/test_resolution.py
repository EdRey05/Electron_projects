"""Resolution is tested against measured simulations with known peak multiplicity."""
from pathlib import Path
import sys
import unittest
import numpy as np
from scipy.ndimage import gaussian_filter1d
from scipy.signal import find_peaks
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from peaktrace.resolution import _restore,resolve_channels
from peaktrace.read import Trace
from peaktrace.config import parse_args
from peaktrace.analysis import analyze


class ResolutionTests(unittest.TestCase):
    def test_recovers_overlapping_measured_peaks_without_positions(self):
        impulses=np.zeros(200);impulses[[70,82,94,106]]=100
        observed=gaussian_filter1d(impulses,6.)
        restored=_restore(observed,5.,40)
        peaks,_=find_peaks(restored,prominence=.5)
        self.assertEqual(len(peaks),4)
        self.assertLessEqual(np.max(np.abs(peaks-np.array([70,82,94,106]))),2)
        self.assertLess(np.min(restored[83:94])/max(restored),np.min(observed[83:94])/max(observed))

    def test_flat_and_zero_do_not_invent_peaks(self):
        for value in (0.,50.):
            out=_restore(np.full(200,value),4.,24)
            self.assertTrue(np.all(np.isfinite(out)))
            self.assertLess(float(np.ptp(out)),1e-8)

    def test_resolution_changes_signal_without_changing_confidence(self):
        seq=('ACGT'*12+'ATTTTC'+'ACGT'*12).encode();p=np.arange(len(seq))*12+30
        channels={k:np.zeros(int(p[-1]+40)) for k in range(9,13)}
        for base,position in zip(seq,p):channels[9+'GATC'.index(chr(base))][position]=1000
        channels={k:gaussian_filter1d(v,5.) for k,v in channels.items()}
        trace=Trace(Path('synthetic'),channels,np.frombuffer(seq,np.uint8),np.full(len(seq),40,np.uint8),p,{'FWO_1':b'GATC'})
        args=parse_args(['--input-dir','in','--output-dir','out'])
        result=analyze(trace,args)
        self.assertEqual(bytes(result.bases),seq)
        np.testing.assert_array_equal(result.qualities,trace.qv_in)
        np.testing.assert_array_equal(result.positions,trace.ploc_in)
        self.assertTrue(result.diagnostics['resolved'])
        self.assertGreater(np.linalg.norm(result.channels[9]-trace.channels[9]),1.)
        # The displayed peaks must come from measured signal, not PBAS templates.
        trace.pb_in=np.full(len(seq),ord('T'),np.uint8)
        alternate,_=resolve_channels(trace,args)
        for k in channels:np.testing.assert_array_equal(result.channels[k],alternate[k])


if __name__=='__main__':unittest.main()
