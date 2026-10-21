import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  FolderOpen,
  Files,
  Copy,
  FileOutput,
  Play,
} from "lucide-react";
import {
  planOrganize,
  buildOrganizeIssues,
  buildOrganizeSummary,
} from "./organize.js";
import {
  findMissingReferences,
  findMissingFolders,
} from "./distribute.js";
import {
  planSgCheck,
  buildSgCheckIssues,
  buildSgCheckSummary,
  selectSgCheckFolders,
  suggestSgCheckFilename,
} from "./sgCheck.js";
import { setColumnA, resolveSheetPart, activeSheetName } from "../../ui/xlsxEdit.js";
import { unzipSync, zipSync } from "fflate";
import {
  C,
  AppHeader,
  Button,
  Panel,
  PathInput,
  Pill,
  StatusLine,
  LogPanel,
  Modal,
  Tabs,
  FONT_MONO,
} from "../../ui/kit.jsx";

/**
 * Sequencing File Organizer — React port of `sequencing_file_organizer_app.py`.
 *
 * Three tabs mirroring the original Tkinter UI:
 *   Tab 1: Organize Sequencing Files (scan -> move into per-Work-No. folders)
 *   Tab 2: Distribute Reference Files (scan -> copy .txt into Tab 1 folders)
 *   Tab 3: SG Check Document (scan -> write folder names into Excel template)
 *
 * File-system actions all go through Electron IPC handlers (no Node access
 * from the renderer). Each tab has its own picker for source/destination
 * folders and its own log.
 *
 * Behaviour parity notes (Python v4.2):
 *   - Tab 1's source is the "Sequencing Files Directory" (the sequencing
 *     OUTPUT folder). The "Reference Files Directory" belongs to Tab 2.
 *   - The pre-scan shows an Abort / Skip Issues / Process All modal BEFORE
 *     anything touches the filesystem. "Abort" leaves the disk untouched.
 *   - `.seq` files are deleted AFTER the modal, and the source directory is
 *     re-listed afterwards so the plan reflects the post-deletion state.
 *   - Tab 2 matches against the Work Nos Tab 1 organized in THIS session
 *     (`organizedWorkNos`), not against whatever happens to be on disk.
 */
export default function SequencingFileOrganizer({ onBack, initialPaths }) {
  const [tab, setTab] = useState(1); // 1, 2, or 3

  // Session state shared by the three tabs. Mirrors the Python's
  // `self.organized_work_nos` / `self.created_folder_names`, which Tab 1
  // fills in and Tabs 2 / 3 consume.
  const [organizedWorkNos, setOrganizedWorkNos] = useState([]);
  const [createdFolderNames, setCreatedFolderNames] = useState([]);

  const handleOrganized = useCallback((workNos, folderNames) => {
    setOrganizedWorkNos(workNos);
    setCreatedFolderNames(folderNames);
  }, []);

  return (
    <div className="h-full flex flex-col" style={{ background: C.paper, color: C.ink }}>
      <AppHeader
        onBack={onBack}
        icon={<Files size={18} color="#fff" />}
        title="Sequencing File Organizer"
        subtitle="Sort sequencing files, distribute references, build the SG check sheet"
      />

      <div className="px-6" style={{ background: C.surface, borderBottom: "1px solid " + C.border }}>
        <Tabs
          tabs={[
            { id: 1, label: "Organize Files", icon: <Files size={14} /> },
            { id: 2, label: "Distribute References", icon: <Copy size={14} /> },
            { id: 3, label: "SG Check Document", icon: <FileOutput size={14} /> },
          ]}
          active={tab}
          onChange={setTab}
        />
      </div>

      <main className="flex-1 overflow-y-auto p-6">
        <div className="max-w-4xl mx-auto">
          {tab === 1 && (
            <OrganizeTab initialPaths={initialPaths} onOrganized={handleOrganized} />
          )}
          {tab === 2 && (
            <DistributeTab
              initialPaths={initialPaths}
              organizedWorkNos={organizedWorkNos}
            />
          )}
          {tab === 3 && (
            <SgCheckTab
              initialPaths={initialPaths}
              createdFolderNames={createdFolderNames}
            />
          )}
        </div>
      </main>
    </div>
  );
}

