// Preserve the original workbook package; patch only values changed by an engine.
// In particular SheetJS cannot round-trip the ligation template's styles/parts.
import * as XLSX from 'xlsx';
import {unzipSync,zipSync,strFromU8,strToU8} from 'fflate';
const escapeXml=v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const attribute=(tag,key)=>tag.match(new RegExp(`\\b${key}="([^"]*)"`))?.[1];
const signature=c=>JSON.stringify([c?.f??null,c?.v??null,c?.t??null]);
function setCell(xml,ref,cell) {
  const row=Number(ref.replace(/^[A-Z]+/,''));
  const pattern=new RegExp(`<c\\b(?=[^>]*\\br="${ref}")[^>]*?(?:/>|>[\\s\\S]*?</c>)`);
  const old=xml.match(pattern)?.[0];
  const style=old?.match(/\bs="\d+"/)?.[0]??'';
  let content,type='';
  if(cell.f)content=`<f>${escapeXml(cell.f)}</f>`;
  else if(cell.t==='n' && Number.isFinite(cell.v))content=`<v>${cell.v}</v>`;
  else if(cell.t==='b'){type=' t="b"';content=`<v>${cell.v?1:0}</v>`;}
  else{type=' t="inlineStr"';content=`<is><t xml:space="preserve">${escapeXml(cell.v??'')}</t></is>`;}
  const value=`<c r="${ref}" ${style}${type}>${content}</c>`;
  if(old)return xml.replace(pattern,()=>value);
  const rowPattern=new RegExp(`(<row\\b[^>]*\\br="${row}"[^>]*>)([\\s\\S]*?)(</row>)`);
  const emptyRow=new RegExp(`<row\\b(?=[^>]*\\br="${row}")[^>]*/>`);
  if(emptyRow.test(xml))return setCell(xml.replace(emptyRow,tag=>tag.slice(0,-2)+'></row>'),ref,cell);
  const rowMatch=xml.match(rowPattern);
  if(rowMatch) {
    const column=XLSX.utils.decode_cell(ref).c;
    let inserted=false;
    const body=rowMatch[2].replace(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g,tag=>{
      const address=attribute(tag,'r');
      if(!inserted && address && XLSX.utils.decode_cell(address).c>column){inserted=true;return value+tag;}
      return tag;
    });
    return xml.replace(rowPattern,()=>rowMatch[1]+body+(inserted?'':value)+rowMatch[3]);
  }
  const newRow=`<row r="${row}">${value}</row>`;
  let inserted=false;
  xml=xml.replace(/<row\b[^>]*\br="(\d+)"[^>]*>/g,(tag,number)=>{
    if(!inserted && Number(number)>row){inserted=true;return newRow+tag;}return tag;
  });
  return inserted?xml:xml.replace('</sheetData>',newRow+'</sheetData>');
}
export function patchWorkbookValues(templateBytes,workbook) {
  const input=new Uint8Array(templateBytes),parts=unzipSync(input);
  const original=XLSX.read(input,{type:'array'});
  const sheetTags=strFromU8(parts['xl/workbook.xml']).match(/<sheet\b[^>]*\/?>/g)??[];
  const relationships=strFromU8(parts['xl/_rels/workbook.xml.rels']).match(/<Relationship\b[^>]*\/?>/g)??[];
  for(const [index,name] of original.SheetNames.entries()) {
    const id=attribute(sheetTags[index],'r:id');
    const relation=relationships.find(tag=>attribute(tag,'Id')===id);
    const target=attribute(relation??'','Target');
    if(!target)throw new Error(`Template relationship missing: ${name}`);
    const file=target.startsWith('/')?target.slice(1):'xl/'+target;
    if(!parts[file])throw new Error(`Template worksheet missing: ${file}`);
    let xml=strFromU8(parts[file]),changed=false;
    for(const [ref,cell] of Object.entries(workbook.Sheets[name]??{})) {
      if(!/^[A-Z]+\d+$/.test(ref) || signature(cell)===signature(original.Sheets[name][ref]))continue;
      xml=setCell(xml,ref,cell);changed=true;
    }
    if(changed) {
      const dimension=workbook.Sheets[name]['!ref'];
      if(dimension)xml=xml.replace(/<dimension\b[^>]*\/>/,`<dimension ref="${escapeXml(dimension)}"/>`);
      parts[file]=strToU8(xml);
    }
  }
  return zipSync(parts).buffer;
}
