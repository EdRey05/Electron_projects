import fs from 'node:fs';
import assert from 'node:assert/strict';
import registryTools from './react-registry.cjs';
const root=new URL('../',import.meta.url);
const source=fs.readFileSync(new URL('src/App.jsx',root),'utf8');
const block=source.match(/const REACT_SUBAPPS = \{([\s\S]*?)\n\};/);
assert.ok(block,'React component registry missing');
const routes=new Set([...block[1].matchAll(/"([^"]+\.jsx)"\s*:/g)].map(m=>m[1]));
const info=fs.readFileSync(new URL('python-app/app_information.txt',root),'utf8');
let current=null;const apps=[];
for(const line of info.split(/\r?\n/)){
 const section=line.match(/^\[([^\]]+)\]/);if(section){current={name:section[1]};apps.push(current);continue;}
 const item=line.match(/^([^=]+?)\s*=\s*(.*)$/);if(item&&current)current[item[1].trim()]=item[2].trim();
}
const react=apps.filter(a=>a.category==='react_route');assert.equal(apps.length,11);assert.equal(react.length,11,'Every canonical tool must have a native interface');
for(const app of react)assert.ok(routes.has(app.entry),`${app.name}: unregistered React entry ${app.entry}`);
console.log(`App registry: ${react.length} React routes resolve to registered components.`);
const upstream='[Primer Finder]\ncategory = tkinter_import\nentry = primer_finder_app.py\n\n[Legacy]\ncategory = tkinter_import\nentry = old_tool.py\n';
const refreshed=registryTools.normalize(upstream);
assert.match(refreshed,/\[Primer Finder\]\ncategory = react_route\nentry = PrimerFinder.jsx/);
assert.match(refreshed,/\[Legacy\]\ncategory = tkinter_import\nentry = old_tool.py/);
assert.equal(registryTools.normalize(refreshed),refreshed,'Normalization must be idempotent');
