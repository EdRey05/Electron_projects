import base64
import os
from pathlib import Path
import tempfile
import uuid
from processors.common import load_upstream,validate_archive,private_word_conversion

# Upstream review wiring (batch_qc_report_app v1.5): records flagged for OD
# review split into a no-OD-image list (nothing to type, always pending) and
# a readable list (one image row each). The tkinter dialog edits the four OD
# fields per row; a fully-typed row is MANUAL, a partially-typed row is
# PENDING on its flagged fields plus the blanks, and "Leave all pending"
# writes nothing for the readable rows. The worker keeps no state between
# processes, so the renderer holds the review payload and sends it back on
# the apply step, where the dialog semantics are applied before the write.
_OD_FIELDS=('od260','od280','od_ratio','ng_ul')
_OD_LABELS={'od260':'OD260','od280':'OD280','od_ratio':'OD260/OD280','ng_ul':'ng/uL'}
_PREVIEW_DROP=('od_blob','od_crop','od_flag_fields','od_pending_fields')

def _short_reason(record):
    joined=' | '.join(record.get('od_flags') or [])
    return joined[:60] or 'No OD table'

def _display_image(record):
    # The review dialog falls back to the whole image when the crop could
    # not be produced, exactly like the tkinter dialog column.
    blob=record.get('od_crop') or record.get('od_blob')
    return base64.b64encode(blob).decode('ascii') if blob else None

def _round_trip(record):
    return {
        'zipName':record['zip_name'],'bbiId':record['bbi_id'],
        'plasmidNo':record['plasmid_no'],
        'insertSeq':record['insert_seq'] or None,
        'finalVectorSeq':record['final_vector_seq'] or None,
        'od260':record.get('od260'),'od280':record.get('od280'),
        'odRatio':record.get('od_ratio'),'ngUl':record.get('ng_ul'),
        'odStatus':record['od_status'],
        'odFlags':list(record.get('od_flags') or []),
        'odFlagFields':sorted(record.get('od_flag_fields') or ()),
        'odPendingFields':sorted(record.get('od_pending_fields') or ()) or None,
        'blob':base64.b64encode(record['od_blob']).decode('ascii') if record.get('od_blob') else None,
    }

def _reconstruct(raw):
    """Rebuild a processed record dict from the round-tripped renderer
    payload (strings, floats and the embedded od_blob bytes)."""
    return {
        'zip_name':str(raw['zipName']),
        'bbi_id':str(raw['bbiId']),
        'plasmid_no':str(raw['plasmidNo']),
        'insert_seq':raw.get('insertSeq') or None,
        'final_vector_seq':raw.get('finalVectorSeq') or None,
        'od260':_maybe_float(raw.get('od260')),
        'od280':_maybe_float(raw.get('od280')),
        'od_ratio':_maybe_float(raw.get('odRatio')),
        'ng_ul':_maybe_float(raw.get('ngUl')),
        'od_status':str(raw['odStatus']),
        'od_flags':list(raw.get('odFlags') or []),
        'od_flag_fields':set(raw.get('odFlagFields') or ()),
        'od_pending_fields':set(raw.get('odPendingFields') or ()),
        'od_blob':base64.b64decode(raw['blob']) if raw.get('blob') else None,
        'od_crop':None,
    }

def _maybe_float(value):
    if value is None or value=='':return None
    return float(value)

def _preview(records):
    return [dict((k,v) for k,v in row.items() if k not in _PREVIEW_DROP) for row in records]

def _write(module,records,output,log):
    target=output/'QC_Report.xlsx'
    fd,staged=tempfile.mkstemp(prefix='.gsh-qc-',suffix='.xlsx',dir=output)
    os.close(fd)
    try:
        module.write_excel_report(records,staged,log=log)
        os.replace(staged,target)
    finally:
        if Path(staged).exists():Path(staged).unlink()
    log('Report saved: '+str(target))
    return target

