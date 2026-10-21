/**
 * Screenshot the hub shell and a subapp for visual review.
 *
 * Run:  node_modules/.bin/electron.cmd scripts/screenshot-ui.js
 * Writes: ../../../gsh-hub-shell.png  and  ../../../gsh-subapp.png
 *   (relative to this file: the Desktop/Github_EdRey05 root)
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "..", "..", "..", "..", "..");

const APPS = [
  { name: "Ligation Layout", category: "react_route", path: "subapps/LigationLayout", entry: "LigationLayout.jsx", icon: "🧬", version: "3.2", date_released: "2026-10-10", status: "success", message: "Fills empty layout template with ordered fragments and digested vectors. React port.", requires: "Job_Log, Fragments_Log", pass_dir_as_kwarg: "Job_Log:job_log_path; Fragments_Log:fragments_log_path" },
  { name: "Colony PCR Layout", category: "react_route", path: "subapps/ColonyPCRLayout", entry: "ColonyPCRLayout.jsx", icon: "🧫", version: "1.5", date_released: "2026-10-13", status: "success", message: "Generates Colony PCR layout from Ligation Layouts and the Primer Log.", requires: "", pass_dir_as_kwarg: "Primer_Log:primer_log_path" },
  { name: "Primer Finder", category: "react_route", path: "subapps/PrimerFinder", entry: "PrimerFinder.jsx", icon: "🔬", version: "1.1", date_released: "2026-10-10", status: "success", message: "Finds primers that bind to a target sequence. React port — runs in-process, no Python.", requires: "", pass_dir_as_kwarg: "Primer_Log:primer_log_path" },
  { name: "Sequencing Reference Files", category: "react_route", path: "subapps/SequencingReferenceFiles", entry: "SequencingReferenceFiles.jsx", icon: "🧬", version: "1.2", date_released: "2026-10-13", status: "success", message: "Extracts Insert and Final Vector sequences from the Primer Log and exports as .txt files.", requires: "", pass_dir_as_kwarg: "Primer_Log:primer_log_path; Reference_Sequences:reference_files_path" },
  { name: "Sequencing Order Form", category: "react_route", path: "subapps/SequencingOrderForm", entry: "SequencingOrderForm.jsx", icon: "📝", version: "4.5", date_released: "2026-10-15", status: "success", message: "Fills empty order form as specified in the sequencing validation file.", requires: "", pass_dir_as_kwarg: "Primer_Log:primer_log_path" },
  { name: "Sequencing File Organizer", category: "react_route", path: "subapps/SequencingFileOrganizer", entry: "SequencingFileOrganizer.jsx", icon: "📑", version: "4.2", date_released: "2026-10-13", status: "success", message: "Organizes .ab1 and .fasta files by Work No. Distributes reference files.", requires: "", pass_dir_as_kwarg: "Reference_Sequences:reference_sequences_path; Sorted_Sequencing_Files:sorted_sequencing_files_path" },
  { name: "QC Vector Map Prep", category: "react_route", path: "subapps/QCVectorMap", entry: "QCVectorMap.jsx", icon: "🧪", version: "2.0", date_released: "2026-08-23", status: "success", message: "Generates GenBank (.gb) files annotated with the insert sequence.", requires: "", pass_dir_as_kwarg: "Primer_Log:primer_log_path" },
  { name: "QC File Prep", category: "tkinter_import", path: "Code/QC_file_prep", entry: "QC_file_prep_app.py", class_name: "QCFilePrepApp", icon: "📁", version: "2.4", date_released: "2026-10-13", status: "success", message: "Fixes zip QC files received from Sg.", requires: "", pass_dir_as_kwarg: "QC_Output_Folder:output_folder; Job_Log:job_log_path" },
  { name: "BATCH QC Report", category: "tkinter_import", path: "Code/BATCH_QC_report", entry: "batch_qc_report_app.py", class_name: "BatchQCReportApp", icon: "📊", version: "1.1", date_released: "2026-10-10", status: "success", message: "Generates QC report from BATCH QC zip files: BBI ID, Plasmid No., sequences, OD values.", requires: "" },
  { name: "Integra Worklist", category: "streamlit", path: "Code/Integra_worklist", entry: "integra_worklist_app.py", icon: "🔬", version: "4.3", date_released: "2026-10-10", status: "success", message: "Create worklists for Integra ASSIST liquid handler.", requires: "" },
  { name: "QC Digestion Design", category: "tkinter_import", path: "Code/QC_digestion_design", entry: "QC_digestion_design_app.py", class_name: "QCDesignApp", icon: "✂", version: "1.4", date_released: "2026-10-13", status: "success", message: "Prepares vector + insert maps. More functions to be added later.", requires: "", pass_dir_as_kwarg: "Primer_Log:primer_log_path" },
  { name: "Label Generator", category: "tkinter_import", path: "Code/Label_generator", entry: "label_generator_app.py", class_name: "LabelGeneratorApp", icon: "🏷️", version: "1.1", date_released: "2026-10-13", status: "success", message: "Parses Sg shipping lists into Shipping_labels-format rows for the label printer.", requires: "" },
];

const PATHS = {
  Primer_Log: { raw: 'B8. Gene Synthesis, "B8. Gene Synthesis\\3.0 In-House Gene\\3.5 Job Log\\3.5.0 Primer\\Primer Log v3.xlsx"', resolved: "E:\\B8. Gene Synthesis\\3.0 In-House Gene\\3.5 Job Log\\3.5.0 Primer\\Primer Log v3.xlsx", exists: false },
  Job_Log: { raw: 'B8. Gene Synthesis, "B8. Gene Synthesis\\3.0 In-House Gene\\3.5 Job Log\\3.5 In-house Progress v12.xlsx"', resolved: "E:\\B8. Gene Synthesis\\3.0 In-House Gene\\3.5 Job Log\\3.5 In-house Progress v12.xlsx", exists: false },
  Sorted_Sequencing_Files: { raw: 'B8. Gene Synthesis, "B8. Gene Synthesis\\3.0 In-House Gene\\3.6 QC\\3.6.2 Sorted sequencing"', resolved: "E:\\B8. Gene Synthesis\\3.0 In-House Gene\\3.6 QC\\3.6.2 Sorted sequencing", exists: true },
  Reference_Sequences: { raw: 'B8. Gene Synthesis, "B8. Gene Synthesis\\3.0 In-House Gene\\3.6 QC\\3.6.0 Reference files"', resolved: "E:\\B8. Gene Synthesis\\3.0 In-House Gene\\3.6 QC\\3.6.0 Reference files", exists: true },
  QC_Output_Folder: { raw: 'B8. Gene Synthesis, "B8. Gene Synthesis\\3.0 In-House Gene\\3.6 QC\\3.6.5 QC files received"', resolved: "E:\\B8. Gene Synthesis\\3.0 In-House Gene\\3.6 QC\\3.6.5 QC files received", exists: true },
  QC_Gel_Ladder: { raw: 'B8. Gene Synthesis, "B8. Gene Synthesis\\3.0 In-House Gene\\3.6 QC\\3.6.7 QC gel images\\Ladder.jpg"', resolved: "E:\\B8. Gene Synthesis\\3.0 In-House Gene\\3.6 QC\\3.6.7 QC gel images\\Ladder.jpg", exists: true },
};

function registerStubs() {
  ipcMain.handle("hub:scanDrives", async () => ({
    "B8. Gene Synthesis": "E:",
    "B6. DNA Sequencing": "F:",
    Public: "G:",
  }));
  ipcMain.handle("hub:getLayout", async () => ({
    isPackaged: false,
    pythonAppRoot: path.join(ROOT, "python-app"),
    venvPythonExe: path.join(ROOT, "python-app", "runtime-venv", "Scripts", "python.exe"),
  }));
  ipcMain.handle("hub:loadConfig", async () => ({
    paths: PATHS,
    missing: ["Primer_Log", "Job_Log"],
    apps: APPS,
  }));
  for (const ch of [
    "hub:browsePath", "hub:revealPath", "hub:openPythonApp", "hub:launchApp",
    "hub:saveResultsCsv", "hub:saveResultsXlsx", "hub:chooseOutputDir",
    "hub:writeTextFile", "hub:writeBinaryFile", "hub:copyFile", "hub:listDirectory",
    "hub:moveFile", "hub:deleteFile", "hub:createDirectory", "hub:readBinaryFile",
    "hub:chooseFile", "hub:saveConfig", "hub:resolveBundledFiles",
  ]) {
    ipcMain.handle(ch, async () => (ch === "hub:listDirectory" ? { ok: true, entries: [] } : { ok: true }));
  }
}

app.whenReady().then(async () => {
  registerStubs();
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, "electron", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  await win.loadFile(path.join(ROOT, "dist", "index.html"));
  await new Promise((r) => setTimeout(r, 3500));

  const shellPath = path.join(OUT_DIR, "gsh-hub-shell.png");
  const img1 = await win.webContents.capturePage();
  fs.writeFileSync(shellPath, img1.toPNG());
  console.log("wrote", shellPath);

  // Open a subapp and capture it.
  await win.webContents.executeJavaScript(`
    (() => {
      const btns = [...document.querySelectorAll("button")];
      const enabled = btns.filter((x) => x.textContent.trim() === "Launch" && !x.disabled);
      if (enabled.length) enabled[0].click();
      return !!enabled.length;
    })()
  `);
  await new Promise((r) => setTimeout(r, 1500));
  const subPath = path.join(OUT_DIR, "gsh-subapp.png");
  const img2 = await win.webContents.capturePage();
  fs.writeFileSync(subPath, img2.toPNG());
  console.log("wrote", subPath);

  app.exit(0);
});

setTimeout(() => app.exit(1), 45000);
