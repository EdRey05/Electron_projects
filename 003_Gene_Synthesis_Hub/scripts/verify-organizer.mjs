import assert from 'node:assert/strict';
import {classifyFile} from '../src/subapps/SequencingFileOrganizer/organize.js';
import {mapReferenceFiles} from '../src/subapps/SequencingFileOrganizer/distribute.js';
import {classifyFolderForSgCheck} from '../src/subapps/SequencingFileOrganizer/sgCheck.js';
// Case-SENSITIVE, exactly like os.listdir + str.endswith upstream: ".AB1",
// ".FASTA", ".SEQ" and ".TXT" variants are simply skipped, only the three
// exact POS spellings count as positive controls.
assert.equal(classifyFile('P1_WORK-01_F.ab1').type,'parseable');
assert.equal(classifyFile('P1_WORK-01_F.AB1').type,'other');
assert.equal(classifyFile('P1_WORK-01_R.FASTA').type,'other');
assert.equal(classifyFile('P1_WORK-01_R.fasta').folderName,'WORK-01.P1');
assert.equal(classifyFile('pOs_control_F.AB1').type,'other');
assert.equal(classifyFile('POS_control_F.ab1').type,'pos');
assert.equal(classifyFile('pOs_control_F.ab1').type,'parseable'); // not one of the three POS spellings
assert.equal(classifyFile('discard.SEQ').type,'other');
assert.equal(classifyFile('discard.seq').type,'seq');
assert.deepEqual(mapReferenceFiles(['WORK-01+pUC57.txt'],['WORK-01']),{'WORK-01':['WORK-01+pUC57.txt']});
assert.deepEqual(mapReferenceFiles(['WORK-01+pUC57.TXT'],['WORK-01']),{});
assert.equal(classifyFolderForSgCheck('WORK-01.P1',['trace.ab1','reference.txt']).valid,true);
assert.equal(classifyFolderForSgCheck('WORK-01.P1',['trace.AB1','reference.txt']).valid,false);
console.log('Organizer: case-sensitive sequencing/reference extensions and positive controls preserve identifiers and SG Check completeness.');
