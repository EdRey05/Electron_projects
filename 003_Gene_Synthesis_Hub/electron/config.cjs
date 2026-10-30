const path=require('node:path');

// Match ConfigParser's default: only whole-line comments. Semicolons separate
// constructor arguments; # may legitimately appear in a path or tool value.
function parseIni(text) {
  const result={sections:{},_top:[]};let section=null;
  for(const raw of text.split(/\r?\n/)) {
    const line=raw.trim();
    if(!line || /^[;#]/.test(line))continue;
    const heading=line.match(/^\[([^\]]+)\]$/);
    if(heading){section=heading[1].trim();result.sections[section]??={};continue;}
    const equals=line.indexOf('=');if(equals<0)continue;
    const key=line.slice(0,equals).trim();let value=line.slice(equals+1).trim();
    if(value.length>=2 && ((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'"))))value=value.slice(1,-1);
    if(section===null)result._top.push({key,value});else result.sections[section][key]=value;
  }
  return result;
}
function resolvePath(raw,mappings={}) {
  if(!raw)return '';
  // An absolute path can contain commas; it is not a drive-label expression.
  if(path.win32.isAbsolute(raw))return path.win32.normalize(raw);
  const comma=raw.indexOf(',');
  if(comma>=0) {
    const label=raw.slice(0,comma).trim();
    const relative=raw.slice(comma+1).trim().replace(/^["']|["']$/g,'');
    if(!mappings[label])return '';
    return path.win32.normalize(path.win32.join(mappings[label],relative));
  }
  return path.win32.normalize(raw);
}
module.exports={parseIni,resolvePath};
