/** Native Gene Synthesis Hub: local paths/catalog, file IPC and managed
 * headless processing. All supported subapp interfaces render in this window.
 * No Tk windows, detached app launchers or Streamlit server are started. */
const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const {verifiedCopy,verifiedMove}=require("./file-operations.cjs");

// ---------------------------------------------------------------------------
// Filesystem layout helpers
// ---------------------------------------------------------------------------

function pythonAppRoot() {
  // electron-builder with extraResources: copies land under process.resourcesPath.
  // In dev (`npm run dev`), resourcesPath is <project>/resources (empty) so we
  // fall back to <project>/python-app in source.
  const packaged = path.join(process.resourcesPath || "", "python-app");
  if (fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, "..", "python-app");
}

function runtimeDir() {
  // The portable CPython distribution we stage via scripts/stage-python.js.
  return path.join(pythonAppRoot(), "runtime");
}

function pythonExe() {
  // Windows: python.exe inside the runtime. We never call `python` on PATH.
  return runtime.python(app, path.join(__dirname, ".."));
}

function venvPythonExe() {
  return pythonExe();
}

function appInfoPath() {
  return path.join(pythonAppRoot(), "app_information.txt");
}

function dirConfigPath() {
  return runtime.seedConfig(app, path.join(pythonAppRoot(), "default_directories.ini"));
}

// ---------------------------------------------------------------------------
// Drive scanning (replaces the `vol <drive>:` loop from the legacy .bat)
// ---------------------------------------------------------------------------

const {scanDrives}=require('./drives.cjs');

// ---------------------------------------------------------------------------
// INI parsing (lightweight, no external deps)
// ---------------------------------------------------------------------------
//
// Python's ConfigParser is permissive. We only need:
//   [Section]
//   key = value   ; comments start with ; or #
//   key2 = "quoted 'value with spaces'"
// We implement the minimum to read + write default_directories.ini and
// app_information.txt without pulling in a 200 KB npm package.

const {parseIni,resolvePath}=require('./config.cjs');

function unquote(v) {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  return v;
}

