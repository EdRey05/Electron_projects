import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildBulk} from '../src/subapps/IntegraWorklist/engine.mjs';
const rows=['XV1690506-extra','XV1690010','XV1690506'].map((work_no,i)=>({work_no,bbi_id:'BBI',Clone:`Clone-${i}`,plasmid_no:`U0416P1${'ABC'[i]}5`,Seq_reactions:[2,10,2][i],Seq_well:['C1','A1','B1'][i]}));
for(const sortMode of ['sample','none','reactions'])for(const autoWells of [true,false])for(const pool of [true,false]){
 const options={source:'B',target:'C',volume:85,sortMode,autoWells,pool};
 const actual=buildBulk(rows,options);
 const result=spawnSync(fileURLToPath(new URL('../python-app/runtime/python.exe',import.meta.url)),[fileURLToPath(new URL('./integra-reference-oracle.py',import.meta.url))],{input:JSON.stringify({rows,options}),encoding:'utf8',timeout:30000});
 assert.equal(result.status,0,result.stderr);
 assert.deepEqual(actual.map(row=>row.Automation_string),JSON.parse(result.stdout).automation,JSON.stringify(options));
 if(!autoWells)assert.deepEqual(actual.map(row=>row.work_no),rows.map(row=>row.work_no));
}
assert.throws(()=>buildBulk([{...rows[0],work_no:'BAD'}],{source:'B',target:'C',volume:85,sortMode:'sample'}),/readable digits/);
assert.throws(()=>buildBulk(rows.map(row=>({...row,Seq_well:'A1'})),{source:'B',target:'C',volume:85,pool:false,autoWells:false}),/multiple rows share the same Seq well: A1/);
console.log('Integra 4.6: all three sort modes × pooling × generated/manual wells match the actual reference; suffixes, stable ties, invalid keys and duplicate manual targets passed.');
