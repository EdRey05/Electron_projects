#!/usr/bin/env node
// Default is a dry run. Native UIs, processing adapters and runtime are outside
// the copy boundary; --apply performs the reviewed upstream refresh.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {normalize}=require('./react-registry.cjs');
const root=path.resolve(__dirname,'..'),args=process.argv.slice(2);
const option=key=>{const i=args.indexOf(key);return i<0?null:args[i+1];};
const destination=path.resolve(option('--destination')||path.join(root,'python-app'));
const source=path.resolve(option('--source')||path.join(root,'../../BBI_projects/App_hub/Gene_Synthesis_hub'));
if(source.toLowerCase()===destination.toLowerCase()||source.toLowerCase().startsWith(destination.toLowerCase()+path.sep)||destination.toLowerCase().startsWith(source.toLowerCase()+path.sep))throw new Error('Source and destination trees must be separate.');
const manifestFile=path.join(destination,'upstream-manifest.json');
const digest=file=>{let data=fs.readFileSync(file);if(/\.(py|txt|ini|json)$/.test(file))data=Buffer.from(data.toString('utf8').replace(/\r\n/g,'\n'));return crypto.createHash('sha256').update(data).digest('hex');};
function inventory(folder,prefix=''){
 const out={};if(!fs.existsSync(folder))return out;
 for(const item of fs.readdirSync(folder,{withFileTypes:true})){
  if(['__pycache__','.streamlit'].includes(item.name)||item.name.endsWith('.pyc'))continue;
  const full=path.join(folder,item.name),key=prefix+item.name;
  if(item.isSymbolicLink())throw new Error('Source symlink is not supported: '+key);
  if(item.isDirectory())Object.assign(out,inventory(full,key+'/'));else out[key]=digest(full);
 }
 return out;
}
function snapshot(){const files={};for(const folder of ['Code','Templates','Databases'])Object.assign(files,inventory(path.join(destination,folder),folder+'/'));return {schema:1,hashPolicy:'SHA256; normalize CRLF to LF for source/config text',files};}
if(args.includes('--snapshot')){
 fs.writeFileSync(manifestFile,JSON.stringify(snapshot(),null,2)+'\n');console.log('Staged source snapshot recorded. Review and commit it.');process.exit(0);
}
if(!fs.existsSync(path.join(source,'app_information.txt')))throw new Error('Reference Gene Synthesis Hub catalog not found: '+source);
const catalog=fs.readFileSync(path.join(source,'app_information.txt'),'utf8'),sections=[];
for(const part of catalog.split(/(?=^\[)/m)){
 const title=part.match(/^\[([^\]]+)\]/),folder=part.match(/^path\s*=\s*(.+)$/m);
 if(title&&folder)sections.push({name:title[1],folder:folder[1].trim().replace(/\\/g,'/')});
}
if(sections.length!==11||!sections.some(s=>s.name==='QC File Prep')||!sections.some(s=>s.name==='Label Generator'))throw new Error('Expected the 11-tool Gene Synthesis Hub; refusing another hub.');
const selected=option('--app'),all=args.includes('--all');
if(!selected&&!all)throw new Error('Choose --app "Primer Finder" or --all. Add --shared for templates/databases; --apply after reviewing the plan.');
const tools=all?sections:sections.filter(s=>s.name===selected);
if(!tools.length)throw new Error('Unknown canonical app name: '+selected);
const folders=[...new Set(tools.map(t=>t.folder))];
if(args.includes('--shared'))folders.push('Templates','Databases');
for(const folder of folders){
 if(!/^(Code\/[A-Za-z0-9_ -]+|Templates|Databases)$/.test(folder))throw new Error('Unexpected source folder: '+folder);
 if(!fs.statSync(path.join(source,folder)).isDirectory())throw new Error('Source folder missing: '+folder);
}
const previous=fs.existsSync(manifestFile)?JSON.parse(fs.readFileSync(manifestFile,'utf8')):{files:{}};
const changes=[],local=[];
for(const folder of folders){
 const before=inventory(path.join(destination,folder),folder+'/'),after=inventory(path.join(source,folder),folder+'/');
 for(const key of new Set([...Object.keys(before),...Object.keys(after)])){
  if(before[key]!==after[key])changes.push({file:key,change:!before[key]?'add':!after[key]?'remove':'update'});
  if(before[key]!==previous.files[key])local.push(key);
 }
}
console.log(JSON.stringify({mode:args.includes('--apply')?'apply':'preview',tools:tools.map(t=>t.name),folders,changes,localChanges:local},null,2));
if(!args.includes('--apply'))process.exit(0);
if(local.length&&!args.includes('--allow-local-changes'))throw new Error('Staged sources changed since snapshot. Review them; explicit --allow-local-changes is required to replace them.');
for(const folder of folders){
 const target=path.resolve(destination,folder);
 if(!target.startsWith(destination+path.sep))throw new Error('Target escaped python-app.');
 fs.rmSync(target,{recursive:true,force:true});
 fs.cpSync(path.join(source,folder),target,{recursive:true,filter:file=>!file.includes('__pycache__')&&!file.split(path.sep).includes('.streamlit')&&!file.endsWith('.pyc')});
}
fs.writeFileSync(path.join(destination,'app_information.txt'),normalize(catalog),'utf8');
if(args.includes('--defaults'))fs.copyFileSync(path.join(source,'default_directories.ini'),path.join(destination,'default_directories.ini'));
fs.writeFileSync(manifestFile,JSON.stringify(snapshot(),null,2)+'\n');
console.log('Sources refreshed. Review native port parity, run validation and packaged ZIP checks; commit after reviewing the diff.');
