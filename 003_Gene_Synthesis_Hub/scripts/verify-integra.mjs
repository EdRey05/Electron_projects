import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {FIELDS,parsePaste,buildBulk,validationRows,transfer,worklistCsv,WORKLIST_HEADER} from '../src/subapps/IntegraWorklist/engine.mjs';
const rows=[
 {work_no:'WORK01',bbi_id:'BBI01',Clone:'Clone-X',plasmid_no:'U0416P1A5Stbl30C',Notes:'one',Concentration:'20',ratio_260_280:'1.8',ratio_260_230:'2.0',Seq_reactions:'3',Seq_well:'(#A1)'},
 {work_no:'WORK01',bbi_id:'BBI01',Clone:'Clone-X',plasmid_no:'U0416P1B5',Notes:'two',Concentration:'40',ratio_260_280:'2.0',ratio_260_230:'2.2',Seq_reactions:'3',Seq_well:'(#A1)'},
 {work_no:'WORK02',bbi_id:'BBI02',Clone:'Clone-Y',plasmid_no:'U0416P1C5',Notes:'three',Concentration:'50',ratio_260_280:'1.9',ratio_260_230:'2.1',Seq_reactions:'2',Seq_well:'(#B1)'},
];
let cases=0;
for(const pool of [false,true])for(const autoWells of [false,true])for(const autoSort of [false,true]) {
 const options={source:'B',target:'C',volume:85,pool,autoWells,autoSort};
 const native=buildBulk(rows,options);
 const python=fileURLToPath(new URL('../python-app/runtime/python.exe',import.meta.url));
 const result=spawnSync(python,[fileURLToPath(new URL('./integra-reference-oracle.py',import.meta.url))],{input:JSON.stringify({rows,options}),encoding:'utf8',timeout:30000,env:{...process.env,PYTHONIOENCODING:'utf-8'}});
 assert.equal(result.status,0,result.stderr||result.error?.message);
 const oracle=JSON.parse(result.stdout);
 assert.deepEqual(native.map(r=>r.Automation_string),oracle.automation);
 const validation=validationRows(native,pool);
 assert.deepEqual(validation.map(r=>r.map(String)),oracle.validation.map(r=>r.map(String)));
 cases++;
}
const options={source:'B',target:'C',volume:85,pool:true,autoWells:true,autoSort:true};
assert.equal(buildBulk(rows,options)[0].Source_well,'A5');
assert.equal(validationRows(buildBulk(rows,options),true)[0][5],30);
assert.equal(parsePaste(FIELDS.map((_,i)=>'v'+i).join('\t'))[0].work_no,'v0');
assert.throws(()=>buildBulk([{...rows[0],Seq_reactions:'bad'}],options),/numeric/);
assert.throws(()=>buildBulk([{...rows[0],Seq_well:'A99'}],{...options,autoWells:false}),/Invalid Seq well/);
assert.throws(()=>buildBulk([rows[0],{...rows[1],Seq_well:'B2'}],{...options,autoWells:false}),/conflicting/);
assert.equal(buildBulk([{...rows[0],Seq_reactions:'2'},{...rows[2],Seq_reactions:'10'}],options)[0].work_no,'WORK02','Reactions sort numerically, including 10 versus 2');
assert.equal(validationRows(buildBulk(rows.map(r=>({...r,Concentration:'1.2345'})),options),true)[0][5],1.234,'Validation uses NumPy-style ties-to-even rounding');
const single=transfer({work_no:'SINGLE',Source_well:'A1',Target_well:'H6'},options);
assert.equal(single.Automation_string,'SINGLE;B;A1;C;H6;85');
assert(worklistCsv([single]).startsWith(WORKLIST_HEADER+'\n'));
assert.throws(()=>transfer({work_no:'BAD;ID',Source_well:'A1',Target_well:'A1'},options),/semicolons/);
console.log(`Integra: ${cases} option combinations match the actual Python reference; pooling, numeric sorting, validation means, Stbl wells, single transfer and input guards passed.`);
