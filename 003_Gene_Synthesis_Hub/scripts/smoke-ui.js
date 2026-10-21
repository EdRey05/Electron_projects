/**
 * Headless UI smoke test for the Gene Synthesis Hub Electron app.
 *
 * Boots Electron with the app's real preload bridge, stubs the IPC handlers
 * with representative data (12 apps, 3 drives, 2 unresolved paths), loads the
 * BUILT renderer from dist/, and probes the live DOM.
 *
 * It proves the app actually renders — not just that the bundle compiles:
 *   - the React tree mounts
 *   - the paper background + IBM Plex Sans are applied
 *   - the 12 apps are listed, grouped by stage
 *   - the drive strip shows the mapped labels
 *   - the unresolved-path pill appears
 *   - a React subapp opens and shows its own header + back button
 *
 * Run:  node_modules/.bin/electron.cmd scripts/smoke-ui.js
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

const ROOT = path.join(__dirname, "..");

const APPS = [
  { name: "Ligation Layout", category: "react_route", path: "subapps/LigationLayout", entry: "LigationLayout.jsx", icon: "D", version: "3.2", date_released: "2026-10-10", status: "success", message: "Fills empty layout template with ordered fragments and digested vectors.", requires: "Job_Log, Fragments_Log", pass_dir_as_kwarg: "Job_Log:job_log_path; Fragments_Log:fragments_log_path" },
  { name: "Colony PCR Layout", category: "react_route", path: "subapps/ColonyPCRLayout", entry: "ColonyPCRLayout.jsx", icon: "C", version: "1.5", date_released: "2026-10-13", status: "success", message: "Generates Colony PCR layout from Ligation Layouts and the Primer Log.", requires: "", pass_dir_as_kwarg: "Primer_Log:primer_log_path" },
  { name: "Primer Finder", category: "react_route", path: "subapps/PrimerFinder", entry: "PrimerFinder.jsx", icon: "P", version: "1.1", date_released: "2026-10-10", status: "success", message: "Finds primers that bind to a target sequence.", requires: "", pass_dir_as_kwarg: "Primer_Log:primer_log_path" },
  { name: "Sequencing Reference Files", category: "react_route", path: "subapps/SequencingReferenceFiles", entry: "SequencingReferenceFiles.jsx", icon: "R", version: "1.2", date_released: "2026-10-13", status: "success", message: "Extracts Insert and Final Vector sequences.", requires: "", pass_dir_as_kwarg: "Primer_Log:primer_log_path; Reference_Sequences:reference_files_path" },
  { name: "Sequencing Order Form", category: "react_route", path: "subapps/SequencingOrderForm", entry: "SequencingOrderForm.jsx", icon: "O", version: "4.5", date_released: "2026-10-15", status: "success", message: "Fills empty order form from validation data.", requires: "", pass_dir_as_kwarg: "Primer_Log:primer_log_path" },
  { name: "Sequencing File Organizer", category: "react_route", path: "subapps/SequencingFileOrganizer", entry: "SequencingFileOrganizer.jsx", icon: "F", version: "4.2", date_released: "2026-10-13", status: "success", message: "Organizes .ab1 and .fasta files by Work No.", requires: "", pass_dir_as_kwarg: "Reference_Sequences:reference_sequences_path; Sorted_Sequencing_Files:sorted_sequencing_files_path" },
  { name: "QC Vector Map Prep", category: "react_route", path: "subapps/QCVectorMap", entry: "QCVectorMap.jsx", icon: "V", version: "2.0", date_released: "2026-08-23", status: "success", message: "Generates GenBank (.gb) files annotated with the insert sequence.", requires: "", pass_dir_as_kwarg: "Primer_Log:primer_log_path" },
  { name: "QC File Prep", category: "tkinter_import", path: "Code/QC_file_prep", entry: "QC_file_prep_app.py", class_name: "QCFilePrepApp", icon: "Q", version: "2.4", date_released: "2026-10-13", status: "success", message: "Fixes zip QC files received from Sg.", requires: "", pass_dir_as_kwarg: "QC_Output_Folder:output_folder; Job_Log:job_log_path" },
  { name: "BATCH QC Report", category: "tkinter_import", path: "Code/BATCH_QC_report", entry: "batch_qc_report_app.py", class_name: "BatchQCReportApp", icon: "B", version: "1.1", date_released: "2026-10-10", status: "success", message: "Generates QC report from BATCH QC zip files.", requires: "" },
  { name: "Integra Worklist", category: "streamlit", path: "Code/Integra_worklist", entry: "integra_worklist_app.py", icon: "I", version: "4.3", date_released: "2026-10-10", status: "success", message: "Create worklists for Integra ASSIST liquid handler.", requires: "" },
  { name: "QC Digestion Design", category: "tkinter_import", path: "Code/QC_digestion_design", entry: "QC_digestion_design_app.py", class_name: "QCDesignApp", icon: "D", version: "1.4", date_released: "2026-10-13", status: "success", message: "Prepares vector + insert maps.", requires: "", pass_dir_as_kwarg: "Primer_Log:primer_log_path" },
  { name: "Label Generator", category: "tkinter_import", path: "Code/Label_generator", entry: "label_generator_app.py", class_name: "LabelGeneratorApp", icon: "L", version: "1.1", date_released: "2026-10-13", status: "success", message: "Parses Sg shipping lists into label rows.", requires: "" },
];

const PATHS = {
  Primer_Log: { raw: 'B8. Gene Synthesis, "B8. Gene Synthesis\\3.0\\Primer Log v3.xlsx"', resolved: "E:\\B8. Gene Synthesis\\3.0\\Primer Log v3.xlsx", exists: false },
  Job_Log: { raw: 'B8. Gene Synthesis, "B8. Gene Synthesis\\3.5 Job Log\\3.5 In-house Progress v12.xlsx"', resolved: "E:\\B8. Gene Synthesis\\3.5 Job Log\\3.5 In-house Progress v12.xlsx", exists: false },
  Sorted_Sequencing_Files: { raw: 'B8. Gene Synthesis, "B8. Gene Synthesis\\3.6 QC\\3.6.2 Sorted sequencing"', resolved: "E:\\B8. Gene Synthesis\\3.6 QC\\3.6.2 Sorted sequencing", exists: true },
  Reference_Sequences: { raw: 'B8. Gene Synthesis, "B8. Gene Synthesis\\3.6 QC\\3.6.0 Reference files"', resolved: "E:\\B8. Gene Synthesis\\3.6 QC\\3.6.0 Reference files", exists: true },
  QC_Output_Folder: { raw: 'B8. Gene Synthesis, "B8. Gene Synthesis\\3.6 QC\\3.6.5 QC files received"', resolved: "E:\\B8. Gene Synthesis\\3.6 QC\\3.6.5 QC files received", exists: true },
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
  ipcMain.handle("hub:browsePath", async () => null);
  ipcMain.handle("hub:revealPath", async () => true);
  ipcMain.handle("hub:openPythonApp", async () => "");
  ipcMain.handle("hub:launchApp", async () => ({ ok: true, pid: 1 }));
  ipcMain.handle("hub:saveResultsCsv", async () => true);
  ipcMain.handle("hub:saveResultsXlsx", async () => "C:/tmp/out.xlsx");
  ipcMain.handle("hub:chooseOutputDir", async () => null);
  ipcMain.handle("hub:writeTextFile", async () => ({ ok: true }));
  ipcMain.handle("hub:writeBinaryFile", async () => ({ ok: true }));
  ipcMain.handle("hub:copyFile", async () => ({ ok: true }));
  ipcMain.handle("hub:listDirectory", async () => ({ ok: true, entries: [] }));
  ipcMain.handle("hub:moveFile", async () => ({ ok: true }));
  ipcMain.handle("hub:deleteFile", async () => ({ ok: true }));
  ipcMain.handle("hub:createDirectory", async () => ({ ok: true }));
  ipcMain.handle("hub:readBinaryFile", async () => ({ ok: false, error: "not found" }));
  ipcMain.handle("hub:chooseFile", async () => null);
  ipcMain.handle("hub:saveConfig", async () => ({ ok: true }));
  ipcMain.handle("hub:resolveBundledFiles", async () => ({ templates: {}, databases: {} }));
}

let failures = 0;
const check = (name, cond, detail = "") => {
  if (!cond) failures++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
};

const errors = [];

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
  win.webContents.on("console-message", (_e, level, message) => {
    // The Google Fonts CDN is blocked by the app's own CSP — expected
    // offline; the font stack falls back to the system sans.
    if (level >= 2 && !message.includes("fonts.googleapis.com")) {
      errors.push(`[${level}] ${message}`);
    }
  });

  await win.loadFile(path.join(ROOT, "dist", "index.html"));
  await new Promise((r) => setTimeout(r, 3500));

  console.log("=== HUB SHELL ===");
  const probe = await win.webContents.executeJavaScript(`
    (() => {
      const t = document.body.innerText || "";
      // The stage labels are CSS-uppercased, so innerText returns them
      // uppercased — compare case-insensitively.
      const lower = t.toLowerCase();
      const groups = ["Pre-Cloning", "Cloning", "QC & Reporting", "Utilities"];
      const names = ${JSON.stringify(APPS.map((a) => a.name))};
      return {
        mounted: !!(document.getElementById("root") || {}).children?.length,
        h1: (document.querySelector("h1") || {}).textContent || "",
        groups: groups.filter((g) => lower.includes(g.toLowerCase())),
        appsShown: names.filter((n) => t.includes(n)),
        appsMissing: names.filter((n) => !t.includes(n)),
        drivesStrip: t.includes("B8. Gene Synthesis") && t.includes("B6. DNA Sequencing"),
        unresolvedPill: t.includes("unresolved"),
        bodyBg: getComputedStyle(document.body).backgroundColor,
        fontFamily: getComputedStyle(document.body).fontFamily,
        buttonCount: document.querySelectorAll("button").length,
        // Group headings are the uppercase-tracked <h3> elements.
        groupHeadings: [...document.querySelectorAll("h3")].map((h) => h.textContent),
      };
    })()
  `);
  console.log(JSON.stringify(probe, null, 2));

  console.log("\n--- checks ---");
  check("React tree mounted", probe.mounted);
  check("hub title rendered", probe.h1 === "Gene Synthesis Hub", probe.h1);
  check("all 4 stage groups present", probe.groups.length === 4, probe.groups.join(", "));
  check("all 12 apps listed", probe.appsShown.length === 12, `${probe.appsShown.length}/12`);
  check("no app missing", probe.appsMissing.length === 0, probe.appsMissing.join(", "));
  check("drive strip shows mapped drives", probe.drivesStrip);
  check("unresolved-path pill shown", probe.unresolvedPill);
  check("paper background applied", probe.bodyBg === "rgb(245, 247, 246)", probe.bodyBg);
  check("IBM Plex Sans applied", probe.fontFamily.includes("IBM Plex Sans"), probe.fontFamily);

  // Open a React subapp via its Launch button. The first app in the grid
  // (Ligation Layout) requires Job_Log, which is unresolved in this fixture,
  // so its Launch button is disabled — pick an ENABLED one instead.
  console.log("\n=== REACT SUBAPP ===");
  const clicked = await win.webContents.executeJavaScript(`
    (() => {
      const btns = [...document.querySelectorAll("button")];
      const enabled = btns.filter((x) => x.textContent.trim() === "Launch" && !x.disabled);
      if (!enabled.length) return null;
      enabled[0].click();
      return enabled[0].closest("div")?.parentElement?.innerText?.split("\\n").slice(0, 2).join(" | ") || "clicked";
    })()
  `);
  console.log("clicked Launch on:", clicked);
  check("an enabled Launch button existed", !!clicked, String(clicked));
  await new Promise((r) => setTimeout(r, 1500));
  const sub = await win.webContents.executeJavaScript(`
    (() => {
      const t = document.body.innerText || "";
      return {
        h1: (document.querySelector("h1") || {}).textContent || "",
        hasBack: t.includes("Hub"),
        hasLog: t.includes("Log"),
        chars: t.length,
        bg: getComputedStyle(document.body).backgroundColor,
        h1s: [...document.querySelectorAll("h1")].map((h) => h.textContent),
      };
    })()
  `);
  console.log(JSON.stringify(sub, null, 2));
  check("subapp header replaced the hub header", sub.h1.length > 0 && sub.h1 !== "Gene Synthesis Hub", sub.h1);
  check("subapp has a back-to-hub button", sub.hasBack);
  check("subapp shows the log panel", sub.hasLog);
  check("subapp kept the paper background", sub.bg === "rgb(245, 247, 246)", sub.bg);

  console.log("\n--- console errors ---");
  if (errors.length) {
    for (const e of errors) console.log("  " + e);
    check("no unexpected console errors", false, `${errors.length} error(s)`);
  } else {
    check("no unexpected console errors", true);
  }

  console.log("\n=== RESULT:", failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`, "===");
  app.exit(failures === 0 ? 0 : 1);
});

setTimeout(() => {
  console.log("TIMEOUT");
  app.exit(1);
}, 60000);
