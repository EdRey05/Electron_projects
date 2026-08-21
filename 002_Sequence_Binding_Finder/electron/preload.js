// Preload — exposes a tiny, typed surface to the renderer.
// The renderer cannot reach Node.js directly (contextIsolation: true).

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
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
