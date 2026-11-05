// Electron main process for KM Plotter.
//
// Production: loads dist/index.html via file://.
// Development: expects Vite dev server at http://localhost:5173.
//
// Responsibilities:
//   - File-picker dialogs for the clinical (required) and RNA (optional) files.
//   - Spawn the bundled python-app/km_core.py for every analysis job.
//   - Save the generated plot (PNG) and workbook (XLSX) to disk.

const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { createPythonWorker } = require("./python-worker");

const runtime = require(app.isPackaged
  ? path.join(process.resourcesPath, 'build-common', 'runtime.cjs')
  : path.join(__dirname, '..', '..', 'build-tools', 'runtime.cjs'));
runtime.configure(app);

const isDev = !app.isPackaged && process.env.NODE_ENV !== "production";

// ---- bundled python location (matches 003_Gene_Synthesis_Hub / 004_Peak_Tracer) ----
function pythonExePath() {
  return runtime.python(app, path.join(__dirname, '..'));
}

function coreScriptPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "python-app", "km_core.py");
  }
  return path.join(__dirname, "..", "python-app", "km_core.py");
}

function createWindow() {
  const win = new BrowserWindow({
    show: false,
    width: 1500,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    title: "KM Plotter",
    autoHideMenuBar: true,
    backgroundColor: "#DDDDE5",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once("ready-to-show", () => { win.maximize(); win.show(); });

  if (isDev) {
    win.loadURL("http://localhost:5173");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

// ---- IPC: dialogs ----

ipcMain.handle("dialog:pickFile", async (_evt, { title, filters }) => {
  // End-to-end test hook: KM_E2E_PICK_FILES points at a JSON file holding an
  // array of paths that the picker returns in order, so the UI can be driven
  // without native dialogs.
  if (process.env.KM_E2E_PICK_FILES) {
    try {
      const raw = fs.readFileSync(process.env.KM_E2E_PICK_FILES, "utf8");
      const queue = JSON.parse(raw);
      if (queue.length) {
        const p = queue.shift();
        fs.writeFileSync(process.env.KM_E2E_PICK_FILES, JSON.stringify(queue), "utf8");
        return { path: p, name: path.basename(p) };
      }
    } catch (e) {
      console.error("KM_E2E_PICK_FILES failed:", e.message);
    }
    return null;
  }
  const result = await dialog.showOpenDialog({
    title: title || "Select file",
    properties: ["openFile"],
    filters: filters || [{ name: "Text/TSV", extensions: ["txt", "tsv", "tab", "csv"] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  return { path: filePath, name: path.basename(filePath) };
});

ipcMain.handle("dialog:saveFile", async (_evt, { title, defaultName, filters }) => {
  if (process.env.KM_E2E_SAVE_DIRECTORY) {
    return path.join(process.env.KM_E2E_SAVE_DIRECTORY, path.basename(defaultName));
  }
  // End-to-end test hook: write to this path instead of showing a dialog.
  if (process.env.KM_E2E_SAVE_PATH) {
    return process.env.KM_E2E_SAVE_PATH;
  }
  const result = await dialog.showSaveDialog({
    title: title || "Save file",
    defaultPath: defaultName || "output",
    filters: filters || [{ name: "All files", extensions: ["*"] }],
  });
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
});

// ---- IPC: run the Python analysis core ----

let analysisWorker = null;
ipcMain.handle("km:run", async (_evt, job) => {
  if (!fs.existsSync(coreScriptPath())) return { ok: false, error: "The bundled analysis core is missing." };
  if (!analysisWorker) analysisWorker = createPythonWorker(pythonExePath(), coreScriptPath());
  return analysisWorker.run(job);
});
app.on("before-quit", () => { analysisWorker?.stop(); analysisWorker = null; });

// ---- IPC: write bytes to a chosen path ----

ipcMain.handle("file:writeBytes", async (_evt, { filePath, base64 }) => {
  if (!filePath) return false;
  try {
    fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
    return true;
  } catch (err) {
    console.error("file:writeBytes failed:", err);
    return false;
  }
});

// ---- IPC: reveal a file in Explorer ----

ipcMain.handle("shell:showItem", async (_evt, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return false;
  shell.showItemInFolder(filePath);
  return true;
});

ipcMain.handle("app:info", async () => ({
  version: app.getVersion(),
  platform: process.platform,
  python: pythonExePath(),
  core: coreScriptPath(),
  workerPid: analysisWorker?.pid ?? null,
  windowMaximized: BrowserWindow.getAllWindows()[0]?.isMaximized() ?? false,
}));

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // End-to-end test mode: drive the real IPC handlers and report the result.
  if (process.env.KM_E2E_TEST === "1") {
    const { runE2E } = require("./e2e.js");
    setTimeout(runE2E, 800);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