function quote(v) {
  // Quote anything containing whitespace, comma, or quotes.
  if (/[\s,"']/.test(v)) return `"${v.replace(/"/g, '\\"')}"`;
  return v;
}

async function readIniFile(filePath) {
  try {
    const text = await fsp.readFile(filePath, "utf8");
    return parseIni(text);
  } catch (err) {
    if (err.code === "ENOENT") return { sections: {}, _top: [] };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Path resolution: turns the "Label, \"Sub\\Path\"" entries into real paths.
// ---------------------------------------------------------------------------

// Inverse of resolvePath: turn an absolute path back into "Label, \"sub\"" if
// the path lives under one of the known drives.
function reverseResolve(absPath, driveMappings) {
  const norm = path.normalize(absPath);
  for (const [label, drive] of Object.entries(driveMappings)) {
    if (norm.toLowerCase().startsWith(drive.toLowerCase())) {
      let rel = norm.slice(drive.length);
      if (rel.startsWith(path.sep)) rel = rel.slice(1);
      return `${label}, "${rel}"`;
    }
  }
  return absPath;
}

// ---------------------------------------------------------------------------
// Glob the latest matching template / database file (matches the Python
// hub's glob + sort(reverse=True) pattern).
// ---------------------------------------------------------------------------

function globLatest(dir, pattern) {
  if (!fs.existsSync(dir)) return null;
  // Convert simple glob (*.xlsx, prefix*) into a regex. We only support the
  // subset the existing Python code uses: literal prefix + `*` + literal suffix.
  const star = pattern.indexOf("*");
  let regex;
  if (star < 0) {
    regex = new RegExp("^" + escapeRegex(pattern) + "$");
  } else {
    const head = escapeRegex(pattern.slice(0, star));
    const tail = escapeRegex(pattern.slice(star + 1));
    regex = new RegExp("^" + head + ".*" + tail + "$");
  }
  const candidates = fs
    .readdirSync(dir)
    .filter((f) => regex.test(f))
    .sort()
    .reverse(); // newest / highest version first (matches Python's sort(reverse=True) on strings)
  return candidates.length ? path.join(dir, candidates[0]) : null;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

const runtime = require(app.isPackaged
  ? path.join(process.resourcesPath, 'build-common', 'runtime.cjs')
  : path.join(__dirname, '..', '..', 'build-tools', 'runtime.cjs'));
runtime.configure(app);

const isDev = !app.isPackaged && process.env.NODE_ENV !== "production";

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1000,
    minHeight: 700,
    title: "Gene Synthesis Hub",
    backgroundColor: "#CBDADF",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    win.loadURL("http://localhost:5173");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

ipcMain.handle("hub:scanDrives", async () => {
  return scanDrives();
});

ipcMain.handle("hub:loadConfig", async (_evt, { driveMappings }) => {
  const ini = await readIniFile(dirConfigPath());
  const appInfo = await readIniFile(appInfoPath());

  const paths = { ...ini.sections["Paths"] };
  const resolvedPaths = {};
  const missing = [];
  for (const [key, raw] of Object.entries(paths)) {
    const resolved = resolvePath(raw, driveMappings || {});
    const exists = resolved && fs.existsSync(resolved);
    resolvedPaths[key] = { raw, resolved, exists };
    if (!exists) missing.push(key);
  }

  const apps = [];
  for (const [name, info] of Object.entries(appInfo.sections)) {
    apps.push({ name, ...info });
  }

  return { paths: resolvedPaths, missing, apps, configPath: dirConfigPath() };
});

ipcMain.handle("hub:saveConfig", async (_evt, { newValues, driveMappings }) => {
  // Re-write the file preserving comments. Strategy: read original lines,
  // replace any `key = value` line whose key is in newValues, leave the
  // rest untouched. Matches the Python hub's behaviour exactly.
  const filePath = dirConfigPath();
  let original = "";
  if (fs.existsSync(filePath)) original = await fsp.readFile(filePath, "utf8");

  const newLines = [];
  const seen = new Set();
  for (const line of original.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith(";") || stripped.startsWith("#") || stripped.startsWith("[")) {
      newLines.push(line);
      continue;
    }
    const m = line.match(/^\s*([^=]+?)\s*=\s*(.*)$/);
    if (!m) {
      newLines.push(line);
      continue;
    }
    const fileKey = m[1].trim();
    if (fileKey in newValues) {
      newLines.push(`${fileKey} = ${newValues[fileKey]}`);
      seen.add(fileKey);
    } else {
      newLines.push(line);
    }
  }
  // Append any keys that weren't already in the file (defensive — normally
  // the file should already contain every key the UI knows about).
  for (const [k, v] of Object.entries(newValues)) {
    if (!seen.has(k)) newLines.push(`${k} = ${v}`);
  }

  await fsp.writeFile(filePath, newLines.join(os.EOL), "utf8");
  return { ok: true };
});

ipcMain.handle("hub:browsePath", async (_evt, { current, isFile }) => {
  let initialDir = process.cwd();
  if (current && fs.existsSync(current)) {
    initialDir = fs.statSync(current).isDirectory() ? current : path.dirname(current);
  }
  const opts = {
    title: isFile ? "Select file" : "Select folder",
    defaultPath: initialDir,
    properties: isFile ? ["openFile"] : ["openDirectory"],
  };
  const r = await dialog.showOpenDialog(opts);
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

ipcMain.handle("hub:revealPath", async (_evt, p) => {
  if (!p || !fs.existsSync(p)) return false;
  shell.showItemInFolder(p);
  return true;
});

// Every supported catalog entry is native. Do not revive detached GUI/server
// processes when a future catalog entry has not been adapted yet.
ipcMain.handle("hub:launchApp", async () => ({ok:false,error:"This catalog entry has no native Electron route. Refresh the supported catalog."}));

// Open the bundled python-app folder in Explorer — useful while debugging
// which subapp version / template got shipped.
ipcMain.handle("hub:openPythonApp", async () => {
  shell.openPath(pythonAppRoot());
  return pythonAppRoot();
});

// Resolve a set of template / database patterns to the newest matching file
// in the bundled python-app tree. React subapps receive the *pattern* from
// app_information.txt (e.g. "Sequencing_order_form_v*.xlsx") and ask the main
// process which concrete file that pattern points at — same globLatest()
// semantics the Python launch path uses, so both routes pick the same file.
ipcMain.handle("hub:resolveBundledFiles", async (_evt, { templates, databases } = {}) => {
  const out = { templates: {}, databases: {} };
  const resolve = (patterns, dir, bucket) => {
    for (const pair of patterns || []) {
      const [kwarg, pattern] = String(pair).split(":").map((s) => s.trim());
      if (!kwarg || !pattern) continue;
      const found = globLatest(dir, pattern);
      if (found) out[bucket][kwarg] = found;
    }
  };
  resolve(templates, path.join(pythonAppRoot(), "Templates"), "templates");
  resolve(databases, path.join(pythonAppRoot(), "Databases"), "databases");
  return out;
});

// Save arbitrary bytes (e.g. CSV exported by a React subapp) via a native
// save dialog. The renderer passes a default filename and an ArrayBuffer;
// we write it verbatim to the user-chosen path.
ipcMain.handle("hub:saveResultsCsv", async (_evt, { defaultName, bytes }) => {
  const r = await dialog.showSaveDialog({
    title: "Save results",
    defaultPath: defaultName || "results.csv",
    filters: [
      { name: "CSV", extensions: ["csv"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (r.canceled || !r.filePath) return false;
  await fsp.writeFile(r.filePath, Buffer.from(bytes));
  return true;
});

// Choose an output folder (used by subapps that emit multiple files into
// one directory, e.g. QC Vector Map Prep writing .gb files). Returns the
// picked path or null on cancel.
ipcMain.handle("hub:chooseOutputDir", async (_evt, initial) => {
  const r = await dialog.showOpenDialog({
    title: "Select output folder",
    defaultPath: initial || undefined,
    properties: ["openDirectory", "createDirectory"],
  });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

// Save a binary .xlsx (or any binary blob) by opening the native save
// dialog with a default name and writing the bytes. Mirrors
// hub:saveResultsCsv but for binary data. Returns the chosen path, or
// null if the user cancelled.
ipcMain.handle("hub:saveResultsXlsx", async (_evt, { defaultName, bytes } = {}) => {
  const r = await dialog.showSaveDialog({
    title: "Save results",
    defaultPath: defaultName || "output.xlsx",
    filters: [{ name: "Excel", extensions: ["xlsx"] }],
  });
  if (r.canceled || !r.filePath) return null;
  try {
    await fsp.writeFile(r.filePath, Buffer.from(bytes));
    return r.filePath;
  } catch (err) {
    return { error: err.message };
  }
});

// Write a text file to an absolute path. Used by React subapps to save
// results without going through the save dialog flow (e.g. when the path
// was already chosen via hub:chooseOutputDir). Returns { ok, error? }.
ipcMain.handle("hub:writeTextFile", async (_evt, { filePath, text }) => {
  if (!filePath) return { ok: false, error: "No filePath supplied" };
  try {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, text, "utf8");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Write a binary file (e.g. a freshly-emitted .xlsx workbook) to an
// absolute path. Same mkdir behaviour as writeTextFile. The renderer
// passes an ArrayBuffer (not a Buffer) to keep the Electron context
// isolation happy.
ipcMain.handle("hub:writeBinaryFile", async (_evt, { filePath, bytes }) => {
  if (!filePath) return { ok: false, error: "No filePath supplied" };
  try {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    await fsp.writeFile(filePath, buf);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Copy a file (used by subapps that need to lay down a template alongside
// their generated output, e.g. Sequencing Order Form copying the layout
// template). Returns { ok, error? }.
ipcMain.handle("hub:copyFile", async (_evt, {source,dest}) => {
  if(!source||!dest)return {ok:false,error:"source and dest required"};
  try{return {ok:true,...await verifiedCopy(source,dest)};}catch(error){return {ok:false,error:error.message};}
});

// List files + subdirectories in a directory. Optional `filter`:
//   "files"   - files only (default)
//   "dirs"    - directories only
//   "all"     - both
// Optional `extension` (lowercase, with leading dot, e.g. ".txt"): only
// include files whose basename ends with that extension (case-insensitive).
// Returns { ok, entries: [{ name, isDir, size, mtime }], error? }.
ipcMain.handle("hub:listDirectory", async (_evt, { dirPath, filter, extension } = {}) => {
  if (!dirPath) return { ok: false, error: "dirPath required", entries: [] };
  try {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    const result = [];
    for (const ent of entries) {
      const isDir = ent.isDirectory();
      const isFile = ent.isFile();
      if (filter === "dirs" && !isDir) continue;
      if (filter !== "dirs" && filter !== "all" && !isFile) continue;
      if (
        isFile && extension &&
        !ent.name.toLowerCase().endsWith(extension.toLowerCase())
      ) continue;
      const fullPath = path.join(dirPath, ent.name);
      let size = 0;
      let mtime = null;
      if (isFile) {
        try {
          const stat = await fsp.stat(fullPath);
          size = stat.size;
          mtime = stat.mtimeMs;
        } catch { /* ignore stat failures */ }
      }
      result.push({ name: ent.name, isDir, size, mtime });
    }
    // Sort: directories first, then files alphabetically.
    result.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { ok: true, entries: result };
  } catch (err) {
    return { ok: false, error: err.message, entries: [] };
  }
});

// Move a file. Cross-volume moves fall back to copy+delete.
// Returns { ok, error? }.
ipcMain.handle("hub:moveFile", async (_evt, {source,dest}) => {
  if(!source||!dest)return {ok:false,error:"source and dest required"};
  try{return {ok:true,...await verifiedMove(source,dest)};}catch(error){return {ok:false,error:error.message};}
});

// Delete a single file. Returns { ok, error? }.
ipcMain.handle("hub:deleteFile", async (_evt, { filePath }) => {
  if (!filePath) return { ok: false, error: "filePath required" };
  try {
    await fsp.unlink(filePath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Read a binary file (returns the raw bytes as an ArrayBuffer).
// Used by subapps that need to load an Excel template from disk.
ipcMain.handle("hub:readBinaryFile", async (_evt, { filePath }) => {
  if (!filePath) return { ok: false, error: "filePath required" };
  try {
    const buf = await fsp.readFile(filePath);
    return { ok: true, bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Native open-file dialog. Returns the chosen path, or null if cancelled.
ipcMain.handle("hub:chooseFile", async (_evt, { filter } = {}) => {
  const r = await dialog.showOpenDialog({
    title: "Choose file",
    properties: ["openFile"],
    filters: filter ? [{ name: filter, extensions: [filter.replace(/^\./, "")] }] : undefined,
  });
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
});

// Create a directory (recursive, like mkdir -p). Returns { ok, error? }.
ipcMain.handle("hub:createDirectory", async (_evt, { dirPath }) => {
  if (!dirPath) return { ok: false, error: "dirPath required" };
  try {
    await fsp.mkdir(dirPath, { recursive: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("hub:getLayout", async () => {
  return {
    pythonAppRoot: pythonAppRoot(),
    runtimeDir: runtimeDir(),
    // Compatibility field for existing UI; packages live in the full runtime.
    venvDir: runtimeDir(),
    pythonExe: pythonExe(),
    venvPythonExe: venvPythonExe(),
    appInfoPath: appInfoPath(),
    dirConfigPath: dirConfigPath(),
    isPackaged: app.isPackaged,
  };
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

require('./python-jobs.cjs').registerPythonJobs({app,ipcMain,pythonAppRoot,pythonExe});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
