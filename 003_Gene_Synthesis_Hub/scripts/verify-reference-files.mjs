import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {extractSequences,planWorkbookOutputs} from '../src/subapps/SequencingReferenceFiles/extractor.js';
const wb=XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([
  ['Final Vector Sequence','Work No.','Insert Sequence','Vector'],
  ['GGACGTCC','TEST01','ACGT','pUC57'],
  ['GGACGTCC','TEST01','ACGT','pUC57'],
  ['','TEST02','TTAA','pET24a'],
]),'input addon');
const bytes=XLSX.write(wb,{type:'array',bookType:'xlsx'});
const result=await extractSequences({arrayBuffer:async()=>bytes});
assert(result.ok);
assert.deepEqual(planWorkbookOutputs(result.rows),[
  {name:'TEST01.txt',contents:'ACGT'},
  {name:'TEST01+pUC57.txt',contents:'GGACGTCC'},
  {name:'TEST02.txt',contents:'TTAA'},
]);
assert.throws(()=>planWorkbookOutputs([{jobId:'../outside',insertSeq:'ACGT'}]),/Invalid output filename/);
assert.throws(()=>planWorkbookOutputs([{jobId:'CON',insertSeq:'ACGT'}]),/Invalid output filename/);
assert.throws(()=>planWorkbookOutputs([{jobId:'TEST',insertSeq:'AAAA'},{jobId:'test',insertSeq:'CCCC'}]),/Conflicting sequences/);
console.log('Reference Files: reordered headers, exact sequence bytes, optional empty cells, duplicate coalescing, filename and conflicting-output preflight passed.');
