// Real child-process lifecycle, restart and failure tests; no mock subprocess API.
const { createPythonWorker } = require('../electron/python-worker');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
test('persistent worker, stop, restart, child crash, timeout and spawn failure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'km-worker-test-'));
  const script = path.join(root, 'protocol.cjs');
  fs.writeFileSync(script, `require('readline').createInterface({input:process.stdin}).on('line',line=>{
    const {id,job}=JSON.parse(line);
    if(job.crash) return process.exit(3);
    if(job.hang) return;
    process.stdout.write(JSON.stringify({id,result:{ok:true,value:job.value}})+'\\n');
  });`);
  const worker = createPythonWorker(process.execPath, script, { timeoutMs: 1500 });
  try {
    assert.deepEqual(await worker.run({value:1}), {ok:true,value:1});
    const firstPid = worker.pid;
    const replies = await Promise.all([worker.run({value:2}), worker.run({value:3})]);
    assert.deepEqual(replies.map(r=>r.value), [2,3]); assert.equal(worker.pid, firstPid);
    worker.stop(); await pause(300); assert.throws(()=>process.kill(firstPid,0));
    assert.equal((await worker.run({value:4})).value,4); assert.notEqual(worker.pid,firstPid);
    assert.equal((await worker.run({crash:true})).ok,false);
    assert.equal((await worker.run({value:5})).ok,true);
    assert.match((await worker.run({hang:true})).error,/timed out/);
    assert.equal((await worker.run({value:6})).value,6);
    const unavailable = createPythonWorker(path.join(root,'missing-python.exe'),script);
    assert.match((await unavailable.run({})).error,/Could not start Python/); unavailable.stop();
  } finally { worker.stop(); await pause(300); fs.rmSync(root,{recursive:true,force:true}); }
});
