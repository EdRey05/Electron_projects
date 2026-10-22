const { spawnSync } = require('node:child_process');
const path = require('node:path');
const runtime = require('./runtime.cjs');
const root = process.cwd();
const python = runtime.python({isPackaged:false}, root);
const files = process.argv.slice(2);
for (const file of files) {
  const result = spawnSync(python, ['-m','unittest','discover','-s',path.dirname(path.join(root,file)),'-p',path.basename(file)], {stdio:'inherit'});
  if (result.status !== 0) process.exit(result.status || 1);
}
