import sys
from pathlib import Path
import unittest
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'experiments'))
from neighbor_interference import make_trace, summarize


class NeighborExperimentTests(unittest.TestCase):
    def test_paired_noise_and_target_are_preserved(self):
        control,left,right,truth=make_trace('double',.45,.02,60)
        added,_,_,changed=make_trace('double',.45,.02,60,'left',1.,.75)
        for channel in (9,11,12):
            np.testing.assert_array_equal(control.channels[channel],added.channels[channel])
        self.assertEqual(truth['target_centers'],changed['target_centers'])
        self.assertLess(changed['neighbor_center'],left)
        self.assertTrue(np.all(added.channels[10]>=control.channels[10]))
        zero,_,_,_=make_trace('double',.45,.02,60,'right',1.,0.)
        np.testing.assert_array_equal(control.channels[10],zero.channels[10])

    def test_unavailable_and_flagged_passes_have_explicit_denominators(self):
        fit=dict(available=True,delta_bic_two_over_one=20,double_relative_rms=.1,
                 minor_major_amplitude_ratio=.5,fit_diagnostics={'single':{'boundary_parameters':['sigma:lower']},'double':{'boundary_parameters':[]}})
        unavailable=dict(available=False)
        rows=[dict(family='single',original=fit,resolved=unavailable),
              dict(family='double',original=unavailable,resolved=fit)]
        result=summarize(rows)
        self.assertEqual(result['original']['single']['screen_pass'],1)
        self.assertEqual(result['original']['single']['passing_with_single_bound'],1)
        self.assertEqual(result['original']['single']['passing_with_double_bound'],0)
        self.assertEqual(result['original']['double']['unavailable'],1)
        self.assertEqual(result['original']['double']['screen_not_pass'],1)
