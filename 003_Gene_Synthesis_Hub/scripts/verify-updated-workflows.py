"""Local synthetic fixtures for the actual refreshed Python workflows."""
from datetime import date
import importlib.util
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import zipfile
import openpyxl

ROOT=Path(__file__).resolve().parent.parent/'python-app'
sys.path.insert(0,str(ROOT))
from processors.upload_prep import run

with tempfile.TemporaryDirectory(prefix='gsh-upload-parity-') as temporary:
    base=Path(temporary)
    received=base/'3.6.6 QC files uploaded';received.mkdir()
    shipping=base/'shipping'
    for kind in ['OTHER','BATCH']:(shipping/'20261101'/kind).mkdir(parents=True)
    out=base/'QC_to_upload'
    records=[]
    for scenario in range(1,5):
        for plate in [False,True]:
            index=len(records)
            bbi=(f'BATCH 42-{index}' if scenario==4 else f'BATCH-E42-{index}' if scenario==3 else f'BBI42-{index}')
            tube=('U' if scenario==1 else 'P')+str(70001+index)
            qcf='In House' if scenario==1 or (scenario==4 and not plate) else date(2026,11,1)
            source=received if qcf=='In House' else shipping/'20261101'/('OTHER' if scenario==2 else 'BATCH')
            file=source/f'{bbi} {tube[1:]}.zip'
            with zipfile.ZipFile(file,'w') as archive:archive.writestr('fixture.txt',f'payload {index}')
            records.append(dict(bbi=bbi,tube=tube,plate=plate,qcf=qcf,source=file,scenario=f'S{scenario}{"P" if plate else "T"}'))
    workbook=base/'progress.xlsx';wb=openpyxl.Workbook();ws=wb.active;ws.title='Master Shipping Log'
    ws.append(['Shipment Date','SO','BBI ID','Gene Name','Tube ID','Tubes','QC Folder','Customer Email'])
    for record in records:ws.append([date(2026,11,5),'SO1',record['bbi'],'Gene',record['tube'],'Plate' if record['plate'] else 'Tubes',record['qcf'],'demo@example.test'])
    # Missing core identifiers must not become literal 'nan' placeholder rows.
    ws.append([date(2026,11,5),None,'MISSING','Gene','U99999','Tubes','In House','demo@example.test'])
    wb.save(workbook);wb.close()
    payload=dict(workbook=str(workbook),outputFolder=str(out),paths={'QC_uploaded':str(received),'Shipping_List':str(shipping)})
    logs=[];progress=[]
    preview=run(payload,ROOT,logs.append,progress.append)
    assert len(preview['rows'])==8
    assert [row['scenario'].split()[0] for row in preview['rows']]==[record['scenario'] for record in records]
    assert all(row['state']=='ready' for row in preview['rows'])
    assert not out.exists(),'Preview must not modify disk'
    # Boundary collision: a prefix-sibling name cannot claim a neighbor ZIP.
    first=records[0]['source'];saved=first.read_bytes();first.unlink()
    neighbor=received/(first.name.replace('BBI42-0','BBI42-01'));neighbor.write_bytes(saved)
    boundary=run(payload,ROOT,logs.append,progress.append)
    assert boundary['rows'][0]['state']=='problem'
    neighbor.unlink();first.write_bytes(saved)
    executed=run({**payload,'stamp':preview['stamp'],'execute':True,'checked':list(range(8))},ROOT,logs.append,progress.append)
    assert executed['planned']==8
    outputs=list(out.rglob('*.zip'));assert len(outputs)==8
    assert progress[-1]==1.0
    assert len(list((base/'3.6.6 QC files uploaded'/'2026').glob('*.zip')))==3
    assert len(list(out.rglob('Plates')))==2 # BATCH date root and shared email root each contain a Plates folder
    # A copied target collision must retain a new uploaded-source original.
    first.write_bytes(saved)
    retry=run({**payload,'stamp':preview['stamp'],'execute':True,'checked':[0]},ROOT,logs.append,progress.append)
    assert first.read_bytes()==saved
    assert any('Target already exists' in line for line in logs)
    workbook.touch()
    try:run({**payload,'stamp':preview['stamp'],'execute':True,'checked':[0]},ROOT,logs.append,progress.append)
    except ValueError as error:assert 'changed since review' in str(error)
    else:raise AssertionError('Changed workbook was not rejected')
    # Reuse the upstream discovery method without constructing any Tk widget.
    label_root=ROOT/'Code/Label_generator';sys.path.insert(0,str(label_root))
    spec=importlib.util.spec_from_file_location('gsh_discovery_fixture',label_root/'workflows/sg_relabeling.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    parser=module.SgRelabeling(SimpleNamespace(log=logs.append))
    for folder in ['20261101','20261105','misc']:
        target=shipping/folder;target.mkdir(exist_ok=True)
        (target/'Shipping list for demo.xlsx').write_bytes(b'fixture')
        (target/'In-house items for demo.xls').write_bytes(b'ignored')
    discovered=parser._scan_shipping_folders(str(shipping))
    assert [name for name,_ in discovered]==['20261105','20261101']
    assert all(len(files)==1 for _,files in discovered)
print('Updated workflows: eight upload scenarios, review-only disk safety, anchor boundaries, verified copy/archive, collision preservation, changed-workbook guard and dated shipping discovery passed.')
