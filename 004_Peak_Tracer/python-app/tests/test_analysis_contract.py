"""Independent ABIF round trips and batch safety, using portable synthetic fixtures."""
import contextlib
import io
import itertools
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
import numpy as np
from Bio import SeqIO
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from peaktrace.abif import Entry,read_entries,pack_entries
from peaktrace.read import read_ab1,write_seq
from peaktrace.write import write_ab1
from peaktrace.analysis import clear_range
from peaktrace.config import parse_args
from peaktrace.cli import main


def fixture(path, order='GATC', qualities=(30,30,30,30)):
    e=[Entry(b'FWO_',1,2,1,4,order.encode()),Entry(b'TEST',1,2,1,3,b'abc')]
    positions=np.array([10,30,50,70],dtype='>i2')
    for n in (1,2):
        e += [Entry(b'PBAS',n,2,1,4,b'ACGT'),Entry(b'PCON',n,2,1,4,bytes(qualities)),
              Entry(b'PLOC',n,4,2,4,positions.tobytes())]
    for ch in range(4):
        a=np.zeros(90,dtype='>i2');a[int(positions['ACGT'.index(order[ch])])]=1000
        e.append(Entry(b'DATA',ch+9,4,2,90,a.tobytes()))
        e.append(Entry(b'DATA',ch+1,4,2,90,a.tobytes()))
    path.write_bytes(pack_entries(e))


class FileContractTests(unittest.TestCase):
    def test_all_channel_orders_and_independent_roundtrip(self):
        with tempfile.TemporaryDirectory() as temp:
            src=Path(temp)/'input.ab1';dst=Path(temp)/'output.ab1'
            for order in itertools.permutations('ACGT'):
                fixture(src,''.join(order));t=read_ab1(src)
                for base,position in zip('ACGT',t.ploc_in):self.assertEqual(t.base_channels[base][position],1000)
                changed={ch:a*0.5 for ch,a in t.channels.items()}
                write_ab1(dst,t,t.pb_in,t.qv_in,t.ploc_in,channels=changed,p99_target=0,clear_range=(0,3))
                output=SeqIO.read(dst,'abi').annotations['abif_raw']
                self.assertEqual(output['PBAS2'],b'ACGT')
                self.assertEqual(output['PCON2'],bytes([30]*4))
                self.assertEqual(output['TEST1'],b'abc')
                self.assertEqual(output['phTR1'],(0,2))
                for ch in range(9,13):self.assertTrue(np.array_equal(output[f'DATA{ch}'],changed[ch]))
                for ch in range(1,5):self.assertEqual(output[f'DATA{ch}'],t.tags[f'DATA{ch}'])

    def test_directory_count_and_invalid_spans(self):
        buf=pack_entries([Entry(b'abcd',1,2,1,6,b'abcdef')])
        self.assertEqual(len(read_entries(buf+b'not more directory entries'*4)),1)
        bad=bytearray(buf);offset=int.from_bytes(buf[26:30],'big')
        struct.pack_into('>I',bad,offset+20,len(buf)+100)
        with self.assertRaises(ValueError):read_entries(bad)

    def test_rejects_duplicate_and_overflow_positions(self):
        with tempfile.TemporaryDirectory() as temp:
            src=Path(temp)/'in.ab1';fixture(src);t=read_ab1(src)
            for positions in ([10,10,50,70],[10,30,50,40000]):
                with self.assertRaises(ValueError):write_ab1(Path(temp)/'out.ab1',t,t.pb_in,t.qv_in,positions)

    def test_unedited_set_selected_as_a_whole(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp)/'in.ab1';fixture(p)
            entries=read_entries(p.read_bytes());entries=[Entry(e.name,e.number,e.code,e.size,e.count,b'TTTT') if e.key==(b'PBAS',1) else e for e in entries]
            p.write_bytes(pack_entries(entries))
            self.assertEqual(bytes(read_ab1(p).pb_in),b'ACGT')
            self.assertEqual(bytes(read_ab1(p,use_edited=True).pb_in),b'TTTT')

    def test_empty_clear_range_and_export_formats(self):
        self.assertEqual(clear_range([1]*100), (0,0))
        self.assertEqual(clear_range([40]*5),(0,5))
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp)/'sample.seq';pb=np.frombuffer(b'ACGT',np.uint8)
            write_seq(p,pb,format='plain',clear_range=(0,3));self.assertEqual(p.read_bytes(),b'ACG')
            write_seq(p,pb,format='abi');self.assertEqual(p.read_bytes(),b'sample      \r\nsample      \r\nACGT')


class BatchContractTests(unittest.TestCase):
    def test_nonfinite_parameters_rejected(self):
        for flag in ('--trim-quality','--resolution-strength'):
            for value in ('nan','inf','-inf'):
                with contextlib.redirect_stderr(io.StringIO()),self.assertRaises(SystemExit):
                    parse_args(['--input-dir','a','--output-dir','b',flag+'='+value])

    def test_all_negative_switches(self):
        args=parse_args(['--input-dir','a','--output-dir','b','--no-preprocess','--no-emit-seq','--no-strip-well-id','--no-write-qc-report','--no-set-abi-limits'])
        for key in ('preprocess','emit_seq','strip_well_id','write_qc_report','set_abi_limits'):self.assertFalse(getattr(args,key))

    def test_real_cli_preserves_source_and_short_read_exports(self):
        with tempfile.TemporaryDirectory() as temp:
            inp=Path(temp)/'input';out=Path(temp)/'output';inp.mkdir()
            src=inp/'sample_A01.ab1';fixture(src,qualities=(1,1,1,1));before=src.read_bytes()
            note=inp/'notes.txt';note.write_text('retain this unrelated document')
            with contextlib.redirect_stdout(io.StringIO()):
                code=main(['--input-dir',str(inp),'--output-dir',str(out)])
            self.assertEqual(code,0);self.assertEqual(src.read_bytes(),before);self.assertTrue(note.exists())
            self.assertEqual((out/'sample.seq').read_bytes(),b'')
            self.assertEqual(str(SeqIO.read(out/'sample.ab1','abi').seq),'NNNN')
            manifest=json.loads((out/'run_manifest.json').read_text())
            self.assertEqual(manifest['files'][0]['clear_end'],0)

    def test_collision_is_rejected_before_outputs(self):
        with tempfile.TemporaryDirectory() as temp:
            inp=Path(temp)/'input';inp.mkdir();out=Path(temp)/'output'
            fixture(inp/'same_A01.ab1');fixture(inp/'same_A02.ab1')
            with contextlib.redirect_stdout(io.StringIO()):code=main(['--input-dir',str(inp),'--output-dir',str(out)])
            self.assertEqual(code,2);self.assertFalse(out.exists())


if __name__=='__main__':unittest.main()
