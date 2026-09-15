"""Evidence is descriptive and must not change exported biological arrays."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
import numpy as np
from Bio import SeqIO
from test_analysis_contract import fixture
from peaktrace.cli import main
from peaktrace.config import parse_args
from peaktrace.read import read_ab1
from peaktrace.evidence import fit_pair, measure_evidence


class EvidenceTests(unittest.TestCase):
    def test_exact_single_and_double_and_gain_invariance(self):
        x=np.arange(121);single=np.exp(-.5*((x-60)/10)**2)
        double=np.exp(-.5*((x-50)/6)**2)+.7*np.exp(-.5*((x-70)/6)**2)
        self.assertLess(fit_pair(single,50,70)['delta_bic_two_over_one'],0)
        result=fit_pair(double,50,70)
        self.assertGreater(result['delta_bic_two_over_one'],10)
        self.assertAlmostEqual(result['delta_bic_two_over_one'],fit_pair(double*123,50,70)['delta_bic_two_over_one'],places=7)

    def test_unavailable_and_nonfinite(self):
        self.assertFalse(fit_pair(np.zeros(120),50,70)['available'])
        self.assertFalse(fit_pair(np.ones(120),0,20)['available'])
        with self.assertRaises(ValueError):fit_pair(np.full(120,np.nan),50,70)

    def test_off_grid_single_is_not_mistaken_for_two(self):
        x=np.arange(121)
        for width in (6,9,12):
            signal=np.exp(-.5*((x-61.3)/width)**2)
            self.assertLess(fit_pair(signal,50,70)['delta_bic_two_over_one'],0)

    def test_dye_mapping_and_missing_stability(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp)/'input.ab1'
            args=parse_args(['--input-dir',temp,'--output-dir',temp])
            for order in ('ACGT','GATC','TCGA'):
                fixture(p,order);trace=read_ab1(p)
                data=measure_evidence(trace,trace.channels,args)
                self.assertEqual(data['summary']['measured_bases'],4)
                for row in data['bases']:
                    self.assertEqual(row['original']['competitor_ratio'],0)
                    self.assertEqual(row['original']['dominant_dye'],order.index(row['base']))
                    self.assertIsNone(row['dominant_dye_changed'])
                trace.channels[trace.channel_of_base['C']][10]=2000
                self.assertEqual(measure_evidence(trace,trace.channels,args)['bases'][0]['original']['competitor_ratio'],2)

    def test_cli_noninterference_and_collision(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);inp=root/'in';inp.mkdir();src=inp/'sample_A01.ab1';fixture(src)
            before=src.read_bytes()
            for mode in ('plain','evidence'):
                flags=['--write-evidence'] if mode=='evidence' else []
                with contextlib.redirect_stdout(io.StringIO()):
                    code=main(['--input-dir',str(inp),'--output-dir',str(root/mode)]+flags)
                self.assertEqual(code,0)
            a=SeqIO.read(root/'plain/sample.ab1','abi').annotations['abif_raw']
            b=SeqIO.read(root/'evidence/sample.ab1','abi').annotations['abif_raw']
            for key in ['PBAS2','PCON2','PLOC2']+[f'DATA{i}' for i in range(1,13) if i<=4 or i>=9]:
                self.assertEqual(a[key],b[key])
            self.assertEqual((root/'plain/sample.seq').read_bytes(),(root/'evidence/sample.seq').read_bytes())
            data=json.loads((root/'evidence/sample.evidence.json').read_text())
            self.assertEqual(data['summary']['source_bases'],4)
            self.assertEqual(src.read_bytes(),before)
            collision=root/'collision';collision.mkdir();sidecar=collision/'sample.evidence.json';sidecar.write_text('keep')
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertNotEqual(main(['--input-dir',str(inp),'--output-dir',str(collision),'--write-evidence']),0)
            self.assertEqual(sidecar.read_text(),'keep');self.assertFalse((collision/'sample.ab1').exists())
