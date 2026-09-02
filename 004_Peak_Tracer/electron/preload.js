// Preload — exposes a typed surface to the renderer.
// The renderer cannot reach Node.js directly (contextIsolation: true).

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // Folder pickers (return null on cancel).
  pickInputFolder: () => ipcRenderer.invoke("dialog:pickInputFolder"),
  pickOutputFolder: (defaultPath) => ipcRenderer.invoke("dialog:pickOutputFolder", defaultPath),

  // Enumerate .ab1 files in a folder.
  listAb1: (folder) => ipcRenderer.invoke("fs:listAb1", folder),

  // Run a batch through the bundled python-app.
  runBatch: (params) => ipcRenderer.invoke("peaktrace:runBatch", params),

  // Subscribe to streaming events from main.
  onProgress: (handler) => {
    const listener = (_evt, payload) => handler(payload);
    ipcRenderer.on("peaktrace:progress", listener);
    return () => ipcRenderer.removeListener("peaktrace:progress", listener);
  },
  onLog: (handler) => {
    const listener = (_evt, payload) => handler(payload);
    ipcRenderer.on("peaktrace:log", listener);
    return () => ipcRenderer.removeListener("peaktrace:log", listener);
  },
  onDone: (handler) => {
    const listener = (_evt, payload) => handler(payload);
    ipcRenderer.on("peaktrace:done", listener);
    return () => ipcRenderer.removeListener("peaktrace:done", listener);
  },

  // Convenience: reveal folder in Explorer.
  openFolder: (folder) => ipcRenderer.invoke("shell:openFolder", folder),
});
