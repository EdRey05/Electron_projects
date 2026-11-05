// Drives the actual Electron renderer and IPC through its development CDP ports.
// Uses only Node 22 built-ins. Run inside the prepared development Sandbox.
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const output = process.env.KM_UI_OUTPUT;
const appRoot = process.env.KM_UI_APP_ROOT || 'C:/DevApp';
const dataDirectory = process.env.KM_UI_DATA_DIRECTORY || 'C:/DevExport';
if (!output) throw Error('Set KM_UI_OUTPUT to an external evidence directory.');
fs.mkdirSync(output, { recursive: true });
const report = { checks: [], status: 'failed', error: null };
const sockets = [];
const pause = ms => new Promise(r => setTimeout(r, ms));
async function connect(url) {
  const socket = new WebSocket(url); sockets.push(socket);
  await new Promise((r, j) => { socket.addEventListener('open', r, { once: true }); socket.addEventListener('error', j, { once: true }); });
  let sequence = 0; const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') report.checks.push({ name: 'unhandled-renderer-error', pass: false, detail: message.params });
    const item = pending.get(message.id);
    if (item) { clearTimeout(item.timer); pending.delete(message.id); message.error ? item.reject(Error(JSON.stringify(message.error))) : item.resolve(message.result); }
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 30000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
}
let renderer, main;
async function evaluate(expression, inMain = false) {
  const reply = await (inMain ? main : renderer)('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (reply.exceptionDetails) throw Error(JSON.stringify(reply.exceptionDetails));
  return reply.result.value;
}
async function wait(expression, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await evaluate(expression)) return; await pause(100); }
  throw Error('UI wait timed out: ' + expression);
}
async function click(text) {
  await evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.innerText.trim()===${JSON.stringify(text)}||e.getAttribute('aria-label')===${JSON.stringify(text)});if(!e||e.disabled)throw Error('Button unavailable: '+${JSON.stringify(text)});e.scrollIntoView({block:'center'});e.click();return true})()`);
}
async function select(label, value) {
  await evaluate(`(()=>{const e=[...document.querySelectorAll('select')].find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)});if(!e)throw Error('Select missing: '+${JSON.stringify(label)});e.value=${JSON.stringify(String(value))};e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
}
async function input(label, value) {
  await evaluate(`(()=>{const e=[...document.querySelectorAll('input')].find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)});if(!e)throw Error('Input missing');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(String(value))});e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
}
async function check(name, callback) {
  await callback(); report.checks.push({ name, pass: true });
  fs.writeFileSync(path.join(output, 'ui-progress.json'), JSON.stringify(report, null, 2)); console.log('PASS ' + name);
}
async function screenshot(name) {
  const image = await renderer('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(image.data, 'base64'));
}
async function runPlot(expectedCurves) {
  await click(await evaluate(`document.querySelector('.km-results[data-state=ready]')?'Update plot':'Generate plot'`));
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
  await wait(`!!document.querySelector('#km-plot-svg')&&!document.querySelector('.km-stale')&&document.querySelector('.km-main').getAttribute('aria-busy')==='false'`);
  if (expectedCurves) await wait(`document.querySelectorAll('.km-table tbody tr').length===${expectedCurves}`);
  const error = await evaluate(`document.querySelector('[role=alert]')?.innerText||''`);
  assert.equal(error, '');
}
(async () => {
  try {
    const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
    renderer = await connect(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await renderer('Runtime.enable');
    await renderer('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
    const clinical = fs.readFileSync(path.join(appRoot,'tests/fixtures/clinical_synthetic.tsv'), 'utf8').split(/\r?\n/).filter(l => l && !l.startsWith('#'));
    const ids = clinical.slice(1).map(row => row.split('\t')[0]);
    fs.writeFileSync(path.join(dataDirectory,'rna_signed.tsv'), 'Hugo_Symbol\t' + ids.join('\t') + '\nGENE_NEG\t' + ids.map((_, i) => (-4 + i * 8 / (ids.length - 1)).toFixed(6)).join('\t') + '\nGENE_ZERO\t' + ids.map(() => '0').join('\t') + '\n');
    await check('load-clinical-real-IPC-and-paired-endpoint-charts', async () => {
      assert.equal((await evaluate('window.api.info()')).windowMaximized,true);
      assert.ok(await evaluate(`Array.from(document.querySelectorAll('.km-sidebar input[type=checkbox]')).every(e=>e.checked)`));
      await click('Choose clinical file');
      await wait(`document.querySelectorAll('.km-endpoints svg').length===2`);
      assert.match(await evaluate(`document.body.innerText`), /1000 patients|1,000 patients/);
      await screenshot('01-endpoints');
    });
    await check('explicit-event-assignments-show-patient-counts', async () => {
      await select('Meaning of Alive', 'censored'); await select('Meaning of Dead', 'event');
      await wait(`document.querySelector('.km-mapping-totals').innerText.includes('571')&&document.querySelector('.km-mapping-totals').innerText.includes('429')`);
      assert.match(await evaluate(`document.querySelector('.km-mapping-totals').innerText`), /censored patients/);
      await runPlot(1);
    });
    await check('toast-has-no-flow-shift-and-auto-dismisses', async () => {
      await wait(`!!document.querySelector('.km-toast')`);
      const before = await evaluate(`document.querySelector('.km-stats').getBoundingClientRect().y`);
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('.km-toast')).position`), 'fixed');
      await wait(`!document.querySelector('.km-toast')`, 7000);
      assert.ok(Math.abs(before - await evaluate(`document.querySelector('.km-stats').getBoundingClientRect().y`)) < 1);
    });
    await check('reference-style-figure-and-risk-geometry', async () => {
      await evaluate(`(()=>{const e=[...document.querySelectorAll('label')].find(e=>e.innerText.trim()==='Number-at-risk table').querySelector('input');if(!e.checked)e.click();document.querySelector('.km-results').scrollIntoView({block:'start'});return true})()`);
      await wait(`!!document.querySelector('[data-figure=risk-table]')`);
      const geometry = await evaluate(`(()=>{const title=document.querySelector('[data-figure=x-title]').getBoundingClientRect();const risk=document.querySelector('[data-figure=risk-table]').getBoundingClientRect();const ticks=[...document.querySelectorAll('[data-figure=x-tick]')].map(e=>e.getAttribute('x'));const riskTicks=[...document.querySelectorAll('[data-figure=risk-tick]')].map(e=>e.getAttribute('x'));return{gap:risk.top-title.bottom,aligned:JSON.stringify(ticks)===JSON.stringify(riskTicks),legend:!!document.querySelector('[data-figure=legend]')}})()`);
      assert.ok(geometry.gap > 10, JSON.stringify(geometry)); assert.ok(geometry.aligned); assert.ok(geometry.legend);
      assert.ok(await evaluate(`(()=>{const a=document.querySelector('[data-risk-label=atRisk]').getBoundingClientRect();const b=document.querySelector('[data-risk-kind=atRisk]').getBoundingClientRect();return b.left-a.right>8})()`), 'Risk labels must not touch the first numeric column');
      await screenshot('02-whole-cohort-risk-table');
    });
    await check('low-cardinality-numeric-categories-not-blind-ranges', async () => {
      await click('By variables'); await select('Column for variable 1', 'S4');
      await wait(`!![...document.querySelectorAll('button')].find(e=>e.innerText==='One group per category')`);
      const options = await evaluate(`Array.from(document.querySelector('[aria-label="Column for variable 1"]').options).map(o=>o.value)`);
      assert.ok(!options.includes('OS_STATUS') && !options.includes('OS_MONTHS') && !options.includes('PATIENT_ID'));
      await click('One group per category'); await runPlot(5);
      assert.match(await evaluate(`document.querySelector('.km-stats').innerText`), /1,000/);
      await screenshot('03-categorical-subgroups');
    });
    await check('continuous-clinical-histogram-and-ranges', async () => {
      await select('Column for variable 1', 'S2');
      await wait(`!!document.querySelector('[aria-label="Lower bound for variable 1 group 1"]')`);
      await select('Group count for variable 1', 2); await runPlot(2);
    });
    await check('multiple-variables-create-only-nonempty-combinations', async () => {
      await click('Add variable'); await select('Column for variable 2','S1');
      await wait(`!![...document.querySelectorAll('button')].find(e=>e.innerText==='One group per category')`);
      await click('One group per category'); await runPlot(10);
      await click('Remove variable 2'); await runPlot(2);
    });
    await check('overlapping-ranges-show-clear-error-and-can-be-corrected', async () => {
      const original=await evaluate(`document.querySelector('[aria-label="Upper bound for variable 1 group 1"]').value`);
      await input('Upper bound for variable 1 group 1',Number(original)+1);
      await click('Update plot'); await wait(`!!document.querySelector('[role=alert]')`);
      assert.match(await evaluate(`document.querySelector('[role=alert]').innerText`),/overlap/i);
      await input('Upper bound for variable 1 group 1',original); await runPlot(2);
    });
    await check('endpoint-dropdowns-match-reference-filters', async () => {
      assert.deepEqual(await evaluate(`Array.from(document.querySelector('[aria-label="Time-to-event column"]').options).map(o=>o.value)`),['','OS_MONTHS']);
      assert.deepEqual(await evaluate(`Array.from(document.querySelector('[aria-label="Event observation column"]').options).map(o=>o.value)`),['','OS_STATUS']);
    });
    await check('signed-RNA-profile-zero-split-and-patient-join', async () => {
      await click('Add RNA file'); await wait(`!!document.querySelector('[aria-label="Dataset for variable 1"] option[value=RNA]')`);
      await select('Dataset for variable 1', 'RNA'); await input('Find gene for variable 1', 'GENE_NEG'); await select('Column for variable 1', 'GENE_NEG');
      await wait(`!![...document.querySelectorAll('button')].find(e=>e.innerText==='Split at zero')`);
      await click('Split at zero');
      assert.equal(await evaluate(`document.querySelector('[aria-label="Lower bound for variable 1 group 1"]').value`), '-4');
      await runPlot(2);
      assert.match(await evaluate(`document.querySelector('.km-stats').innerText`), /1,000/);
      await evaluate(`document.querySelector('.km-variable').scrollIntoView({block:'start'});true`);
      await screenshot('04-signed-RNA-controls');
    });
    await check('confidence-and-side-legend-options-update-the-correct-layers', async () => {
      await evaluate(`(()=>{const e=[...document.querySelectorAll('.km-field')].find(e=>e.innerText.includes('Confidence level')).querySelector('select');e.value='0.01';e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
      await wait(`!!document.querySelector('.km-stale')`); await runPlot(2);
      const before=await evaluate(`document.querySelector('[data-figure=legend] line').getAttribute('x1')`);
      await evaluate(`(()=>{const e=[...document.querySelectorAll('label')].find(e=>e.innerText.trim()==='Legend on the side').querySelector('input');e.click();return true})()`);
      await wait(`document.querySelector('[data-figure=legend] line').getAttribute('x1')!==${JSON.stringify(before)}`);
      assert.equal(await evaluate(`!!document.querySelector('.km-stale')`),false);
      await evaluate(`(()=>{const e=[...document.querySelectorAll('label')].find(e=>e.innerText.trim()==='Legend on the side').querySelector('input');e.click();return true})()`);
    });
    await check('automatic-names-custom-labels-and-legend-medians', async () => {
      assert.match(await evaluate(`document.querySelector('[aria-label="Label for variable 1 group 1"]').value`),/^GENE_NEG: -4 to 0$/);
      assert.equal(await evaluate(`document.querySelectorAll('[data-figure=legend-median]').length`),2);
      await input('Label for variable 1 group 1','My low cohort');
      await input('Upper bound for variable 1 group 1',-0.1);
      assert.equal(await evaluate(`document.querySelector('[aria-label="Label for variable 1 group 1"]').value`),'My low cohort');
      await input('Upper bound for variable 1 group 1',0); await runPlot(2);
      const labels=await evaluate(`Array.from(document.querySelectorAll('.km-table tbody tr td:first-child')).map(e=>e.innerText)`);
      assert.ok(labels.includes('My low cohort')); assert.ok(labels.includes('GENE_NEG: 0 to 4'));
      await evaluate(`(()=>{const e=[...document.querySelectorAll('label')].find(e=>e.innerText.trim()==='Median survival in legend').querySelector('input');e.click();return true})()`);
      await wait(`document.querySelectorAll('[data-figure=legend-median]').length===0`);
      await evaluate(`(()=>{const e=[...document.querySelectorAll('label')].find(e=>e.innerText.trim()==='Median survival in legend').querySelector('input');e.click();return true})()`);
    });
    await check('PNG-SVG-Excel-export-from-real-UI', async () => {
      for (const name of ['PNG', 'SVG', 'Excel']) { await click(name); const file = { PNG: 'KM_plot.png', SVG: 'KM_plot.svg', Excel: 'KM_results.xlsx' }[name]; const until = Date.now() + 15000; while (!fs.existsSync(path.join(output, file)) && Date.now() < until) await pause(100); assert.ok(fs.statSync(path.join(output, file)).size > 500); }
      const png = fs.readFileSync(path.join(output, 'KM_plot.png'));
      assert.equal(png.subarray(1, 4).toString(), 'PNG'); assert.equal(png.readUInt32BE(16), 3300);
      const svg = fs.readFileSync(path.join(output, 'KM_plot.svg'), 'utf8'); assert.ok(svg.includes('#F0F0F0') && svg.includes('Number at risk'));
      await evaluate(`document.querySelector('.km-results').scrollIntoView({block:'start'});true`); await screenshot('05-final-figure');
    });
    await check('stale-results-disable-export-until-regenerated', async () => {
      await select('Group count for variable 1', 1);
      await wait(`document.querySelector('.km-stale')&&[...document.querySelectorAll('button')].find(e=>e.innerText==='Excel').disabled`);
      await runPlot(1);
    });
    await check('constant-RNA-safe-single-closed-range', async () => {
      await input('Find gene for variable 1', 'GENE_ZERO'); await select('Column for variable 1', 'GENE_ZERO');
      await wait(`document.querySelector('[aria-label="Group count for variable 1"]')?.options.length===1`);
      await runPlot(1);
    });
    await check('laptop-width-and-reset', async () => {
      await renderer('Emulation.setDeviceMetricsOverride', { width: 1150, height: 850, deviceScaleFactor: 1, mobile: false });
      assert.ok(await evaluate(`document.querySelector('.km-main').scrollWidth<=document.querySelector('.km-main').clientWidth+2`));
      await screenshot('06-laptop'); await click('Start over');
      await wait(`!document.querySelector('#km-plot-svg')&&!![...document.querySelectorAll('button')].find(e=>e.innerText==='Choose clinical file')`);
    });
    if (process.env.KM_OWNER_ACCEPTANCE === '1') await check('owner-clinical-and-full-RNA-through-real-UI', async () => {
      await click('Choose clinical file'); await wait(`document.querySelectorAll('.km-endpoints svg').length===2`);
      await select('Meaning of 0:LIVING', 'censored'); await select('Meaning of 1:DECEASED', 'event');
      await click('Add RNA file'); await wait(`document.body.innerText.includes('20,385 genes')`,30000);
      await click('By variables'); await select('Dataset for variable 1','RNA');
      await input('Find gene for variable 1','ERBB2'); await select('Column for variable 1','ERBB2');
      await wait(`!![...document.querySelectorAll('button')].find(e=>e.innerText==='Split at zero')`,30000);
      await click('Split at zero');
      assert.equal(Number(await evaluate(`document.querySelector('[aria-label="Lower bound for variable 1 group 1"]').value`)),-3.1976);
      await runPlot(2);
      const counts=await evaluate(`document.querySelector('.km-stats').innerText`);
      assert.match(counts,/1,980/); assert.match(counts,/529/);
      assert.match(await evaluate('document.body.innerText'),/multiple rows/);
      await screenshot('07-owner-data-aggregate-figure');
    });
    await check('normal-window-close-stops-owned-worker', async () => {
      const info = await evaluate('window.api.info()');
      assert.ok(info.workerPid);
      await evaluate('setTimeout(()=>window.close(),100);true');
      await pause(1500);
      assert.throws(()=>process.kill(info.workerPid,0), 'Owned Python process must exit when the window closes');
    });
    assert.ok(report.checks.every(c => c.pass)); report.status = 'passed';
  } catch (error) { report.error = error.stack; try { report.dom = await evaluate('document.body.innerText'); await screenshot('failure'); } catch {} }
  finally { fs.writeFileSync(path.join(output, 'ui-result.json'), JSON.stringify(report, null, 2)); for (const socket of sockets) socket.close(); }
  if (report.status !== 'passed') process.exitCode = 1;
})();
