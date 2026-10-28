import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { createUnivecService, TTL } = createRequire(import.meta.url)('../../electron/univec.cjs');
test('NCBI cache: seven-day TTL, manual refresh, stale fallback, integrity and source allowlist', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sbf-cache-'));
  let time = 1700000000000, calls = 0, fail = false;
  const service = createUnivecService(dir, { now: () => time, fetchText: async ({onProgress}) => { calls++; if(fail) throw Error('offline'); onProgress({bytes:9}); return '>one\nACGT\n'; } });
  try {
    assert.equal((await service.fetch({which:'UniVec_Core'})).cached, false);
    assert.equal((await service.fetch({which:'UniVec_Core'})).cached, true); assert.equal(calls,1);
    assert.equal((await service.fetch({which:'UniVec_Core',force:true})).cached,false); assert.equal(calls,2);
    time += TTL+1; fail=true;
    const stale=await service.fetch({which:'UniVec_Core'});assert.match(stale.warning,/offline/);assert.equal(stale.fetchedAt,time-TTL-1);
    await fs.writeFile(path.join(dir,'UniVec_Core'),'>tampered\nAAAA\n');
    await assert.rejects(service.fetch({which:'UniVec_Core'}),/offline/);
    await assert.rejects(service.fetch({which:'../../bad'}),/Choose/);
    assert.equal((await fs.readdir(dir)).some(n=>n.endsWith('.tmp')),false);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
test('invalid download cannot replace a valid cache and concurrent fetches share work', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sbf-cache-'));let calls=0;
  const service=createUnivecService(dir,{fetchText:async()=>{calls++;await new Promise(r=>setTimeout(r,20));return '>one\nACGT\n';}});
  try {const a=await Promise.all([service.fetch({which:'UniVec'}),service.fetch({which:'UniVec'})]);assert.equal(calls,1);assert.equal(a[0].sha256,a[1].sha256);
    const bad=createUnivecService(dir,{fetchText:async()=>'<html>error</html>'});assert.match((await bad.fetch({which:'UniVec',force:true})).warning,/invalid FASTA/);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
