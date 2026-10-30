import importlib.util
import json
from pathlib import Path
import sys
spec=importlib.util.spec_from_file_location('qc_fixture',Path(__file__).with_name('verify-qc-file-prep.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
folder=Path(sys.argv[1]);folder.mkdir(parents=True,exist_ok=True)
module.make_zip(folder/'internal','BBI-TEST-01 QC')
(folder/'rename.txt').write_text('BBI-TEST-01\tBBI-TEST-99\n',encoding='utf-8')
module.make_zip(folder/'batch','BATCH001','XTEST001',{'XTEST001.txt':'ACGTCAGT','XTEST001.SEQ':'^^\nACGTCAGT','XTEST001+pUC57.txt':'t'*120+'acgtcagt'+'c'*120,'XTEST001+pUC57.SEQ':'old'})
(folder/'pUC57.fasta').write_text('>pUC57\nACGTCAGT\n',encoding='utf-8')
print(json.dumps({'folder':str(folder),'synthetic':True}))
