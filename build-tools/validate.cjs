// Runs inside the disposable builder; no network access or source mutation.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const root = process.cwd();
const pkg = require(path.join(root, 'package.json'));
const lock = require(path.join(root, 'package-lock.json'));
const toolchain = require('./toolchain.json');
assert.equal(process.versions.node, toolchain.node, 'Use the pinned build Node');
assert.equal(lock.version, pkg.version, 'Lockfile version must match package');
assert.equal(lock.packages[''].version, pkg.version);
for (const section of ['dependencies', 'devDependencies']) {
  assert.deepEqual(lock.packages[''][section], pkg[section], `Lockfile ${section} differ`);
}
assert.equal(pkg.devDependencies.electron, toolchain.electron);
assert.equal(lock.packages['node_modules/electron'].version, toolchain.electron);
assert.equal(pkg.devDependencies['electron-builder'], toolchain.electronBuilder);
assert.ok(/^\d+\.\d+\.\d+$/.test(pkg.version), 'Release must have a stable semantic version');
const config = require(path.join(root, 'electron-builder.json'));
assert.equal(config.extends, '../build-tools/electron-builder.base.cjs');
for (const resource of config.extraResources || []) {
  assert.ok(fs.existsSync(path.resolve(root, resource.from)), `Missing packaging resource: ${resource.from}`);
}
const python = path.join(root, 'python-app', 'requirements.txt');
if (fs.existsSync(python)) {
  const lines = fs.readFileSync(path.join(root, 'python-app', 'requirements.lock.txt'), 'utf8').split(/\r?\n/).filter(s => s.trim() && !s.startsWith('#'));
  assert.ok(lines.length);
  assert.ok(lines.every(s => /^[A-Za-z0-9_.-]+==[^\s]+$/.test(s)), 'Python lock must contain exact registry versions');
}
function check(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) check(p);
    else if (/\.(c?js|mjs)$/.test(p)) {
      const result = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
  }
}
check(path.join(root, 'electron'));
console.log(`${pkg.name} ${pkg.version}: build contract passed`);
