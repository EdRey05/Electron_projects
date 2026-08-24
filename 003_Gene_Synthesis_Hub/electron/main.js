/**
 * Gene Synthesis Hub — Electron main process.
 *
 * Responsibilities:
 *   1. Resolve the bundled `python-app/` directory (portable Electron build
 *      unpacks `extraResources` to `process.resourcesPath`; in dev, we fall
 *      back to the source `python-app/` next to the project root).
 *   2. Scan Windows drives for the configured labels ("B8. Gene Synthesis",
 *      "B6. DNA Sequencing", "Public"). The legacy .bat files did this with
 *      `vol <drive>:`; here we do it in Node and expose the result via IPC.
 *   3. Read the [Paths] section of `default_directories.ini` and the
 *      `app_information.txt` (one section per subapp).
 *   4. Spawn subapps:
 *        - tkinter_import: `python.exe <entry>.py --config=... --<kw>=...`
 *          (loaded by the subapp via importlib so it lands as a child window)
 *        - streamlit: `python.exe -m streamlit run <entry> -- --config=...`
 *      Both run in the subapp folder, with the resolved drive mappings passed
 *      through as `--Label=Drive` args — exactly the contract the existing
 *      Python code already understands.
 *
 * The renderer never touches the filesystem directly. Every file/directory
 * operation goes through `ipcMain.handle` so the main process owns path
 * resolution and never trusts renderer-supplied strings.
 */
const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const { spawn } = require("child_process");
const os = require("os");

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

function venvDir() {
  // A `.venv` sibling to the runtime, where deps are installed into.
  return path.join(pythonAppRoot(), "runtime-venv");
}

function pythonExe() {
  // Windows: python.exe inside the runtime. We never call `python` on PATH.
  return path.join(runtimeDir(), "python.exe");
}

function venvPythonExe() {
  return path.join(venvDir(), "Scripts", "python.exe");
}

function appInfoPath() {
  return path.join(pythonAppRoot(), "app_information.txt");
}

function dirConfigPath() {
  return path.join(pythonAppRoot(), "default_directories.ini");
}

// ---------------------------------------------------------------------------
// Drive scanning (replaces the `vol <drive>:` loop from the legacy .bat)
// ---------------------------------------------------------------------------

const DRIVE_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

// Label keywords that mark drives we care about. Matched against the volume
// label returned by `vol X:` on Windows.
const WANTED_LABELS = new Set([
  "B8. Gene Synthesis",
  "B6. DNA Sequencing",
  "Public",
]);

function readVolumeLabel(letter) {
  return new Promise((resolve) => {
    const proc = spawn("cmd.exe", ["/c", `vol ${letter}:`], { windowsHide: true });
    let out = "";
    proc.stdout.on("data", (b) => (out += b.toString("utf8")));
    proc.on("error", () => resolve(null));
    proc.on("close", () => {
      // `vol X:` output (en-US):
      //   Volume in drive X is Label Name
      //   Volume Serial Number is XXXX:XXXX
      const m = out.match(/Volume in drive [A-Z] is\s*(.+?)\r?\n/);
      if (!m) return resolve(null);
      const label = m[1].trim();
      resolve({ letter: `${letter}:`, label });
    });
  });
}

async function scanDrives() {
  const results = await Promise.all(DRIVE_LETTERS.map(readVolumeLabel));
  const found = {};
  for (const r of results) {
    if (!r) continue;
    if (WANTED_LABELS.has(r.label)) found[r.label] = r.letter;
  }
  return found;
}

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

