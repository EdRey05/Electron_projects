"""Deterministic demo-only inputs. No patient, company, or instrument data."""
from pathlib import Path
import sys
import numpy as np
from openpyxl import Workbook

root = Path(r'C:\DemoData')
for name in ['sync/source/reports','sync/destination','binding','hub/output','peak/input','peak/output','km','exports']:
    (root/name).mkdir(parents=True, exist_ok=True)
for name, text in {'README.txt':'Synthetic project notes.\n','reports/summary.csv':'sample,value\nDEMO_A,12\nDEMO_B,18\n','sequence.fasta':'>synthetic_insert\nACGTACGTGGCCTTAACCGG\n'}.items():
    (root/'sync/source'/name).write_text(text)
(root/'sync/destination/README.txt').write_text('Old synthetic notes.\n')
wb=Workbook();ws=wb.active;ws.title='Candidates'
ws.append(['Name','ID','Sequence'])
for row in [('Perfect forward','DEMO_001','ACGTACGTGGCC'),('Reverse complement','DEMO_002','GGCCACGTACGT'),('Partial match','DEMO_003','ACGTTCGTGGCC')]:ws.append(row)
wb.save(root/'binding/candidates.xlsx')
(root/'binding/reference.txt').write_text('TTTTACGTACGTGGCCTTAACCGGTTTT')
wb=Workbook();ws=wb.active;ws.title='input addon'
ws.append(['Work No.','Vector','Insert Sequence','Final Vector Sequence'])
for i in range(1,4):ws.append([f'DEMO_{i:03}','pDemo','ACGTACGTGGCC','GGGGACGTACGTGGCCTTTT'])
wb.save(root/'hub/synthetic_primer_log.xlsx')
import configparser
config_path=Path(r'C:\Apps\003_Gene_Synthesis_Hub\resources\python-app\default_directories.ini')
config=configparser.ConfigParser();config.optionxform=str;config.read(config_path,encoding='utf-8')
for key in config['Paths']:
    target=root/'hub/inputs'/key;target.mkdir(parents=True,exist_ok=True)
    config['Paths'][key]=str(target)
config['Paths']['Primer_Log']=str(root/'hub/synthetic_primer_log.xlsx')
config['Paths']['Reference_Sequences']=str(root/'hub/output')
with config_path.open('w',encoding='utf-8') as stream:config.write(stream)
rng=np.random.default_rng(20261022)
with (root/'km/clinical_demo.tsv').open('w') as f:
    f.write('# Synthetic tutorial cohort; not patient data\nPATIENT_ID\tOS_MONTHS\tOS_STATUS\tCOHORT\n')
    for i in range(80):f.write(f'DEMO_{i+1:03}\t{min(float(rng.exponential(30)),60):.2f}\t{"Alive" if i%3==0 else "Dead"}\t{"A" if i%2 else "B"}\n')
# Construct ABIF from known synthetic channels, then let the real app process it.
sys.path.insert(0,r'C:\Apps\004_Peak_Tracer\resources\python-app')
from peaktrace.abif import Entry,pack_entries
from Bio import SeqIO
for sample in range(3):
    n=160;order='GATC';bases=''.join(rng.choice(list('ACGT'),n));positions=np.arange(15,15+n*10,10,dtype='>i2');x=np.arange(int(positions[-1])+30)
    entries=[Entry(b'FWO_',1,2,1,4,order.encode())]
    for k in (1,2):entries += [Entry(b'PBAS',k,2,1,n,bases.encode()),Entry(b'PCON',k,2,1,n,bytes([35]*n)),Entry(b'PLOC',k,4,2,n,positions.tobytes())]
    for c,base in enumerate(order):
        y=np.full(len(x),8.0)
        for b,p in zip(bases,positions):
            if b==base:y+=1100*np.exp(-0.5*((x-int(p))/2.0)**2)
        signal=np.clip(y,0,32000).astype('>i2').tobytes()
        for channel in (c+1,c+9):entries.append(Entry(b'DATA',channel,4,2,len(x),signal))
    path=root/f'peak/input/DEMO_{sample+1:03}_A01.ab1';path.write_bytes(pack_entries(entries))
    assert len(SeqIO.read(path,'abi'))==n
print('Created deterministic synthetic sync, XLSX, AB1, and survival fixtures.')
