// Preload — exposes a tiny, typed surface to the renderer.
// The renderer cannot reach Node.js directly (contextIsolation: true).

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // Pick an input file. Returns { path, name } or null on cancel.
  pickFile: (opts) => ipcRenderer.invoke("dialog:pickFile", opts),

  // Ask for a save path. Returns the path or null on cancel.
  pickSavePath: (opts) => ipcRenderer.invoke("dialog:saveFile", opts),

  // Write base64-encoded bytes to a path.
  writeBytes: (filePath, base64) => ipcRenderer.invoke("file:writeBytes", { filePath, base64 }),

  // Run a job in the bundled Python analysis core.
  // job: { command: "inspect" | "analyze" | "export" | "column", ... }
  run: (job) => ipcRenderer.invoke("km:run", job),

  // Reveal a file in the OS file manager.
  showItem: (filePath) => ipcRenderer.invoke("shell:showItem", filePath),

  // App metadata (version, python path).
  info: () => ipcRenderer.invoke("app:info"),
});
