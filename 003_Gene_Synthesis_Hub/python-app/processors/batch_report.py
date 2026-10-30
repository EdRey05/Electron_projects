import os
from pathlib import Path
import tempfile
from processors.common import load_upstream,validate_archive,private_word_conversion

def run(payload,root,log):
    folder=Path(payload.get('inputFolder',''))
    if not folder.is_dir():raise ValueError('Choose a folder containing BATCH ZIP files.')
    files=sorted(p for p in folder.iterdir() if p.is_file() and p.suffix.lower()=='.zip')
    if not files:raise ValueError('No ZIP files found in the selected folder.')
    output=Path(payload.get('outputFolder') or folder)
    output.mkdir(parents=True,exist_ok=True)
    module=load_upstream('gsh_batch_report',root/'Code/BATCH_QC_report/batch_qc_report_app.py')
    executable=root/'tools/tesseract/tesseract.exe'
    if not executable.is_file():raise ValueError('Bundled OCR is missing. Extract the complete app ZIP.')
    module.pytesseract.pytesseract.tesseract_cmd=str(executable)
    os.environ['TESSDATA_PREFIX']=str(executable.parent/'tessdata')
    module.find_tesseract=lambda:str(executable)
    module.configure_tesseract=lambda log=log:True
    warnings=[]
    def convert(source,where,log=log):
        if not payload.get('allowWord'):
            warnings.append('Legacy DOC requires Microsoft Word conversion: '+Path(source).name)
            log(warnings[-1]);return None
        return private_word_conversion(source,where,log)
    module.convert_doc_to_docx=convert
    records=[]
    with tempfile.TemporaryDirectory(prefix='gsh-batch-') as temporary:
        for index,file in enumerate(files,1):
            validate_archive(file)
            log(f'{index}/{len(files)} · {file.name}')
            record=module.process_zip(str(file),temporary,log=log)
            missing=[]
            if record.get('plasmid_no')=='NOT FOUND':missing.append('Plasmid No.')
            if not record.get('insert_seq'):missing.append('insert sequence')
            if not record.get('final_vector_seq'):missing.append('final vector sequence')
            if record.get('od260') is None:missing.append('OD values')
            if missing:warnings.append(file.name+': review missing '+', '.join(missing))
            records.append(record)
        target=output/'QC_Report.xlsx'
        fd,staged=tempfile.mkstemp(prefix='.gsh-qc-',suffix='.xlsx',dir=output)
        os.close(fd)
        try:
            module.write_excel_report(records,staged,log=log)
            os.replace(staged,target)
        finally:
            if Path(staged).exists():Path(staged).unlink()
    preview=[{k:v for k,v in row.items() if k!='od_blob'} for row in records]
    log('Report saved: '+str(target))
    for warning in warnings:log('Review: '+warning)
    return {'outputPath':str(target),'records':preview,'warnings':warnings}
