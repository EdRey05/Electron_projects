/**
 * Preload script — exposes a narrow `window.api` surface to the renderer.
 * No nodeIntegration, full context isolation: the renderer never sees
 * `require`, `process`, or the filesystem directly.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // Drive discovery (used at startup and on manual refresh).
  scanDrives: () => ipcRenderer.invoke("hub:scanDrives"),

  // Layout introspection (where are python-app, runtime, etc. — for the
  // status footer + debugging).
  getLayout: () => ipcRenderer.invoke("hub:getLayout"),

  // Config read/write.
  loadConfig: (driveMappings) => ipcRenderer.invoke("hub:loadConfig", { driveMappings }),
  saveConfig: (newValues, driveMappings) =>
    ipcRenderer.invoke("hub:saveConfig", { newValues, driveMappings }),

  // File dialogs.
  browsePath: (current, isFile) =>
    ipcRenderer.invoke("hub:browsePath", { current, isFile }),
  revealPath: (p) => ipcRenderer.invoke("hub:revealPath", p),
  openPythonApp: () => ipcRenderer.invoke("hub:openPythonApp"),

  // Launch a subapp.
  launchApp: (appDef, paths, driveMappings) =>
    ipcRenderer.invoke("hub:launchApp", { appDef, paths, driveMappings }),

  // Native save dialog for CSV/text results produced by a React subapp.
  // Returns true if written, false if cancelled.
  saveResultsCsv: (defaultName, bytes) =>
    ipcRenderer.invoke("hub:saveResultsCsv", { defaultName, bytes }),

  // Native save dialog for binary .xlsx (or any binary blob). Returns the
  // chosen path, null if cancelled, or { error } on failure.
  saveResultsXlsx: (defaultName, bytes) =>
    ipcRenderer.invoke("hub:saveResultsXlsx", { defaultName, bytes }),

  // Choose an output folder via the OS dialog.
  chooseOutputDir: (initial) => ipcRenderer.invoke("hub:chooseOutputDir", initial),

  // Write a text file to an absolute path (folder picker + save dialog
  // aren't always what a subapp needs; sometimes it just wants to drop
  // many files into a pre-chosen folder).
  writeTextFile: ({ filePath, text }) =>
    ipcRenderer.invoke("hub:writeTextFile", { filePath, text }),

  // Write a binary file (e.g. an emitted .xlsx workbook) to an absolute path.
  writeBinaryFile: ({ filePath, bytes }) =>
    ipcRenderer.invoke("hub:writeBinaryFile", { filePath, bytes }),

  // Copy a file (used to lay down template files alongside generated output).
  copyFile: ({ source, dest }) =>
    ipcRenderer.invoke("hub:copyFile", { source, dest }),

  // List files + subdirectories in a directory.
  // filter: "files" (default) | "dirs" | "all"
  // extension: optional ".txt" / ".ab1" etc. (files only, case-insensitive)
  listDirectory: ({ dirPath, filter, extension }) =>
    ipcRenderer.invoke("hub:listDirectory", { dirPath, filter, extension }),

  // Move a file (Tab 1 of Sequencing File Organizer).
  moveFile: ({ source, dest }) =>
    ipcRenderer.invoke("hub:moveFile", { source, dest }),

  // Delete a single file (Tab 1: .seq file cleanup).
  deleteFile: ({ filePath }) =>
    ipcRenderer.invoke("hub:deleteFile", { filePath }),

  // Create a directory (recursive, Tab 1: per-JobID folder creation).
  createDirectory: ({ dirPath }) =>
    ipcRenderer.invoke("hub:createDirectory", { dirPath }),

  // Read a binary file (returns ArrayBuffer). Used by Excel-template subapps.
  readBinaryFile: ({ filePath }) =>
    ipcRenderer.invoke("hub:readBinaryFile", { filePath }),

  // Native open-file dialog (returns path or null).
  chooseFile: ({ filter } = {}) =>
    ipcRenderer.invoke("hub:chooseFile", { filter }),
});
