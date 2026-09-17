import sys
from pathlib import Path
import unittest
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'experiments'))
from baseline_saturation import perturb
from neighbor_interference import make_trace


class BaselineSaturationTests(unittest.TestCase):
    def test_drift_keeps_source_and_other_dyes_unchanged(self):
        trace,left,right,_=make_trace('double',.45,.02,80)
        saved={k:a.copy() for k,a in trace.channels.items()}
        output,truth=perturb(trace.channels,left,right,'drift_rise',.75)
        for k in saved:np.testing.assert_array_equal(trace.channels[k],saved[k])
        for k in (9,11,12):np.testing.assert_array_equal(output[k],saved[k])
        drift=output[10]-saved[10]
        self.assertTrue(np.all(np.diff(drift)>=-1e-12))
        self.assertGreater(truth['added_baseline_local_max'],truth['added_baseline_local_min'])
        fall,_=perturb(trace.channels,left,right,'drift_fall',.75)
        np.testing.assert_allclose((fall[10]-saved[10])+drift,75)

    def test_hump_symmetry_and_zero_level_control(self):
        channels={k:np.ones(121) for k in range(9,13)}
        output,_=perturb(channels,50,70,'drift_hump',1.5)
        self.assertAlmostEqual(output[10][50],output[10][70])
        self.assertGreater(output[10][60],output[10][30])
        output,_=perturb(channels,50,70,'drift_rise',0)
        np.testing.assert_array_equal(output[10],channels[10])

    def test_ceiling_preserves_subthreshold_signal_and_counts_clipped_samples(self):
        channels={k:np.arange(121,dtype=float) for k in range(9,13)}
        output,truth=perturb(channels,50,70,'clipping',.6)
        self.assertEqual(output[10].max(),60)
        np.testing.assert_array_equal(output[10][:60],channels[10][:60])
        self.assertEqual(truth['clipped_local_samples'],30)
        self.assertEqual(truth['local_samples'],61)
        for k in (9,11,12):np.testing.assert_array_equal(output[k],channels[k])
        with self.assertRaises(ValueError):perturb(channels,50,70,'unknown',1)
