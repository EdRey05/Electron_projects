"""Conservative substitutions must reject weak, displaced and high-Q evidence."""
from pathlib import Path
import sys
import unittest
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from peaktrace.read import Trace
from peaktrace.recall import recall_supported


class RecallTests(unittest.TestCase):
    def fixture(self, ratio=8., shift=0, quality=8):
        positions=np.arange(40)*15+40
        bases=np.frombuffer(b'A'*40,np.uint8).copy()
        qv=np.full(40,30,np.uint8);qv[20]=quality
        x=np.arange(700)
        peak=100*np.exp(-.5*((x-positions[20]-shift)/3.)**2)
        channels={9:peak,10:peak/ratio,11:np.zeros(700),12:np.zeros(700)}
        trace=Trace(Path('synthetic'),channels,bases,qv,positions,{'FWO_1':b'GATC'})
        return trace

    def test_isolated_strong_substitution_without_quality_promotion(self):
        t=self.fixture()
        pb,qv,changes=recall_supported(t,t.channels,t.pb_in,t.ploc_in,t.qv_in)
        self.assertEqual(chr(pb[20]),'G')
        self.assertEqual(len(changes),1)
        self.assertLessEqual(qv[20],t.qv_in[20])
        self.assertEqual(len(pb),len(t.pb_in))

    def test_rejects_weak_shifted_and_high_quality_evidence(self):
        for options in ({'ratio':2.},{'shift':8},{'quality':30}):
            with self.subTest(options=options):
                t=self.fixture(**options)
                pb,qv,changes=recall_supported(t,t.channels,t.pb_in,t.ploc_in,t.qv_in)
                self.assertEqual(changes,[])
                np.testing.assert_array_equal(pb,t.pb_in)


if __name__=='__main__':unittest.main()
