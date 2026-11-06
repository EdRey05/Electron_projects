const {spawnSync}=require('node:child_process'),path=require('node:path'),assert=require('node:assert/strict');
const result=spawnSync(path.join(__dirname,'../python-app/runtime/python.exe'),['-I','-X','utf8',path.join(__dirname,'verify-updated-workflows.py')],{encoding:'utf8',timeout:120000});
assert.equal(result.status,0,result.stderr||result.error?.message||result.stdout);
console.log(result.stdout.trim());
