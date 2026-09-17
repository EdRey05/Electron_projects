"""Evidence is descriptive and must not change exported biological arrays."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import numpy as np
from Bio import SeqIO
from test_analysis_contract import fixture
from peaktrace.cli import main
from peaktrace.config import parse_args
from peaktrace.read import read_ab1
from peaktrace.evidence import fit_pair, measure_evidence
from scipy.optimize import least_squares


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

    def test_narrow_peaks_report_width_constraint_without_changing_availability(self):
        x=np.arange(121)
        signal=np.exp(-.5*((x-50)/2)**2)+.7*np.exp(-.5*((x-70)/2)**2)
        result=fit_pair(signal,50,70)
        self.assertTrue(result['available'])
        self.assertTrue(result['width_boundary'])
        self.assertIn('sigma:lower',result['fit_diagnostics']['double']['boundary_parameters'])
        self.assertIn('double:bound:sigma:lower',result['diagnostic_flags'])

    def test_displaced_pair_reports_center_constraint(self):
        x=np.arange(121)
        signal=np.exp(-.5*((x-43)/6)**2)+.7*np.exp(-.5*((x-70)/6)**2)
        result=fit_pair(signal,50,70)
        self.assertIn('center_left:lower',result['fit_diagnostics']['double']['boundary_parameters'])

    def test_interior_double_has_no_double_boundary_flags(self):
        x=np.arange(121)
        signal=np.exp(-.5*((x-50)/6)**2)+.7*np.exp(-.5*((x-70)/6)**2)
        result=fit_pair(signal,50,70)
        self.assertTrue(result['fit_diagnostics']['double']['converged'])
        self.assertEqual(result['fit_diagnostics']['double']['boundary_parameters'],[])

    def test_nonconvergence_preserves_solver_details_without_model_score(self):
        def limited(*args,**kwargs):
            kwargs['max_nfev']=1
            return least_squares(*args,**kwargs)
        x=np.arange(121);signal=np.exp(-.5*((x-61.3)/9)**2)
        with patch('peaktrace.evidence.least_squares',side_effect=limited):
            result=fit_pair(signal,50,70)
        self.assertFalse(result['available'])
        self.assertNotIn('delta_bic_two_over_one',result)
        self.assertIn('single:not_converged',result['diagnostic_flags'])
        self.assertEqual(result['fit_diagnostics']['single']['status'],0)
        self.assertEqual(result['fit_diagnostics']['single']['evaluations'],1)

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
