const fs = require('node:fs');
const path = require('node:path');

function configure(app) {
  if (!app.isPackaged) return;
  const base = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'));
  const data = path.join(base, 'data');
  fs.mkdirSync(data, { recursive: true });
  app.setPath('userData', data);
  app.setAppLogsPath(path.join(base, 'logs'));
}
function python(app, sourceRoot) {
  const root = app.isPackaged ? process.resourcesPath : sourceRoot;
  const executable = path.join(root, 'python-app', 'runtime', 'python.exe');
  if (!fs.existsSync(executable)) throw new Error(`Bundled Python missing: ${executable}. Stage the runtime before starting.`);
  return executable;
}
function seedConfig(app, source) {
  if (!app.isPackaged) return source;
  const destination = path.join(app.getPath('userData'), path.basename(source));
  if (!fs.existsSync(destination)) fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  return destination;
}
module.exports = { configure, python, seedConfig };
