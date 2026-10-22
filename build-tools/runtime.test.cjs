const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const runtime = require('./runtime.cjs');
test('packaged data follows the outer portable executable and preserves user config', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-contract-'));
  const previous = process.env.PORTABLE_EXECUTABLE_DIR;
  try {
    process.env.PORTABLE_EXECUTABLE_DIR = root;
    let userData;
    const app = {isPackaged:true,getPath:n => n==='userData'?userData:path.join(root,'temporary','app.exe'),setPath:(n,p)=>{userData=p;},setAppLogsPath:()=>{}};
    runtime.configure(app);
    assert.equal(userData,path.join(root,'data'));
    const defaults=path.join(root,'defaults.ini');fs.writeFileSync(defaults,'default');
    const config=runtime.seedConfig(app,defaults);fs.writeFileSync(config,'user edits');
    assert.equal(runtime.seedConfig(app,defaults),config);
    assert.equal(fs.readFileSync(config,'utf8'),'user edits');
    assert.throws(()=>runtime.python({isPackaged:false},root),/Bundled Python missing/);
  } finally {
    if (previous===undefined) delete process.env.PORTABLE_EXECUTABLE_DIR; else process.env.PORTABLE_EXECUTABLE_DIR=previous;
    fs.rmSync(root,{recursive:true,force:true});
  }
});
test('development does not change application data paths',()=>{
  runtime.configure({isPackaged:false,setPath:()=>assert.fail('development data changed')});
});
