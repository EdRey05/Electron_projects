const {spawnSync}=require('node:child_process'),path=require('node:path'),assert=require('node:assert/strict');
const result=spawnSync(path.resolve(__dirname,'../python-app/runtime/python.exe'),['-I','-X','utf8',path.join(__dirname,'verify-qc-file-prep.py')],{encoding:'utf8',timeout:120000});
assert.equal(result.status,0,result.stdout+'\n'+result.stderr);console.log(result.stdout.trim());
