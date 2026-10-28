// Preload — exposes a tiny, typed surface to the renderer.
// The renderer cannot reach Node.js directly (contextIsolation: true).

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getVersion: () => ipcRenderer.invoke("app:getVersion"),
  loadText: async () => {
    const file = await ipcRenderer.invoke("dialog:openText");
    return file ? ipcRenderer.invoke("file:readText", file) : null;
  },
  fetchUnivec: options => ipcRenderer.invoke("univec:fetch", options),
  // Compatibility with the spelling used in the v1.2.0 feature specification.
  fetchUnivic: options => ipcRenderer.invoke("univec:fetch", options),
  onUnivecProgress: callback => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("univec:progress", listener);
    return () => ipcRenderer.removeListener("univec:progress", listener);
  },
  // Get a save path from the user (returns null on cancel).
  pickSavePath: (defaultName) => ipcRenderer.invoke("dialog:saveResults", defaultName),

  // Write the workbook bytes to the chosen path.
  writeXlsx: (filePath, bytes) =>
    ipcRenderer.invoke("file:writeXlsx", { filePath, bytes }),

  // Convenience: combine the two steps above.
  // Returns the path on success, null on cancel, false on write failure.
  saveResultsXlsx: async (defaultName, bytes) => {
    const filePath = await ipcRenderer.invoke("dialog:saveResults", defaultName);
    if (!filePath) return null;
    const ok = await ipcRenderer.invoke("file:writeXlsx", { filePath, bytes });
    return ok ? filePath : false;
  },
});
