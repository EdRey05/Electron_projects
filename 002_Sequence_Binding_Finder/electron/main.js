// Electron main process.
//
// Production: loads dist/index.html via file://.
// Development: expects Vite dev server at http://localhost:5173.

const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs/promises");

const isDev = !app.isPackaged && process.env.NODE_ENV !== "production";

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    title: "Sequence Binding Finder",
    autoHideMenuBar: true,
    backgroundColor: "#F5F7F6",
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
  const result = await dialog.showSaveDialog({
    title: "Save binding results",
    defaultPath: defaultName || "binding_results.xlsx",
    filters: [
      { name: "Excel", extensions: ["xlsx"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  return result.canceled ? null : result.filePath;
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
