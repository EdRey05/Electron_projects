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
const os = require("os");
const { spawn } = require("child_process");

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
    width: 1500,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    title: "KM Plotter",
    autoHideMenuBar: true,
    backgroundColor: "#0F1115",
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

ipcMain.handle("km:run", async (_evt, job) => {
  const py = pythonExePath();
  const script = coreScriptPath();

  if (!fs.existsSync(script)) {
    return { ok: false, error: `km_core.py not found at ${script}. Run npm run stage-python.` };
  }

  // Write the job to a temp file and hand its path to Python; this avoids
  // shell-quoting issues with paths containing spaces or unicode.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "km-"));
  const jobPath = path.join(tmpDir, "job.json");
  const outPath = path.join(tmpDir, "out.json");

  try {
    fs.writeFileSync(jobPath, JSON.stringify(job), "utf8");

    return await new Promise((resolve) => {
      const child = spawn(py, [script, jobPath, "--out", outPath], {
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      });
      let stderr = "";
      child.stderr.on("data", (c) => {
        stderr += c.toString();
      });
      child.on("error", (err) => {
        resolve({ ok: false, error: `Could not start Python: ${err.message}` });
      });
      child.on("close", () => {
        try {
          const raw = fs.readFileSync(outPath, "utf8");
          resolve(JSON.parse(raw));
        } catch (err) {
          resolve({
            ok: false,
            error: stderr.trim() || `The analysis did not return a result (${err.message}).`,
            detail: stderr,
          });
        }
      });
    });
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

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
