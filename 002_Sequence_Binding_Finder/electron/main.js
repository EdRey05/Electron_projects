// Electron main process.
//
// Production: loads dist/index.html via file://.
// Development: expects Vite dev server at http://localhost:5173.

const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs/promises");
const { createUnivecService } = require("./univec.cjs");
let univec;
const readableFiles = new Set();

const runtime = require(app.isPackaged
  ? path.join(process.resourcesPath, 'build-common', 'runtime.cjs')
  : path.join(__dirname, '..', '..', 'build-tools', 'runtime.cjs'));
runtime.configure(app);

const isDev = !app.isPackaged && process.env.NODE_ENV !== "production";

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    title: "Sequence Binding Finder",
    autoHideMenuBar: true,
    backgroundColor: "#C9DDD2",
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

// Two-step save-results flow:
//   1) renderer asks for a path via "dialog:saveResults"
//   2) renderer asks main to write bytes to that path via "file:writeXlsx"
ipcMain.handle("dialog:saveResults", async (_evt, defaultName) => {
  const csv = String(defaultName || "").endsWith(".csv");
  const result = await dialog.showSaveDialog({
    title: "Save binding results",
    defaultPath: defaultName || "binding_results.xlsx",
    filters: [
      { name: csv ? "CSV" : "Excel", extensions: [csv ? "csv" : "xlsx"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  return result.canceled ? null : result.filePath;
});

ipcMain.handle("dialog:openText", async () => {
  const result = await dialog.showOpenDialog({ title: "Load one sequence", properties: ["openFile"], filters: [{ name: "Sequence text", extensions: ["fasta", "fa", "fna", "txt"] }] });
  if (result.canceled) return null;
  const file = result.filePaths[0]; readableFiles.add(file); return file;
});
ipcMain.handle("file:readText", async (_event, file) => {
  if (!readableFiles.has(file)) throw Error("Select the sequence file first.");
  return { name: path.basename(file), text: await fs.readFile(file, "utf8") };
});
ipcMain.handle("app:getVersion", () => {
  let buildDate = "development";
  try { buildDate = require("./build-info.json").date; } catch {}
  return { version: app.getVersion(), buildDate };
});
ipcMain.handle("univec:fetch", async (event, { which, force = false, requestId }) => {
  univec ||= createUnivecService(path.join(app.getPath("userData"), "univec_cache"));
  return univec.fetch({ which, force, onProgress: progress => { if (!event.sender.isDestroyed()) event.sender.send("univec:progress", { ...progress, which, requestId }); } });
});

ipcMain.handle("file:writeXlsx", async (_evt, { filePath, bytes }) => {
  if (!filePath) return false;
  try {
    // bytes arrive as a Uint8Array via Electron's structured-clone IPC.
    const buf = Buffer.from(bytes);
    await fs.writeFile(filePath, buf);
    return true;
  } catch (err) {
    console.error("file:writeXlsx failed:", err);
    return false;
  }
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