function parseIni(text) {
  const result = { sections: {}, _top: [] };
  let section = "_top";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/[;#].*$/, "").trim(); // strip inline ; # comments
    if (!line) continue;
    const secMatch = line.match(/^\[(.+)\]$/);
    if (secMatch) {
      section = secMatch[1].trim();
      if (!result.sections[section]) result.sections[section] = {};
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = unquote(line.slice(eq + 1).trim());
    if (section === "_top") result._top.push({ key, value });
    else result.sections[section][key] = value;
  }
  return result;
}

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

function resolvePath(rawValue, driveMappings) {
  if (!rawValue) return "";
  if (rawValue.includes(",")) {
    const idx = rawValue.indexOf(",");
    const label = rawValue.slice(0, idx).trim();
    let subpath = rawValue.slice(idx + 1).trim();
    subpath = subpath.replace(/^["']|["']$/g, "");
    const drive = driveMappings[label];
    if (drive) return path.normalize(path.join(drive, subpath));
  }
  return path.normalize(rawValue);
}

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

const isDev = !app.isPackaged && process.env.NODE_ENV !== "production";

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1000,
    minHeight: 700,
    title: "Gene Synthesis Hub",
    backgroundColor: "#0B1426",
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

  await fsp.writeFile(filePath, newLines.join(os.EOL()), "utf8");
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
  const r = await dialog.showDialog(opts);
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

ipcMain.handle("hub:revealPath", async (_evt, p) => {
  if (!p || !fs.existsSync(p)) return false;
  shell.showItemInFolder(p);
  return true;
});

ipcMain.handle("hub:launchApp", async (_evt, { appDef, paths, driveMappings }) => {
  // appDef mirrors a single [Section] from app_information.txt.
  const category = (appDef.category || "").toLowerCase();
  const subPath = path.join(pythonAppRoot(), "Code", appDef.path || "");
  const entry = appDef.entry;
  if (!entry || !fs.existsSync(subPath)) {
    return { ok: false, error: `Subapp folder not found: ${subPath}` };
  }

  // Resolve all the kwarg sets the Python hub supports:
  //   pass_dir_as_kwarg   = KeyA:kwargA; KeyB:kwargB
  //   pass_template_as_kwarg = kwarg:pattern_in_Templates/
  //   pass_db_as_kwarg    = kwarg:pattern_in_Databases/
  const extraArgs = [];
  const resolvedKwargs = {};

  if (appDef.pass_dir_as_kwarg) {
    for (const pair of appDef.pass_dir_as_kwarg.split(";")) {
      const [dirKey, kwarg] = pair.split(":").map((s) => s.trim());
      const raw = paths?.[dirKey]?.raw;
      const resolved = resolvePath(raw, driveMappings || {});
      if (resolved && fs.existsSync(resolved)) {
        resolvedKwargs[kwarg] = resolved;
        extraArgs.push(`--${kwarg}=${resolved}`);
      } else {
        return { ok: false, error: `Directory for "${dirKey}" not found: ${resolved}` };
      }
    }
  }

  if (appDef.pass_template_as_kwarg) {
    const tplDir = path.join(pythonAppRoot(), "Templates");
    for (const pair of appDef.pass_template_as_kwarg.split(";")) {
      const [kwarg, pattern] = pair.split(":").map((s) => s.trim());
      const found = globLatest(tplDir, pattern);
      if (!found) return { ok: false, error: `Template "${pattern}" not found in Templates/` };
      resolvedKwargs[kwarg] = found;
      extraArgs.push(`--${kwarg}=${found}`);
    }
  }

  if (appDef.pass_db_as_kwarg) {
    const dbDir = path.join(pythonAppRoot(), "Databases");
    for (const pair of appDef.pass_db_as_kwarg.split(";")) {
      const [kwarg, pattern] = pair.split(":").map((s) => s.trim());
      const found = globLatest(dbDir, pattern);
      if (!found) return { ok: false, error: `Database "${pattern}" not found in Databases/` };
      resolvedKwargs[kwarg] = found;
      extraArgs.push(`--${kwarg}=${found}`);
    }
  }

  // Drive mapping + config arg — these are what the legacy .bat used to
  // pass via `B8. Gene Synthesis=E:\`. Same contract.
  const driveArgs = [];
  for (const [label, drive] of Object.entries(driveMappings || {})) {
    driveArgs.push(`${label}=${drive}`);
  }
  const configArg = `--config=${dirConfigPath()}`;

  const py = venvPythonExe();
  if (!fs.existsSync(py)) {
    return { ok: false, error: `Bundled Python venv not found at ${py}.\nRun "npm run stage-python" first.` };
  }

  let cmd;
  if (category === "streamlit") {
    cmd = [
      py, "-m", "streamlit", "run", entry,
      "--server.headless", "false",
      "--", configArg, ...driveArgs, ...extraArgs,
    ];
  } else if (entry.endsWith(".py")) {
    cmd = [py, entry, configArg, ...driveArgs, ...extraArgs];
  } else {
    return { ok: false, error: `Unknown entry type for "${appDef.name}"` };
  }

  // Detached: the subapp lives in its own window, the hub stays alive.
  // We don't .unref() because we want the child to outlive a fast hub close,
  // but we also don't await stdout — launch is fire-and-forget.
  try {
    const child = spawn(cmd[0], cmd.slice(1), {
      cwd: subPath,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    return { ok: true, pid: child.pid, command: cmd.join(" ") };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Open the bundled python-app folder in Explorer — useful while debugging
// which subapp version / template got shipped.
ipcMain.handle("hub:openPythonApp", async () => {
  shell.openPath(pythonAppRoot());
  return pythonAppRoot();
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
ipcMain.handle("hub:copyFile", async (_evt, { source, dest }) => {
  if (!source || !dest) return { ok: false, error: "source and dest both required" };
  try {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(source, dest);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
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
ipcMain.handle("hub:moveFile", async (_evt, { source, dest }) => {
  if (!source || !dest) return { ok: false, error: "source and dest both required" };
  try {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fsp.rename(source, dest);
    } catch (renameErr) {
      // Cross-device link or other rename failure: fall back to copy+unlink.
      await fsp.copyFile(source, dest);
      await fsp.unlink(source);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
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
    venvDir: venvDir(),
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

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
