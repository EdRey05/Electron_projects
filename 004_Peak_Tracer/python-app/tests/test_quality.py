import subprocess
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import numpy as np
from test_analysis_contract import fixture
from peaktrace.read import read_ab1
from peaktrace.quality import parse_phd,reassess
from peaktrace.config import parse_args


class QualityTests(unittest.TestCase):
    def test_phd_validation(self):
        for text in ('', 'BEGIN_DNA\nEND_DNA', 'BEGIN_DNA\na 999 10\nEND_DNA',
                     'BEGIN_DNA\na -1 10\nEND_DNA', 'BEGIN_DNA\na 2.5 10\nEND_DNA',
                     'BEGIN_DNA\nx 20 10\nEND_DNA','BEGIN_DNA\na 20 10 extra\nEND_DNA',
                     'BEGIN_DNA\na 20 10\nEND_DNA\nBEGIN_DNA\na 20 10\nEND_DNA'):
            with self.subTest(text=text),self.assertRaises(ValueError):parse_phd(text)
        b,q,p=parse_phd('BEGIN_DNA\na 30 10\nn 0 30\nEND_DNA')
        self.assertEqual(bytes(b),b'AN');self.assertEqual(q.tolist(),[30,0]);self.assertEqual(p.tolist(),[10,30])

    def test_subprocess_contract_and_ambiguous_preservation(self):
        with tempfile.TemporaryDirectory() as temp:
            src=Path(temp)/'original.ab1';fixture(src);trace=read_ab1(src)
            trace.tags['PDMF1']=b'KB_3730_POP7_BDTv3.mob';trace.pb_in[1]=ord('N')
            args=SimpleNamespace(tracetuner_executable=src,tracetuner_timeout=2,p99_target=650)
            before=src.read_bytes()
            def execute(command,**kw):
                self.assertEqual(command[1:],['-3730','-recalln','-p','trace.ab1'])
                staged=read_ab1(Path(kw['cwd'])/'trace.ab1')
                self.assertEqual(bytes(staged.pb_in),b'ANGT')
                (Path(kw['cwd'])/'trace.ab1.phd.1').write_text('BEGIN_DNA\na 35 11\nc 40 31\ng 25 51\nt 10 71\nEND_DNA')
                return SimpleNamespace(returncode=0,stderr=b'',stdout=b'')
            with patch('peaktrace.quality.subprocess.run',side_effect=execute):
                q,d=reassess(trace,trace.channels,trace.pb_in,trace.ploc_in,trace.qv_in,args)
            self.assertEqual(q.tolist(),[35,0,25,10]);self.assertEqual(bytes(trace.pb_in),b'ANGT')
            self.assertEqual(trace.ploc_in.tolist(),[10,30,50,70]);self.assertEqual(src.read_bytes(),before)
            self.assertEqual(d['fitted_position_mean_absolute_shift'],1.)

    def test_engine_failures_are_explicit(self):
        with tempfile.TemporaryDirectory() as temp:
            src=Path(temp)/'original.ab1';fixture(src);trace=read_ab1(src)
            trace.tags['PDMF1']=b'KB_3730_POP7_BDTv3.mob'
            args=SimpleNamespace(tracetuner_executable=src,tracetuner_timeout=2,p99_target=650)
            for error in (subprocess.TimeoutExpired('engine',2),OSError('launch failed')):
                with patch('peaktrace.quality.subprocess.run',side_effect=error),self.assertRaises(ValueError):
                    reassess(trace,trace.channels,trace.pb_in,trace.ploc_in,trace.qv_in,args)
            for body,code in [('BEGIN_DNA\ng 35 11\nc 40 31\ng 25 51\nt 10 71\nEND_DNA',0),
                              ('BEGIN_DNA\na 35 11\nEND_DNA',0),
                              ('BEGIN_DNA\na 35 999\nc 40 31\ng 25 51\nt 10 71\nEND_DNA',0),
                              ('',0),('',1)]:
                def execute(command,**kw):
                    if body:(Path(kw['cwd'])/'trace.ab1.phd.1').write_text(body)
                    return SimpleNamespace(returncode=code,stderr=b'failure',stdout=b'')
                with patch('peaktrace.quality.subprocess.run',side_effect=execute),self.assertRaises(ValueError):
                    reassess(trace,trace.channels,trace.pb_in,trace.ploc_in,trace.qv_in,args)
            trace.tags['PDMF1']=b'unknown'
            with self.assertRaisesRegex(ValueError,'metadata'):
                reassess(trace,trace.channels,trace.pb_in,trace.ploc_in,trace.qv_in,args)

    def test_cli_requires_engine_and_valid_timeout(self):
        base=['--input-dir','input','--output-dir','output']
        self.assertEqual(parse_args(base).quality_mode,'retain')
        for extra in (['--quality-mode','tracetuner'],['--tracetuner-timeout','nan'],['--tracetuner-timeout','0']):
            with self.assertRaises(SystemExit):parse_args(base+extra)


if __name__=='__main__':unittest.main()
