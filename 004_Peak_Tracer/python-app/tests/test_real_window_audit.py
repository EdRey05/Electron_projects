from pathlib import Path
import sys
import unittest
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'experiments'))
from real_window_audit import flat_crests, geometry


class RealWindowAuditTests(unittest.TestCase):
    def test_positive_bracketed_runs_only(self):
        self.assertEqual(flat_crests([0,0,0,1,3,3,3,1,0]),
                         [dict(start=4,end=7,length=3,height=3.)])
        for signal in ([0,0,0], [5,5,5,0], [0,5,5,5], [0,5,5,0], [0,4,4,4,5]):
            self.assertEqual(flat_crests(signal),[])

    def test_window_threshold_and_floor_are_descriptive(self):
        a=np.array([0,2,2,2,0,10,10,10,0],float)
        result=geometry(a,np.zeros(len(a)),0,len(a))
        self.assertEqual(len(result['high_flat_crests']),1)
        self.assertEqual(result['high_flat_crests'][0]['height'],10)
        self.assertEqual(result['slow_background_range_over_peak'],0)
        self.assertFalse(geometry(np.zeros(5),np.zeros(5),0,5)['available'])