// =============================================================================
// Tab 1: Organize Files
// =============================================================================
function OrganizeTab({ initialPaths, onOrganized }) {
  const [sourceDir, setSourceDir] = useState("");
  const [destDir, setDestDir] = useState("");
  const [plan, setPlan] = useState(null);
  const [seqDeleted, setSeqDeleted] = useState(null);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState({ text: "Ready", color: "info" });
  const [logs, setLogs] = useState([]);
  const logEndRef = useRef(null);
  const { dialogState, requestAction, settle } = useIssuesDialog();

  useEffect(() => {
    if (initialPaths?.sorted_sequencing_files_path) setDestDir(initialPaths.sorted_sequencing_files_path);
  }, [initialPaths]);
  useEffect(() => {
    if (logEndRef.current) logEndRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [logs]);

  const appendLog = (msg) => setLogs((prev) => [...prev, { msg, t: Date.now() }]);

  const canRun = sourceDir && destDir && !running;

  const chooseDir = async (setter) => {
    const picked = await window.api.chooseOutputDir("");
    if (picked) setter(picked);
  };

  const handleOrganize = async () => {
    if (!canRun) return;
    setRunning(true);
    setLogs([]);
    setPlan(null);
    setSeqDeleted(null);
    setStatus({ text: "Scanning source...", color: "info" });

    try {
      appendLog(`Source: ${sourceDir}`);
      appendLog(`Destination: ${destDir}`);

      // ── Pre-scan (Python :929-958) ────────────────────────────────────
      // Nothing on disk is touched here: .seq files are COUNTED, not
      // deleted, and the parseable/unparseable split is computed.
      const allFiles = await window.api.listDirectory({
        dirPath: sourceDir,
        filter: "files",
      });
      if (!allFiles?.ok) {
        appendLog(`ERROR: ${allFiles?.error || "Failed to list source directory"}`);
        setStatus({ text: `Failed to list source: ${allFiles?.error}`, color: "bad" });
        return;
      }
      const filenames = allFiles.entries.map((e) => e.name);

      const destFolders = await window.api.listDirectory({ dirPath: destDir, filter: "dirs" });
      const existingFolderNames = destFolders?.ok
        ? destFolders.entries.map((e) => e.name)
        : [];

      const computedPlan = planOrganize(filenames, existingFolderNames);
      setPlan(computedPlan);

      // ── Issues modal (Python :960-989) ───────────────────────────────
      const issues = buildOrganizeIssues(computedPlan);
      if (issues.length) {
        const summary = buildOrganizeSummary(computedPlan);
        setStatus({ text: summary, color: "warn" });
        appendLog(`\n${summary}`);
        const action = await requestAction(
          "Organize Files — Issues Found",
          summary,
          issues
        );
        if (action === "abort") {
          appendLog("\nAborted — no files were changed.");
          setStatus({ text: "Aborted. Nothing was changed on disk.", color: "info" });
          return;
        }
        // Python: 'skip' and 'all' behave identically for Tab 1 (an
        // unparseable file cannot be organized anyway).
        appendLog(
          action === "skip"
            ? "\nSkipping the flagged issues..."
            : "\nProcessing all files..."
        );
      } else {
        setStatus({ text: buildOrganizeSummary(computedPlan), color: "info" });
      }

      // ── Delete .seq files (Python :1008-1019) — AFTER the modal ──────
      appendLog("\nDeleting .seq files from source...");
      let deletedCount = 0;
      for (const name of filenames.filter((n) => n.endsWith(".seq"))) {
        const del = await window.api.deleteFile({ filePath: joinPath(sourceDir, name) });
        if (del.ok) deletedCount++;
        else appendLog(`  Error deleting ${name}: ${del.error}`);
      }
      appendLog(`  Deleted ${deletedCount} .seq files`);
      setSeqDeleted(deletedCount);

      // ── Re-list the source directory (Python :1022-1029 does the same
      //    for the POS count) so the plan reflects the post-deletion state.
      const afterFiles = await window.api.listDirectory({
        dirPath: sourceDir,
        filter: "files",
      });
      const afterNames = afterFiles?.ok
        ? afterFiles.entries.map((e) => e.name)
        : filenames;

      const posCount = afterNames.filter(
        (n) => n.startsWith("POS") || n.startsWith("Pos") || n.startsWith("pos")
      ).length;
      if (posCount) {
        appendLog(`\nSkipped ${posCount} positive control file(s) (POS prefix).`);
      }

      const livePlan = planOrganize(afterNames, existingFolderNames);
      setPlan({ ...livePlan, seqCount: 0 });

      // ── Organize (Python :1035-1065) ─────────────────────────────────
      appendLog("\nOrganizing files...");
      let organizedCount = 0;
      const knownFolders = new Set(existingFolderNames);
      const foldersWithFiles = new Set();
      const workNos = new Set();

      for (const file of livePlan.parseable) {
        // Python: skip files that vanished between the scan and the move.
        if (!afterNames.includes(file.filename)) {
          appendLog(`  ⚠ Skipped (already moved?): ${file.filename}`);
          continue;
        }

        const destFolder = joinPath(destDir, file.folderName);
        if (!knownFolders.has(file.folderName)) {
          const mkResult = await window.api.createDirectory({ dirPath: destFolder });
          if (!mkResult.ok) {
            appendLog(`  Error creating folder ${file.folderName}: ${mkResult.error}`);
            continue;
          }
          appendLog(`  Created folder: ${file.folderName}`);
          knownFolders.add(file.folderName);
        }

        const mvResult = await window.api.moveFile({
          source: joinPath(sourceDir, file.filename),
          dest: joinPath(destFolder, file.filename),
        });
        if (mvResult.ok) {
          organizedCount++;
          workNos.add(file.jobId);
          foldersWithFiles.add(file.folderName);
        } else {
          appendLog(`  Error moving ${file.filename}: ${mvResult.error}`);
        }
      }

      const organizedWorkNoList = [...workNos];
      const createdFolderList = [...foldersWithFiles].sort();

      appendLog(`\nOrganized ${organizedCount} files.`);
      appendLog(`Found ${organizedWorkNoList.length} unique Work No.`);
      appendLog("\n--- Organization Complete ---");
      onOrganized?.(organizedWorkNoList, createdFolderList);
      setStatus({ text: `Organized ${organizedCount} files.`, color: "good" });
    } catch (err) {
      appendLog(`\nERROR: ${err.message}`);
      setStatus({ text: `Error: ${err.message}`, color: "bad" });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <Panel
        icon={<FolderOpen size={15} style={{ color: C.teal }} />}
        title="Sequencing Files Directory"
        subtitle="Source folder holding the raw sequencing output (.ab1 / .fasta)"
      >
        <FolderPicker
          id="sfo-source-dir"
          value={sourceDir}
          onChange={setSourceDir}
          onBrowse={() => chooseDir(setSourceDir)}
          placeholder="Select the folder with the raw sequencing files (.ab1 / .fasta)"
        />
      </Panel>

      <Panel
        icon={<FolderOpen size={15} style={{ color: C.teal }} />}
        title="Sorted Sequencing Folder"
        subtitle="Destination — one folder per Work No."
      >
        <FolderPicker
          id="sfo-dest-dir"
          value={destDir}
          onChange={setDestDir}
          onBrowse={() => chooseDir(setDestDir)}
        />
      </Panel>

      <div className="flex items-center justify-between gap-4">
        <div className="flex-1 min-w-0">
          <StatusLine status={status} running={running} />
        </div>
        <Button id="sfo-organize-run" variant="primary" size="lg" disabled={!canRun} onClick={handleOrganize}>
          <Play size={15} />
          {running ? "Organizing…" : "Organize Files"}
        </Button>
      </div>

      {plan && (
        <Panel title="Pre-scan results">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
            <Stat label="Parseable" value={plan.parseable.length} tone="good" />
            <Stat label="Unparseable" value={plan.unparseable.length} tone="warn" />
            <Stat label="Existing folders" value={plan.existingFolders.length} tone="info" />
            <Stat label=".seq files deleted" value={seqDeleted ?? plan.seqCount} tone="neutral" />
            <Stat label="POS controls skipped" value={plan.posCount} tone="neutral" />
          </div>
        </Panel>
      )}

      <LogPanel logs={logs} onClear={() => setLogs([])} endRef={logEndRef} />

      <IssuesDialog
        open={!!dialogState}
        title={dialogState?.title}
        summary={dialogState?.summary}
        issues={dialogState?.issues}
        onAbort={() => settle("abort")}
        onSkip={() => settle("skip")}
        onAll={() => settle("all")}
      />
    </div>
  );
}

// =============================================================================
// Tab 2: Distribute References
// =============================================================================
function DistributeTab({ initialPaths, organizedWorkNos }) {
  const [refDir, setRefDir] = useState("");
  const [destDir, setDestDir] = useState("");
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState({ text: "Ready", color: "info" });
  const [logs, setLogs] = useState([]);
  const logEndRef = useRef(null);
  const { dialogState, requestAction, settle } = useIssuesDialog();

  useEffect(() => {
    if (initialPaths?.reference_sequences_path) setRefDir(initialPaths.reference_sequences_path);
    if (initialPaths?.sorted_sequencing_files_path) setDestDir(initialPaths.sorted_sequencing_files_path);
  }, [initialPaths]);
  useEffect(() => {
    if (logEndRef.current) logEndRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [logs]);

  const appendLog = (msg) => setLogs((prev) => [...prev, { msg, t: Date.now() }]);

  // The Python only enables the Distribute button once Tab 1 has produced
  // Work Nos (`self.organized_work_nos`); all Tab-2 matching is against
  // that in-session set, never against whatever is on disk.
  const canRun = refDir && destDir && organizedWorkNos.length > 0 && !running;

  const chooseDir = async (setter) => {
    const picked = await window.api.chooseOutputDir("");
    if (picked) setter(picked);
  };

  const handleDistribute = async () => {
    if (!canRun) return;
    setRunning(true);
    setLogs([]);
    setStatus({ text: "Loading reference files...", color: "info" });

    try {
      const jobIds = organizedWorkNos;

      // ── Pre-scan (Python :1099-1137) ────────────────────────────────
      const refFilesResult = await window.api.listDirectory({
        dirPath: refDir, filter: "files", extension: ".txt",
      });
      const refFilenames = refFilesResult.ok ? refFilesResult.entries.map((e) => e.name) : [];
      const { fileMap, missingRefs } = findMissingReferences(refFilenames, jobIds);

      const destFoldersResult = await window.api.listDirectory({ dirPath: destDir, filter: "dirs" });
      const existingFolderNames = destFoldersResult.ok
        ? destFoldersResult.entries.map((e) => e.name)
        : [];
      const missingFolders = findMissingFolders(existingFolderNames, jobIds);

      const issues = buildDistributeIssueLines(missingRefs, missingFolders);
      let skipIds = new Set();
      if (issues.length) {
        const summary = buildDistributeSummaryLine(fileMap, jobIds, missingRefs, missingFolders);
        setStatus({ text: summary, color: "warn" });
        appendLog(`\n${summary}`);
        const action = await requestAction(
          "Distribute References — Issues Found",
          summary,
          issues
        );
        if (action === "abort") {
          appendLog("\nAborted — no files were changed.");
          setStatus({ text: "Aborted. Nothing was changed on disk.", color: "info" });
          return;
        }
        if (action === "skip") {
          // Python: work_nos_to_skip = set(missing) | set(missing_folders)
          skipIds = new Set([...missingRefs, ...missingFolders]);
        }
        // "Process All" keeps every Work No. — nothing is skipped.
      }

      // ── Distribute (Python :1167-1216) ─────────────────────────────
      appendLog(`Reference files: ${refDir}`);
      appendLog(`Destination: ${destDir}`);
      if (skipIds.size) {
        appendLog(`\nSkipping ${skipIds.size} Work No. with issues.`);
      }
      appendLog(`\nDistributing reference files...`);

      let distributedCount = 0;
      for (const folderEntry of destFoldersResult.entries) {
        const folderName = folderEntry.name;
        const folderBase = folderName.split(".")[0];
        if (!jobIds.includes(folderBase)) continue;
        if (!fileMap[folderBase]) continue;
        if (skipIds.has(folderBase)) {
          appendLog(`  Skipped ${folderName} (missing files)`);
          continue;
        }
        const destFolder = joinPath(destDir, folderName);
        for (const refFilename of fileMap[folderBase]) {
          const sourceFile = joinPath(refDir, refFilename);
          const destFile = joinPath(destFolder, refFilename);
          const r = await window.api.copyFile({ source: sourceFile, dest: destFile });
          if (r.ok) {
            appendLog(`  Copied ${refFilename} to ${folderName}`);
            distributedCount++;
          } else {
            appendLog(`  Error copying ${refFilename}: ${r.error}`);
          }
        }
      }

      appendLog(`\nDistributed ${distributedCount} reference files.`);
      appendLog("\n--- Distribution Complete ---");
      setStatus({ text: `Distributed ${distributedCount} files.`, color: "good" });
    } catch (err) {
      appendLog(`\nERROR: ${err.message}`);
      setStatus({ text: `Error: ${err.message}`, color: "bad" });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <Panel
        icon={<FolderOpen size={15} style={{ color: C.teal }} />}
        title="Reference Files Directory"
        subtitle="Holds the .txt reference sequences"
      >
        <FolderPicker
          id="sfo-ref-dir"
          value={refDir}
          onChange={setRefDir}
          onBrowse={() => chooseDir(setRefDir)}
        />
      </Panel>

      <Panel
        icon={<FolderOpen size={15} style={{ color: C.teal }} />}
        title="Destination Directory"
        subtitle="The Tab 1 sorted-sequencing folder"
      >
        <FolderPicker
          id="sfo-dist-dest-dir"
          value={destDir}
          onChange={setDestDir}
          onBrowse={() => chooseDir(setDestDir)}
        />
      </Panel>

      <div className="flex items-center justify-between gap-4">
        <div className="flex-1 min-w-0">
          <StatusLine status={status} running={running} />
        </div>
        <Button id="sfo-distribute-run" variant="primary" size="lg" disabled={!canRun} onClick={handleDistribute}>
          <Play size={15} />
          {running ? "Distributing…" : "Distribute References"}
        </Button>
      </div>

      {organizedWorkNos.length > 0 ? (
        <Pill tone="info">
          Using {organizedWorkNos.length} Work No. organized in Tab 1 (this session).
        </Pill>
      ) : (
        <Pill tone="warn">
          No Work Nos organized yet. Run Tab 1 first — distribution only targets the
          Work Nos organized in this session.
        </Pill>
      )}

      <LogPanel logs={logs} onClear={() => setLogs([])} endRef={logEndRef} />

      <IssuesDialog
        open={!!dialogState}
        title={dialogState?.title}
        summary={dialogState?.summary}
        issues={dialogState?.issues}
        onAbort={() => settle("abort")}
        onSkip={() => settle("skip")}
        onAll={() => settle("all")}
      />
    </div>
  );
}

// =============================================================================
// Tab 3: SG Check Document
// =============================================================================
function SgCheckTab({ initialPaths, createdFolderNames }) {
  const [templateFile, setTemplateFile] = useState("");
  const [outputDir, setOutputDir] = useState("");
  const [destDir, setDestDir] = useState(""); // folder containing the organized Work No. folders
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState({ text: "Ready", color: "info" });
  const [logs, setLogs] = useState([]);
  const logEndRef = useRef(null);
  const fileInputRef = useRef(null);
  const { dialogState, requestAction, settle } = useIssuesDialog();

  useEffect(() => {
    if (initialPaths?.sg_check_template_path) setTemplateFile(initialPaths.sg_check_template_path);
    if (initialPaths?.sg_check_output_path) setOutputDir(initialPaths.sg_check_output_path);
    if (initialPaths?.sorted_sequencing_files_path) setDestDir(initialPaths.sorted_sequencing_files_path);
  }, [initialPaths]);
  useEffect(() => {
    if (logEndRef.current) logEndRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [logs]);

  const appendLog = (msg) => setLogs((prev) => [...prev, { msg, t: Date.now() }]);

  const canRun = templateFile && outputDir && destDir && !running;

  const chooseFile = async () => {
    if (!window.api.chooseFile) {
      // Fall back to a hidden <input type=file> for prototype use.
      fileInputRef.current?.click();
    } else {
      // The native dialog returns an ABSOLUTE path — the same value the
      // Python's filedialog.askopenfilename stores.
      const picked = await window.api.chooseFile({ filter: ".xlsx" });
      if (picked) setTemplateFile(picked);
    }
  };
  const onFileChange = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    // The fallback input must also yield an ABSOLUTE path: the template is
    // later read through `hub:readBinaryFile`, which resolves relative to
    // the app's CWD. Electron 32+ removed `File.path`, so ask the preload
    // bridge (webUtils.getPathForFile) and keep `File.path` as a fallback
    // for older builds.
    const abs = await resolveAbsolutePath(f);
    if (abs) {
      setTemplateFile(abs);
    } else {
      setStatus({
        text: "Could not resolve an absolute path for the selected file. Use Browse… (native dialog) instead.",
        color: "bad",
      });
    }
  };
  const chooseDir = async (setter) => {
    const picked = await window.api.chooseOutputDir("");
    if (picked) setter(picked);
  };

  const handleGenerate = async () => {
    if (!canRun) return;
    setRunning(true);
    setLogs([]);
    setStatus({ text: "Loading template + scanning folders...", color: "info" });

    try {
      // Step 1: list subdirectories of destDir (= "Sorted Sequencing Folder")
      const foldersResult = await window.api.listDirectory({ dirPath: destDir, filter: "dirs" });
      if (!foldersResult.ok) {
        appendLog(`ERROR: ${foldersResult.error}`);
        setStatus({ text: `Failed to list destination: ${foldersResult.error}`, color: "bad" });
        setRunning(false);
        return;
      }
      const folderNames = foldersResult.entries.map((e) => e.name);

      // Step 2: classify each folder
      appendLog(`Scanning ${folderNames.length} folders...`);
      const folderContents = {};
      for (const fn of folderNames) {
        const inner = await window.api.listDirectory({
          dirPath: joinPath(destDir, fn),
          filter: "files",
        });
        folderContents[fn] = inner.ok ? inner.entries.map((e) => e.name) : [];
      }
      const plan = planSgCheck(folderNames, folderContents);

      // ── Issues modal (Python :1270-1284) ────────────────────────────
      // "Skip Issues" -> only the valid folders; "Process All" -> the
      // folder list is left UNCHANGED, so the incomplete folders are
      // written to the Excel too (remove them by hand afterwards).
      let foldersToProcess = folderNames;
      const issues = buildSgCheckIssues(plan.invalid);
      if (issues.length) {
        const summary = buildSgCheckSummary(plan);
        appendLog("\n" + issues.join("\n"));
        appendLog(`\n${summary}`);
        setStatus({ text: summary.replace(/\n/g, " "), color: "warn" });
        const action = await requestAction(
          "SG Check Document — Issues Found",
          summary,
          issues
        );
        const selection = selectSgCheckFolders(plan, folderNames, action);
        if (selection.aborted) {
          appendLog("\nAborted — no document was created.");
          setStatus({ text: "Aborted. No document was created.", color: "info" });
          return;
        }
        foldersToProcess = selection.folders;
        if (action === "skip") {
          appendLog("\nExcluding the incomplete folders from the Excel.");
        } else {
          appendLog("\nIncluding every folder in the Excel (remove extras manually later).");
        }
      }

      // Step 3: read template + write folder names into column A, save.
      appendLog(`\nLoading template: ${templateFile.split(/[\\/]/).pop()}`);
      appendLog(`Writing ${foldersToProcess.length} folder names to Column A...`);

      const readResult = await window.api.readBinaryFile({ filePath: templateFile });
      if (!readResult?.ok) {
        appendLog(`ERROR: ${readResult?.error || "Failed to read template"}`);
        setStatus({ text: `Failed to read template: ${readResult?.error}`, color: "bad" });
        setRunning(false);
        return;
      }

      // Surgical zip edit — NOT a SheetJS read/write round-trip.
      //
      // The Gene Seq Log template carries an EXTERNAL LINK and ~2500 VLOOKUP
      // formulas that reference it (`[1]Initiated!$A:$Y`). SheetJS drops
      // `xl/externalLinks/` on write, so a full round-trip leaves every one
      // of those formulas pointing at a workbook that no longer exists
      // (#REF! across the sheet). The Python original uses openpyxl, which
      // preserves external links. Rewriting only the sheet part and copying
      // every other zip entry byte-identical keeps the link, the shared
      // strings, the styles and the calc chain intact.
      const entries = foldersToProcess.map((name, i) => ({ row: i + 2, value: name }));
      let outBytes;
      try {
        const bytes = toUint8Array(readResult.bytes);
        const files = unzipSync(bytes);
        const sheetName = activeSheetName(files);
        const part = resolveSheetPart(files, sheetName);
        const decoder = new TextDecoder("utf-8");
        const encoder = new TextEncoder();
        const sheetXml = decoder.decode(files[part]);
        const patched = setColumnA(sheetXml, entries);
        files[part] = encoder.encode(patched);
        outBytes = zipSync(files, { level: 6 });
      } catch (err) {
        appendLog(`ERROR editing template: ${err.message}`);
        setStatus({ text: `Template edit failed: ${err.message}`, color: "bad" });
        setRunning(false);
        return;
      }

      const filename = suggestSgCheckFilename();
      const outPath = joinPath(outputDir, filename);
      const writeResult = await window.api.writeBinaryFile({
        filePath: outPath,
        bytes: outBytes,
      });
      if (!writeResult?.ok) {
        appendLog(`ERROR saving file: ${writeResult.error}`);
        setStatus({ text: `Save failed: ${writeResult.error}`, color: "bad" });
        setRunning(false);
        return;
      }
      appendLog(`Saving file as: ${filename}`);
      appendLog(`File successfully saved to: ${outputDir}`);
      appendLog("\n--- SG Check Generation Complete ---");
      setStatus({ text: `Done. Generated ${filename}.`, color: "good" });
    } catch (err) {
      appendLog(`\nERROR: ${err.message}`);
      setStatus({ text: `Error: ${err.message}`, color: "bad" });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <Panel
        icon={<FileOutput size={15} style={{ color: C.teal }} />}
        title="Excel Template File"
        subtitle="Gene Seq Log template"
      >
        <div className="flex items-center gap-2">
          <PathInput id="sfo-template-file" value={templateFile} style={{ flex: 1 }} />
          <input ref={fileInputRef} type="file" accept=".xlsx" className="hidden" onChange={onFileChange} />
          <Button id="sfo-template-browse" variant="primary" onClick={chooseFile}>
            Browse…
          </Button>
        </div>
      </Panel>

      <Panel
        icon={<FolderOpen size={15} style={{ color: C.teal }} />}
        title="Document Destination Folder"
        subtitle="Where the generated SG Check workbook is written"
      >
        <FolderPicker
          id="sfo-output-dir"
          value={outputDir}
          onChange={setOutputDir}
          onBrowse={() => chooseDir(setOutputDir)}
        />
      </Panel>

      <Panel
        icon={<FolderOpen size={15} style={{ color: C.teal }} />}
        title="Folder Source"
        subtitle="Organized folders from Tab 1"
      >
        <FolderPicker
          id="sfo-folder-source"
          value={destDir}
          onChange={setDestDir}
          onBrowse={() => chooseDir(setDestDir)}
        />
      </Panel>

      <div className="flex items-center justify-between gap-4">
        <div className="flex-1 min-w-0">
          <StatusLine status={status} running={running} />
        </div>
        <Button id="sfo-sgcheck-run" variant="primary" size="lg" disabled={!canRun} onClick={handleGenerate}>
          <Play size={15} />
          {running ? "Generating…" : "Generate SG Check Document"}
        </Button>
      </div>

      {createdFolderNames.length > 0 && (
        <Pill tone="info">
          {createdFolderNames.length} folders organized in Tab 1 (this session).
        </Pill>
      )}

      <LogPanel logs={logs} onClear={() => setLogs([])} endRef={logEndRef} />

      <IssuesDialog
        open={!!dialogState}
        title={dialogState?.title}
        summary={dialogState?.summary}
        issues={dialogState?.issues}
        onAbort={() => settle("abort")}
        onSkip={() => settle("skip")}
        onAll={() => settle("all")}
      />
    </div>
  );
}

// =============================================================================
// Shared UI bits
// =============================================================================

/**
 * The pre-execution scan modal.
 *
 * Mirrors the Python's `_show_issues_dialog` (abort / skip / all). The
 * Abort action must leave the filesystem untouched, so the caller awaits
 * this promise BEFORE it deletes or moves anything.
 */
function IssuesDialog({ open, title, summary, issues, onAbort, onSkip, onAll }) {
  return (
    <Modal
      open={open}
      title={title}
      onCancel={onAbort}
      width={620}
      footer={
        <>
          <Button id="sfo-dialog-abort" variant="danger" onClick={onAbort}>
            Abort
          </Button>
          <Button id="sfo-dialog-skip" variant="secondary" onClick={onSkip}>
            Skip Issues
          </Button>
          <Button id="sfo-dialog-all" variant="accent" onClick={onAll}>
            Process All
          </Button>
        </>
      }
    >
      {summary && (
        <p
          className="text-xs font-semibold mb-3 whitespace-pre-line"
          style={{ color: C.ink, fontFamily: FONT_MONO }}
        >
          {summary}
        </p>
      )}
      <pre
        className="rounded-md p-3 text-[11px] leading-relaxed overflow-auto"
        style={{
          background: C.subtle,
          border: "1px solid " + C.border,
          color: C.ink,
          fontFamily: FONT_MONO,
          maxHeight: "40vh",
          whiteSpace: "pre-wrap",
        }}
      >
        {(issues || []).join("\n")}
      </pre>
      <p className="text-[11px] mt-3" style={{ color: C.inkFaint }}>
        Choose how to proceed: Abort changes nothing, Skip Issues excludes the
        flagged items, Process All includes everything.
      </p>
    </Modal>
  );
}

/**
 * Hook that turns the modal into a promise: `requestAction(title, summary,
 * issues)` resolves with "abort" | "skip" | "all".
 */
function useIssuesDialog() {
  const [dialogState, setDialogState] = useState(null);
  const resolverRef = useRef(null);

  const requestAction = useCallback((title, summary, issues) => {
    return new Promise((resolve) => {
      resolverRef.current = resolve;
      setDialogState({ title, summary, issues });
    });
  }, []);

  const settle = useCallback((action) => {
    setDialogState(null);
    const resolve = resolverRef.current;
    resolverRef.current = null;
    resolve?.(action);
  }, []);

  return { dialogState, requestAction, settle };
}

/**
 * The Tab 2 issue list, worded exactly like the Python
 * (`_start_distribute`): "⚠ N Work No. missing reference .txt files:" etc.
 */
function buildDistributeIssueLines(missingRefs, missingFolders) {
  const issues = [];
  if (missingRefs.length) {
    issues.push(`⚠ ${missingRefs.length} Work No. missing reference .txt files:`);
    for (const wn of [...missingRefs].sort()) issues.push(`  ✖ ${wn}`);
    issues.push("");
  }
  if (missingFolders.length) {
    issues.push(`⚠ ${missingFolders.length} Work No. have no destination folder:`);
    for (const wn of [...new Set(missingFolders)].sort()) issues.push(`  ✖ ${wn}`);
    issues.push("");
  }
  return issues;
}

/** The Tab 2 summary line, worded exactly like the Python. */
function buildDistributeSummaryLine(fileMap, jobIds, missingRefs, missingFolders) {
  let summary = `Scan found .txt files for ${Object.keys(fileMap).length} of ${jobIds.length} Work No.`;
  if (missingRefs.length) summary += `, ${missingRefs.length} missing references`;
  if (missingFolders.length) summary += `, ${missingFolders.length} missing folders`;
  return summary + ".";
}

/**
 * Resolve the absolute path of a File picked through an <input type=file>.
 * Electron 32+ removed the `File.path` property, so the preload bridge
 * (webUtils.getPathForFile) is the supported route; `File.path` stays as a
 * fallback for older builds.
 */
async function resolveAbsolutePath(file) {
  try {
    if (window.api?.getPathForFile) {
      const p = window.api.getPathForFile(file);
      if (p) return p;
    }
  } catch {
    /* fall through to the File.path fallback */
  }
  return file?.path || "";
}

function Stat({ label, value, tone = "neutral" }) {
  const tones = {
    good: { fg: C.tealDeep, bg: C.tealSoft },
    warn: { fg: C.amber, bg: C.amberSoft },
    bad: { fg: C.coral, bg: C.coralSoft },
    info: { fg: C.navy, bg: C.navySoft },
    neutral: { fg: C.inkMuted, bg: C.subtle },
  };
  const t = tones[tone] || tones.neutral;
  return (
    <div className="rounded-md px-3 py-2" style={{ background: t.bg }}>
      <div className="text-lg font-semibold leading-tight" style={{ color: t.fg }}>
        {value}
      </div>
      <div className="text-[10px] uppercase tracking-wide" style={{ color: C.inkMuted }}>
        {label}
      </div>
    </div>
  );
}

function FolderPicker({ id, value, onChange, onBrowse, placeholder }) {
  return (
    <div className="flex items-center gap-2">
      <PathInput
        id={id}
        value={value}
        readOnly={false}
        // The shared TextInput hands onChange the string value.
        onChange={onChange}
        placeholder={placeholder || "Click 'Browse…' to choose the folder"}
        style={{ flex: 1 }}
      />
      <Button variant="primary" onClick={onBrowse}>
        Browse…
      </Button>
    </div>
  );
}

// Join paths using the platform separator (Windows: \\, Mac/Linux: /).
function joinPath(dir, name) {
  if (!dir) return name;
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + sep + name;
}

// Normalize whatever the IPC handed us (ArrayBuffer / typed array) into a
// Uint8Array the unzip library can read.
function toUint8Array(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) return new Uint8Array(data);
  throw new Error("Unsupported binary payload type");
}