def run(payload,root,log):
    if payload.get('step')=='apply':return _apply(payload,root,log)
    folder=Path(payload.get('inputFolder',''))
    if not folder.is_dir():raise ValueError('Choose a folder containing BATCH ZIP files.')
    files=sorted(p for p in folder.iterdir() if p.is_file() and p.suffix.lower()=='.zip')
    if not files:raise ValueError('No ZIP files found in the selected folder.')
    output=Path(payload.get('outputFolder') or folder)
    output.mkdir(parents=True,exist_ok=True)
    module=load_upstream('gsh_batch_report',root/'Code/BATCH_QC_report/batch_qc_report_app.py')
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
    # Upstream partition (main thread): records without any OD image have
    # nothing to type; readable records carry an image and any non-AUTO
    # status.
    no_input=[i for i,r in enumerate(records) if not (r.get('od_crop') or r.get('od_blob'))]
    readable=[i for i,r in enumerate(records) if r.get('od_status')!='AUTO' and (r.get('od_crop') or r.get('od_blob'))]
    if not no_input and not readable:
        log('No flagged rows - writing the report...')
        target=_write(module,records,output,log)
        for warning in warnings:log('Review: '+warning)
        return {'outputPath':str(target),'records':_preview(records),'warnings':warnings}
    log(f'{len(no_input)+len(readable)} record(s) flagged for OD review ({len(no_input)} with no OD table, {len(readable)} to check):')
    for i in no_input:
        log(f'  - {records[i]["zip_name"]} - {records[i]["bbi_id"]}: {_short_reason(records[i])}')
    for i in readable:
        log(f'  - {records[i]["zip_name"]} - {records[i]["bbi_id"]}: {" ; ".join(records[i].get("od_flags") or [])}')
    review={
        'noInput':[{'index':i,'zipName':records[i]['zip_name'],'bbiId':records[i]['bbi_id'],
                    'reason':_short_reason(records[i])} for i in no_input],
        'readable':[{'index':i,'zipName':records[i]['zip_name'],'bbiId':records[i]['bbi_id'],
                     'flags':list(records[i].get('od_flags') or []),
                     'image':_display_image(records[i]),
                     'values':{f:records[i].get(f) for f in _OD_FIELDS}} for i in readable],
    }
    token=uuid.uuid4().hex[:12]
    return {'step':'review','token':token,'review':review,
            'records':[_round_trip(r) for r in records],'warnings':warnings}

def _apply(payload,root,log):
    raw_list=payload.get('records') or []
    if not isinstance(raw_list,list) or not raw_list:
        raise ValueError('No review payload provided. Create the report again.')
    records=[_reconstruct(raw) for raw in raw_list]
    output=Path(payload.get('outputFolder') or '')
    if not output.is_dir():raise ValueError('Choose a valid output folder again.')
    output.mkdir(parents=True,exist_ok=True)
    warnings=list(payload.get('warnings') or [])
    module=load_upstream('gsh_batch_report',root/'Code/BATCH_QC_report/batch_qc_report_app.py')
    # The same partition rules as the process step (od_crop always derives
    # from od_blob, so blob presence decides both lists).
    no_input=[i for i,r in enumerate(records) if not r['od_blob']]
    readable=[i for i,r in enumerate(records) if r['od_status']!='AUTO' and r['od_blob']]
    entered=payload.get('entered') or {}
    if not payload.get('skipped'):
        for index_text,edits in entered.items():
            try:index=int(index_text)
            except (TypeError,ValueError):continue
            if index not in readable:continue
            record=records[index];values={}
            for field in _OD_FIELDS:
                raw_text=str((edits or {}).get(field) or '').strip().replace(',','.')
                if raw_text=='':values[field]=None;continue
                try:values[field]=float(raw_text)
                except ValueError:
                    raise ValueError(f"{record['bbi_id']}: '{raw_text}' is not a number ({_OD_LABELS[field]}).")
            blank=[f for f,v in values.items() if v is None]
            for field,value in values.items():
                if value is not None:record[field]=value
            flagged=set(record.get('od_flag_fields') or _OD_FIELDS)
            if blank:
                record['od_status']='PENDING'
                record['od_pending_fields']=flagged|set(blank)
            else:
                record['od_status']='MANUAL';record['od_pending_fields']=set()
        for index in readable:
            record=records[index]
            if record['od_status']=='MANUAL':
                log(f"  + {record['zip_name']} ({record['bbi_id']}): entered values "
                    f"{record['od260']} / {record['od280']} / {record['od_ratio']} / {record['ng_ul']} ng/uL")
    # no-OD-image records are always simply pending (nothing to type).
    for index in no_input:
        record=records[index]
        record['od_status']='PENDING'
        record['od_pending_fields']=set(record.get('od_flag_fields') or _OD_FIELDS)
    if no_input:
        log(f"  ⏸ {len(no_input)} record(s) without an OD table left pending.")
    if payload.get('skipped'):
        # Upstream: closed/skip dialog marks every readable record PENDING in
        # its flagged fields (all four when the flag field list is absent,
        # which is always the case for process_zip records).
        for index in readable:
            record=records[index]
            record['od_status']='PENDING'
            record['od_pending_fields']=set(record.get('od_flag_fields') or _OD_FIELDS)
        log(f"  ⏸ {len(readable)} record(s) left pending (dialog closed).")
    target=_write(module,records,output,log)
    for warning in warnings:log('Review: '+warning)
    return {'outputPath':str(target),'records':_preview(records),'warnings':warnings}
