export const FIELDS=['work_no','bbi_id','Clone','plasmid_no','Notes','Concentration','ratio_260_280','ratio_260_230','Seq_reactions','Seq_well'];
export const LABELS=['Work No.','BBI ID','Clone and Plate Source','Plasmid No.','Notes','Concentration','OD260/280','OD260/230','Seq reactions','Seq well'];
export const WELLS=Array.from({length:96},(_,i)=>'ABCDEFGH'[i%8]+(Math.floor(i/8)+1));
export const WORKLIST_HEADER='SampleID;SourceDeckPosition;SourceWell;TargetDeckPosition;TargetWell;TransferVolume [µl]';
const clean=v=>String(v??'').trim();
// Mirror the Tk _norm_well exactly: strip brackets and '#' THEN trim, then
// uppercase — "(#a1 )" and "a1" both normalize to "A1".
const well=v=>String(v??'').replace(/[()#]/g,'').trim().toUpperCase();
// Manual target wells accept any non-blank spelling: brackets stripped
// exactly like upstream's Target_well (no uppercasing, no A1-H12 gate).
const targetSpelling=v=>clean(v).replace(/[#()]/g,'');
// Upstream extracts the source well from the Plasmid No. tail with
// re.search(r"([A-H](?:1[0-2]|[1-9]))(?:Stbl.*)?$", IGNORECASE) — two-digit
// plates and Stbl suffixes are fine, missing/ambiguous wells are not.
const sourceWellPattern=/([A-H](?:1[0-2]|[1-9]))(?:Stbl.*)?$/i;
const extractSourceWell=plasmid=>{const m=clean(plasmid).match(sourceWellPattern);return m?m[1].toUpperCase():null;};
const round3=value=>{const n=value*1000,lower=Math.floor(n);return (n-lower===0.5?(lower%2===0?lower:lower+1):Math.round(n))/1000;};
// pandas float64 renders integral means as "30.0" in the CSV; JS numbers
// print "30". Format pooled means the pandas way.
const pyFloat=value=>{const n=Number(value);if(!Number.isFinite(n))return '';const s=String(n);return s.includes('.')||s.includes('e')||s.includes('E')?s:n+'.0';};
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
  const id=clean(row.work_no),source=well(row.Source_well),target=clean(row.Target_well);
  if(!target)throw new Error('Enter a target well.');
  const spelling=targetSpelling(row.Target_well);
  if(!id || /[;\r\n]/.test(id))throw new Error('Enter a Work No. without semicolons or line breaks.');
  if(!WELLS.includes(source))throw new Error('Use wells A1–H12.');
  if(!['A','B','C'].includes(options.source)||!['A','B','C'].includes(options.target))throw new Error('Choose deck position A, B or C.');
  const volume=Number(options.volume);
  if(!Number.isFinite(volume)||volume<5||volume>200||volume%5!==0)throw new Error('Volume must be 5–200 µL in steps of 5.');
  return {...row,Source_spot:options.source,Target_spot:options.target,Transfer_volume:volume,Source_well:source,Target_well:spelling,Automation_string:`${id};${options.source};${source};${options.target};${spelling};${volume}`};
}
export function buildBulk(input,{pool=true,autoWells=true,autoSort=true,sortMode,onWarning,...options}={}) {
  // Rows missing exactly one of the two key columns are excluded — the Tk
  // app warns listing up to ten of them.
  const partial=input.filter(r=>clean(r.work_no)?!clean(r.plasmid_no):!!clean(r.plasmid_no));
  if(partial.length&&onWarning){
    const lines=partial.slice(0,10).map((r,i)=>
      clean(r.plasmid_no)
        ?`row ${input.indexOf(r)+1}: Plasmid No. '${clean(r.plasmid_no)||'(blank)'}' has no Work No.`
        :`row ${input.indexOf(r)+1}: Work No. '${clean(r.work_no)||'(blank)'}' has no Plasmid No.`);
    if(partial.length>10)lines.push(`... and ${partial.length-10} more rows`);
    onWarning('Rows missing Work No. or Plasmid No. are excluded from the worklist:\n'+lines.join('\n'));
  }
  const sort=sortMode ?? (autoSort?'reactions':'none');
  let rows=input.filter(r=>clean(r.work_no)&&clean(r.plasmid_no)).map((r,index)=>({...r,_index:index}));
  if(!rows.length)throw new Error('Add a Work No. and Plasmid No. to at least one row.');
  if(rows.length>96)throw new Error('Bulk input supports up to 96 rows.');
  // Source-well guard on every Plasmid No., mirroring the Tk regex pass:
  // unreadable values are collected (up to ten shown) and abort the whole run.
  const badWells=rows.filter(r=>!extractSourceWell(r.plasmid_no))
    .map(r=>`'${clean(r.plasmid_no)===''?'(blank)':clean(r.plasmid_no)}'`).slice(0,10);
  if(badWells.length)throw new Error('Error: these Plasmid No. values do not contain a readable source well (expected like T0618P2A1, giving well A1):\n'+badWells.join(', '));
  const digits=row=>{
    const text=clean(row.work_no).slice(5,9);
    if(!text||!Number.isFinite(Number(text)))throw new Error(`Work No. ${row.work_no} has no readable digits at positions 6–9.`);
    return Number(text);
  };
  if(autoWells && sort==='reactions') {
    if(rows.some(r=>clean(r.Seq_reactions)===''||!Number.isFinite(Number(r.Seq_reactions))))throw new Error('Enter a numeric Seq reactions value for each row, or turn off auto-sort.');
    rows.forEach(digits);
    rows.sort((a,b)=>Number(b.Seq_reactions)-Number(a.Seq_reactions)||digits(a)-digits(b)||a._index-b._index);
  } else if(autoWells && sort==='sample') {
    rows.forEach(digits);rows.sort((a,b)=>digits(a)-digits(b)||a._index-b._index);
  }
  // Manual-well validation runs before any assignment, exactly like the Tk
  // flow: every row needs a non-blank Seq well (any spelling), pooled clones
  // must agree on the RAW spelling, unpooled rows must not share a
  // normalized well spelling.
  if(!autoWells){
    if(rows.some(r=>!targetSpelling(r.Seq_well)))throw new Error("Error: 'Auto-assign wells' is unchecked, but some rows are missing a 'Seq well' value.");
    if(pool){
      const byClone=new Map();
      for(const r of rows){
        const c=clean(r.Clone);if(!c)continue;
        if(!byClone.has(c))byClone.set(c,new Set());
        byClone.get(c).add(targetSpelling(r.Seq_well));
      }
      const inconsistent=[];
      for(const [c,spellings] of byClone)if(spellings.size>1)inconsistent.push(`Clone '${c}' has conflicting wells: ${[...spellings].join(', ')}`);
      if(inconsistent.length)throw new Error("Error: 'Pool replicates' is checked, but there are inconsistencies in manual well assignments:\n\n"+inconsistent.join('\n'));
    } else {
      const seen=new Set(),dups=new Set();
      for(const r of rows){const norm=well(r.Seq_well);if(seen.has(norm))dups.add(norm);seen.add(norm);}
      const dupWells=[...dups].sort();
      if(dupWells.length)throw new Error("Error: 'Pool replicates' is unchecked, but multiple rows share the same Seq well: "+dupWells.join(', '));
    }
  }
  const assigned=new Map();let next=0;
  rows=rows.map(r=>{
    const key=pool&&clean(r.Clone)?'clone:'+clean(r.Clone):'row:'+r._index;
    const spelling=targetSpelling(r.Seq_well);
    let target;
    if(autoWells) {
      if(!assigned.has(key)){if(next>=96)throw new Error('More than 96 target groups.');assigned.set(key,WELLS[next++]);}
      target=assigned.get(key);
    } else {
      assigned.set(key,spelling);
      target=spelling;
    }
    return transfer({...r,Seq_well:autoWells?`(#${target})`:r.Seq_well,Source_well:extractSourceWell(r.plasmid_no)??'',Target_well:target},options);
  });
  if(autoWells && sort==='reactions')rows.sort((a,b)=>Number(b.Seq_reactions)-Number(a.Seq_reactions)||WELLS.indexOf(a.Target_well)-WELLS.indexOf(b.Target_well));
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
    // Pooled means are float64 upstream — the CSV renders integral means
    // with a trailing ".0".
    const first=group[0];return [first.work_no,first.bbi_id,first.Clone,first.plasmid_no+(group.length>1?'x'+group.length:''),first.Notes,pyFloat(mean(group.map(r=>r.Concentration))),pyFloat(mean(group.map(r=>r.ratio_260_280))),pyFloat(mean(group.map(r=>r.ratio_260_230)))];
  });
}
const csvCell=value=>/[",\r\n]/.test(String(value??''))?'"'+String(value??'').replaceAll('"','""')+'"':String(value??'');
export function worklistCsv(rows){return [WORKLIST_HEADER,...rows.map(r=>csvCell(r.Automation_string))].join('\n')+'\n';}
export function validationCsv(rows,pool){return [LABELS.slice(0,8),...validationRows(rows,pool)].map(row=>row.map(csvCell).join(',')).join('\n')+'\n';}
