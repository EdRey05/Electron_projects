// Electron main process for Peak Tracer.
//
// Production: loads dist/index.html via file://.
// Development: expects Vite dev server at http://localhost:5173.
//
// Responsibilities:
//   - Folder/file picker dialogs (input raw/, output parent).
//   - Enumerate .ab1 files in the input folder.
//   - Spawn the bundled python-app/peaktrace_core.py CLI per file.
//   - Stream progress + per-file results back to the renderer via IPC events.

const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const isDev = !app.isPackaged && process.env.NODE_ENV !== "production";

// ---- bundled python location (matches 003_Gene_Synthesis_Hub pattern) ----
function pythonExePath() {
  // Production: python-app/runtime/Scripts/python.exe (Windows)
  if (app.isPackaged) {
    const venvPy = path.join(process.resourcesPath, "python-app", "runtime", "Scripts", "python.exe");
    if (fs.existsSync(venvPy)) return venvPy;
    const sysPy = path.join(process.resourcesPath, "python-app", "runtime", "python.exe");
    if (fs.existsSync(sysPy)) return sysPy;
  }
  // Development: <repo>/004_Peak_Tracer/python-app/runtime/Scripts/python.exe
  const devVenv = path.join(__dirname, "..", "python-app", "runtime", "Scripts", "python.exe");
  if (fs.existsSync(devVenv)) return devVenv;
  // Fall back to whatever's on PATH
  return "python";
}

function peaktraceScriptPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "python-app", "peaktrace_core.py");
  }
  return path.join(__dirname, "..", "python-app", "peaktrace_core.py");
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    title: "Peak Tracer",
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

// ---- IPC: dialogs ----

ipcMain.handle("dialog:pickInputFolder", async () => {
  const result = await dialog.showOpenDialog({
    title: "Pick folder containing .ab1 files",
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle("dialog:pickOutputFolder", async (_evt, defaultPath) => {
  const result = await dialog.showOpenDialog({
    title: "Pick output folder",
    defaultPath: defaultPath || undefined,
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// ---- IPC: enumerate .ab1 files in a folder (non-recursive — matches BBI workflow) ----

ipcMain.handle("fs:listAb1", async (_evt, folder) => {
  if (!folder) return [];
  try {
    const entries = fs.readdirSync(folder, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".ab1"))
      .map((e) => ({
        name: e.name,
        path: path.join(folder, e.name),
        sizeBytes: fs.statSync(path.join(folder, e.name)).size,
      }));
  } catch (err) {
    console.error("fs:listAb1 failed:", err);
    return [];
  }
});

// ---- IPC: run peaktrace_core on a batch ----

ipcMain.handle("peaktrace:runBatch", async (event, { inputDir, outputDir, settings }) => {
  const py = pythonExePath();
  const script = peaktraceScriptPath();

  if (!fs.existsSync(script)) {
    return { ok: false, error: `peaktrace_core.py not found at ${script}. Run python-app setup.` };
  }

  // v1.3 CLI accepts only this flag set. The App.jsx UI exposes more controls
  // (mode, smoothing, baseline) that map to an aspirational full RP pipeline we
  // never built — they're silently ignored here. Settings we DO honor:
  const args = [
    script,
    "--input-dir", inputDir,
    "--output-dir", outputDir,
  ];
  if (settings.stripWellId !== false) args.push("--strip-well-id");
  else args.push("--no-strip-well-id");
  if (settings.emitSeq !== false) args.push("--emit-seq");
  else args.push("--no-emit-seq");
  if (settings.setAbiLimits !== false) args.push("--set-abi-limits");
  if (settings.skipShorterThan) args.push("--skip-shorter-than", String(settings.skipShorterThan));
  if (settings.filenameSuffix) args.push("--filename-suffix", settings.filenameSuffix);
  if (settings.leadDropEnabled !== false) args.push("--lead-drop-enabled");
  else args.push("--no-lead-drop");
  if (settings.leadDropQv != null) args.push("--lead-drop-qv", String(settings.leadDropQv));

  // v1.3: Re-basecall from raw channels (recovers late reads Seq7 dropped)
  if (settings.rebasecallData14) {
    args.push("--rebasecall-data14");
    args.push("--min-rebasecall-len", String(settings.minRebasecallLen ?? 1000));
    args.push("--extend-min-snr", String(settings.extendMinSnr ?? 1.3));
  }

  return new Promise((resolve) => {
    const child = spawn(py, args, { windowsHide: true });
    let stdoutBuf = "";
    let stderrBuf = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdoutBuf += text;
      // Stream progress: every line is one JSON object OR a plain status line.
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          event.sender.send("peaktrace:progress", obj);
        } catch {
          // non-JSON status line; send as log
          event.sender.send("peaktrace:log", { level: "info", message: line });
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrBuf += text;
      event.sender.send("peaktrace:log", { level: "error", message: text });
    });

    child.on("error", (err) => {
      event.sender.send("peaktrace:log", { level: "error", message: `spawn failed: ${err.message}` });
      resolve({ ok: false, error: err.message });
    });

    child.on("close", (code) => {
      event.sender.send("peaktrace:done", { code });
      resolve({ ok: code === 0, code, stderr: stderrBuf });
    });
  });
});

// ---- IPC: reveal output in Explorer (matches hub convenience) ----

ipcMain.handle("shell:openFolder", async (_evt, folder) => {
  if (!folder) return false;
  try {
    require("electron").shell.openPath(folder);
    return true;
  } catch (err) {
    console.error("shell:openFolder failed:", err);
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
