import {unzipSync,zipSync,strFromU8,strToU8} from 'fflate';
import {applyFullCalcOnLoad} from './xlsxPostProcess.js';

// Both files are written side by side. Updating the external relationship URI
// preserves the original formulas/styles and needs no Excel COM process.
export function relinkSequencingLayout(templateBytes,orderFormName) {
  const parts=unzipSync(templateBytes instanceof Uint8Array?templateBytes:new Uint8Array(templateBytes));
  let updated=0;
  for(const name of Object.keys(parts)) {
    if(!/^xl\/externalLinks\/_rels\/.*\.rels$/.test(name))continue;
    const xml=strFromU8(parts[name]);
    const patched=xml.replace(/<Relationship\b[^>]*\/>/g,tag=>{
      if(!tag.includes('/externalLinkPath'))return tag;
      const target=tag.match(/\bTarget="([^"]*)"/)?.[1]??'';
      if(!/Sequencing_order_form[^/\\]*\.xlsx/i.test(target))return tag;
      updated++;
      return tag.replace(/\bTarget="[^"]*"/,`Target="${encodeURIComponent(orderFormName).replaceAll("'",'%27')}"`);
    });
    if(patched!==xml)parts[name]=strToU8(patched);
  }
  if(!updated)throw new Error('No sequencing order-form link found in the layout template.');
  return {bytes:applyFullCalcOnLoad(zipSync(parts)),linksUpdated:updated};
}
