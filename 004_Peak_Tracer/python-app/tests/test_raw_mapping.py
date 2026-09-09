"""Raw anchor mapping must predict held-out coordinates and reject extrapolation."""
from pathlib import Path
import sys
import unittest
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from peaktrace.read import Trace
from peaktrace.raw_mapping import validate_anchors,predict_raw,map_raw_anchors


class RawMappingTests(unittest.TestCase):
    def test_nonlinear_mapping_and_bounds(self):
        x=np.arange(100)*12
        y=200+1.2*x+.0001*x*x
        mapping=validate_anchors(np.column_stack([x,y]))
        self.assertTrue(mapping['accepted'])
        self.assertLess(mapping['p95_error_raw_samples'],1.)
        values=predict_raw(mapping,[-1,300,2000])
        self.assertTrue(np.isnan(values[0]) and np.isnan(values[2]))
        self.assertAlmostEqual(values[1],569,delta=1)

    def test_insufficient_invalid_and_jumping_anchors_rejected(self):
        self.assertFalse(validate_anchors([(1,2)])['accepted'])
        self.assertFalse(validate_anchors([(1,2)]*100)['accepted'])
        x=np.arange(100)*10;y=x.astype(float)
        y[2::5]+=9
        self.assertFalse(validate_anchors(np.column_stack([x,y]))['accepted'])
        with self.assertRaises(ValueError):predict_raw({'accepted':False},[0])

    def test_recovers_synthetic_raw_peak_correspondence_with_channel_order(self):
        rng=np.random.default_rng(19)
        pb=np.frombuffer(''.join(rng.choice(list('ACGT'),100)).encode(),np.uint8)
        p=np.arange(len(pb))*12+30
        raw_p=np.rint(200+1.4*p+.00005*p*p).astype(int)
        x=np.arange(raw_p[-1]+50);order='TCAG'
        raw={i+1:np.zeros(len(x)) for i in range(4)}
        for base,peak in zip(pb,raw_p):raw[order.index(chr(base))+1]+=100*np.exp(-.5*((x-peak)/2.)**2)
        tags={'FWO_1':order.encode(),**{f'DATA{k}':v for k,v in raw.items()}}
        trace=Trace(Path('synthetic'),{k:np.zeros(p[-1]+30) for k in range(9,13)},pb,np.full(len(pb),40,np.uint8),p,tags)
        result=map_raw_anchors(trace)
        self.assertTrue(result['accepted'])
        self.assertGreaterEqual(result['anchor_count'],95)
        np.testing.assert_allclose(predict_raw(result,p[10:-10]),raw_p[10:-10],atol=1)


if __name__=='__main__':unittest.main()
