export const FIELDS=['work_no','bbi_id','Clone','plasmid_no','Notes','Concentration','ratio_260_280','ratio_260_230','Seq_reactions','Seq_well'];
export const LABELS=['Work No.','BBI ID','Clone and Plate Source','Plasmid No.','Notes','Concentration','OD260/280','OD260/230','Seq reactions','Seq well'];
export const WELLS=Array.from({length:96},(_,i)=>'ABCDEFGH'[i%8]+(Math.floor(i/8)+1));
export const WORKLIST_HEADER='SampleID;SourceDeckPosition;SourceWell;TargetDeckPosition;TargetWell;TransferVolume [µl]';
const clean=v=>String(v??'').trim();
const well=v=>clean(v).replace(/[#()]/g,'').toUpperCase();
const round3=value=>{const n=value*1000,lower=Math.floor(n);return (n-lower===0.5?(lower%2===0?lower:lower+1):Math.round(n))/1000;};
const mean=values=>{const numbers=values.filter(v=>clean(v)!=='').map(Number).filter(Number.isFinite);return numbers.length?round3(numbers.reduce((a,b)=>a+b,0)/numbers.length):'';};
export function parsePaste(text) {
  const lines=text.replace(/\r/g,'').split('\n').filter(l=>l.trim());
  if(!lines.length)return [];
  const rows=lines.map(line=>line.split('\t'));
  const header=rows[0].map(clean);
  const byName=header.includes('Work No.') && header.includes('Plasmid No.');
  return (byName?rows.slice(1):rows).map(row=>Object.fromEntries(FIELDS.map((key,i)=>[key,clean(row[byName?header.indexOf(LABELS[i]):i])])));
}
export function transfer(row,options) {
  const id=clean(row.work_no),source=well(row.Source_well),target=well(row.Target_well);
  if(!id || /[;\r\n]/.test(id))throw new Error('Enter a Work No. without semicolons or line breaks.');
  if(!WELLS.includes(source)||!WELLS.includes(target))throw new Error('Use wells A1–H12.');
  if(!['A','B','C'].includes(options.source)||!['A','B','C'].includes(options.target))throw new Error('Choose deck position A, B or C.');
  const volume=Number(options.volume);
  if(!Number.isFinite(volume)||volume<5||volume>200||volume%5!==0)throw new Error('Volume must be 5–200 µL in steps of 5.');
  return {...row,Source_spot:options.source,Target_spot:options.target,Transfer_volume:volume,Source_well:source,Target_well:target,Automation_string:`${id};${options.source};${source};${options.target};${target};${volume}`};
}
export function buildBulk(input,{pool=true,autoWells=true,autoSort=true,...options}={}) {
  let rows=input.filter(r=>clean(r.work_no)&&clean(r.plasmid_no)).map((r,index)=>({...r,_index:index}));
  if(!rows.length)throw new Error('Add a Work No. and Plasmid No. to at least one row.');
  if(rows.length>96)throw new Error('Bulk input supports up to 96 rows.');
  if(autoSort) {
    if(rows.some(r=>clean(r.Seq_reactions)===''||!Number.isFinite(Number(r.Seq_reactions))))throw new Error('Enter a numeric Seq reactions value for each row, or turn off auto-sort.');
    rows.sort((a,b)=>Number(b.Seq_reactions)-Number(a.Seq_reactions)||(clean(a.work_no)<clean(b.work_no)?-1:clean(a.work_no)>clean(b.work_no)?1:a._index-b._index));
  }
  const assigned=new Map();let next=0;
  rows=rows.map(r=>{
    const key=pool&&clean(r.Clone)?'clone:'+clean(r.Clone):'row:'+r._index;
    let target=well(r.Seq_well);
    if(autoWells) {
      if(!assigned.has(key)){if(next>=96)throw new Error('More than 96 target groups.');assigned.set(key,WELLS[next++]);}
      target=assigned.get(key);
    } else {
      if(!WELLS.includes(target))throw new Error(`Invalid Seq well for ${r.work_no}: use A1–H12.`);
      if(pool && assigned.has(key)&&assigned.get(key)!==target)throw new Error(`Clone ${r.Clone} has conflicting target wells.`);
      assigned.set(key,target);
    }
    return transfer({...r,Seq_well:`(#${target})`,Source_well:clean(r.plasmid_no).slice(7).replace(/Stbl.*$/,''),Target_well:target},options);
  });
  if(autoSort)rows.sort((a,b)=>Number(b.Seq_reactions)-Number(a.Seq_reactions)||WELLS.indexOf(a.Target_well)-WELLS.indexOf(b.Target_well));
  return rows;
}
export function validationRows(rows,pool) {
  if(!pool)return rows.map(r=>FIELDS.slice(0,8).map(k=>r[k]??''));
  const groups=new Map();
  for(const [index,row] of rows.entries()) {
    const key=clean(row.Clone)?'clone:'+clean(row.Clone):'row:'+index;
    if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);
  }
  return [...groups.values()].map(group=>{
    const first=group[0];return [first.work_no,first.bbi_id,first.Clone,first.plasmid_no+(group.length>1?'x'+group.length:''),first.Notes,mean(group.map(r=>r.Concentration)),mean(group.map(r=>r.ratio_260_280)),mean(group.map(r=>r.ratio_260_230))];
  });
}
const csvCell=value=>/[",\r\n]/.test(String(value??''))?'"'+String(value??'').replaceAll('"','""')+'"':String(value??'');
export function worklistCsv(rows){return [WORKLIST_HEADER,...rows.map(r=>csvCell(r.Automation_string))].join('\n')+'\n';}
export function validationCsv(rows,pool){return [LABELS.slice(0,8),...validationRows(rows,pool)].map(row=>row.map(csvCell).join(',')).join('\n')+'\n';}
