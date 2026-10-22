import { app, BrowserWindow } from "electron";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import { registerIpcHandlers } from "./ipc";

// Resolve beside the outer EXE, not the self-extractor's temporary resources.
if (app.isPackaged) {
  const base = process.env.PORTABLE_EXECUTABLE_DIR || dirname(app.getPath("exe"));
  const data = join(base, "data");
  mkdirSync(data, { recursive: true });
  app.setPath("userData", data);
  app.setAppLogsPath(join(base, "logs"));
}

const isDev = !app.isPackaged;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "FileSync",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev && process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
