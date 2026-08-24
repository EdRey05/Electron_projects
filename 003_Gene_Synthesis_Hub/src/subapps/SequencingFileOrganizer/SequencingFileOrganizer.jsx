import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  FolderOpen,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Files,
  Copy,
  FileOutput,
  Play,
} from "lucide-react";
import {
  classifyFile,
  planOrganize,
  buildOrganizeIssues,
  buildOrganizeSummary,
} from "./organize.js";
import {
  findMissingReferences,
  findMissingFolders,
  buildDistributeIssues,
  buildDistributeSummary,
} from "./distribute.js";
import {
  classifyFolderForSgCheck,
  planSgCheck,
  buildSgCheckIssues,
  buildSgCheckSummary,
  suggestSgCheckFilename,
} from "./sgCheck.js";

/**
 * Sequencing File Organizer — React port of `sequencing_file_organizer_app.py`.
 *
 * Three tabs mirroring the original Tkinter UI:
 *   Tab 1: Organize Sequencing Files (scan -> move into per-JobID folders)
 *   Tab 2: Distribute Reference Files (scan -> copy .txt into Tab 1 folders)
 *   Tab 3: SG Check Document (scan -> write folder names into Excel template)
 *
 * File-system actions all go through Electron IPC handlers (no Node access
 * from the renderer). Each tab has its own picker for source/destination
 * folders and its own log.
 */
export default function SequencingFileOrganizer({ onBack, initialPaths }) {
  const [tab, setTab] = useState(1); // 1, 2, or 3

  return (
    <div className="h-full flex flex-col bg-ink-900 text-slate-100">
      <header className="flex items-center justify-between px-6 py-3 border-b border-ink-700 bg-ink-800/60">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-ink-700 hover:bg-ink-600 text-slate-200 text-sm"
          >
            <ArrowLeft size={14} /> Hub
          </button>
          <div className="w-9 h-9 rounded-lg bg-accent-500/15 flex items-center justify-center">
            <Files size={18} className="text-accent-400" />
          </div>
          <div>
            <h1 className="font-semibold text-lg leading-tight">Sequencing File Organizer</h1>
            <p className="text-[11px] text-slate-400 leading-tight">
              Sort sequencing files, distribute references, build SG check sheet.
            </p>
          </div>
        </div>
      </header>

      <nav className="flex border-b border-ink-700 bg-ink-800/40">
        <TabButton active={tab === 1} onClick={() => setTab(1)} icon={<Files size={14} />}>
          Organize Files
        </TabButton>
        <TabButton active={tab === 2} onClick={() => setTab(2)} icon={<Copy size={14} />}>
          Distribute References
        </TabButton>
        <TabButton active={tab === 3} onClick={() => setTab(3)} icon={<FileOutput size={14} />}>
          SG Check Document
        </TabButton>
      </nav>

      <main className="flex-1 overflow-y-auto p-6 space-y-5">
        {tab === 1 && <OrganizeTab initialPaths={initialPaths} />}
        {tab === 2 && <DistributeTab initialPaths={initialPaths} />}
        {tab === 3 && <SgCheckTab initialPaths={initialPaths} />}
      </main>
    </div>
  );
}

function TabButton({ active, onClick, icon, children }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 inline-flex items-center gap-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
        active
          ? "border-accent-400 text-accent-300"
          : "border-transparent text-slate-300 hover:text-white hover:bg-ink-700/40"
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

// =============================================================================
// Tab 1: Organize Files
// =============================================================================
function OrganizeTab({ initialPaths }) {
  const [sourceDir, setSourceDir] = useState("");
  const [destDir, setDestDir] = useState("");
  const [plan, setPlan] = useState(null);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState({ text: "Ready", color: "info" });
  const [logs, setLogs] = useState([]);
  const logEndRef = useRef(null);

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
    setStatus({ text: "Scanning source...", color: "info" });

    try {
      appendLog(`Source: ${sourceDir}`);
      appendLog(`Destination: ${destDir}`);

      // Step 1: delete .seq files in source
      appendLog("\nDeleting .seq files from source...");
      const seqResult = await window.api.listDirectory({
        dirPath: sourceDir,
        filter: "files",
        extension: ".seq",
      });
      if (seqResult.ok) {
        for (const ent of seqResult.entries) {
          const fullPath = joinPath(sourceDir, ent.name);
          const del = await window.api.deleteFile({ filePath: fullPath });
          if (del.ok) appendLog(`  Deleted: ${ent.name}`);
          else appendLog(`  Error deleting ${ent.name}: ${del.error}`);
        }
      }

      // Step 2: list everything else
      const allFiles = await window.api.listDirectory({
        dirPath: sourceDir,
        filter: "files",
      });
      const posCount = allFiles.entries.filter((e) =>
        e.name.startsWith("POS") || e.name.startsWith("Pos") || e.name.startsWith("pos")
      ).length;
      if (posCount) appendLog(`\nSkipped ${posCount} positive control file(s) (POS prefix).`);

      // Step 3: classify + plan
      const filenames = allFiles.entries.map((e) => e.name);
      const existingFolderNamesResult = await window.api.listDirectory({
        dirPath: destDir,
        filter: "dirs",
      });
      const existingFolderNames = existingFolderNamesResult.ok
        ? existingFolderNamesResult.entries.map((e) => e.name)
        : [];
      const computedPlan = planOrganize(filenames, existingFolderNames);

      const issues = buildOrganizeIssues(computedPlan);
      if (issues.length) {
        setStatus({
          text: `Scan found ${computedPlan.parseable.length} parseable, ${computedPlan.unparseable.length} unparseable, ${computedPlan.existingFolders.length} existing folders. Proceeding (unparseable are skipped automatically).`,
          color: "warn",
        });
      } else {
        setStatus({
          text: `Scan found ${computedPlan.parseable.length} parseable files. Proceeding.`,
          color: "info",
        });
      }
      setPlan(computedPlan);

      appendLog("\nOrganizing files...");
      let organizedCount = 0;
      const createdFolders = new Set();

      for (const file of computedPlan.parseable) {
        const sourceFile = joinPath(sourceDir, file.filename);
        const destFolder = joinPath(destDir, file.folderName);
        const destFile = joinPath(destFolder, file.filename);

        // Make folder if needed
        if (!createdFolders.has(file.folderName)) {
          const mkResult = await window.api.createDirectory({ dirPath: destFolder });
          if (mkResult.ok) {
            appendLog(`  Created folder: ${file.folderName}`);
            createdFolders.add(file.folderName);
          } else {
            appendLog(`  Error creating folder ${file.folderName}: ${mkResult.error}`);
            continue;
          }
        }
        const mvResult = await window.api.moveFile({ source: sourceFile, dest: destFile });
        if (mvResult.ok) {
          organizedCount++;
        } else {
          appendLog(`  Error moving ${file.filename}: ${mvResult.error}`);
        }
      }

      appendLog(`\nOrganized ${organizedCount} files.`);
      appendLog(`Found ${new Set(computedPlan.parseable.map((p) => p.jobId)).size} unique Job IDs.`);
      appendLog("\n--- Organization Complete ---");
      setStatus({
        text: `Done. Organized ${organizedCount} files into ${createdFolders.size} folder(s).`,
        color: "good",
      });
    } catch (err) {
      appendLog(`\nERROR: ${err.message}`);
      setStatus({ text: `Error: ${err.message}`, color: "bad" });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <Section title="Reference Sequences Directory" />
      <FolderPicker value={sourceDir} onChange={setSourceDir} onBrowse={() => chooseDir(setSourceDir)} />
      <Section title="Sorted Sequencing Folder" />
      <FolderPicker value={destDir} onChange={setDestDir} onBrowse={() => chooseDir(setDestDir)} />

      <div className="flex items-center justify-between gap-4">
        <StatusDisplay status={status} running={running} />
        <ActionButton onClick={handleOrganize} disabled={!canRun} color="good" icon={<Play size={14} />}>
          {running ? "Organizing..." : "Organize Files"}
        </ActionButton>
      </div>

      {plan && (
        <div className="bg-ink-800/40 border border-ink-700 rounded-lg p-4 text-xs">
          <div className="font-semibold mb-1">Pre-scan results</div>
          <div>Parseable: {plan.parseable.length}</div>
          <div>Unparseable: {plan.unparseable.length}</div>
          <div>Existing folders (will be reused): {plan.existingFolders.length}</div>
          <div>.seq files deleted: {plan.seqCount}</div>
          <div>POS control files skipped: {plan.posCount}</div>
        </div>
      )}

      <LogBox logs={logs} logEndRef={logEndRef} />
    </div>
  );
}

// =============================================================================
// Tab 2: Distribute References
// =============================================================================
function DistributeTab({ initialPaths }) {
  const [refDir, setRefDir] = useState("");
  const [destDir, setDestDir] = useState("");
  const [organizedJobIds, setOrganizedJobIds] = useState([]); // set externally after Tab 1 runs
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState({ text: "Ready", color: "info" });
  const [logs, setLogs] = useState([]);
  const logEndRef = useRef(null);

  useEffect(() => {
    if (initialPaths?.reference_sequences_path) setRefDir(initialPaths.reference_sequences_path);
    if (initialPaths?.sorted_sequencing_files_path) setDestDir(initialPaths.sorted_sequencing_files_path);
  }, [initialPaths]);
  useEffect(() => {
    if (logEndRef.current) logEndRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [logs]);

  const appendLog = (msg) => setLogs((prev) => [...prev, { msg, t: Date.now() }]);

  const canRun = refDir && destDir && !running;

  const chooseDir = async (setter) => {
    const picked = await window.api.chooseOutputDir("");
    if (picked) setter(picked);
  };

  const loadOrganizedJobIds = async () => {
    // List subdirectories of destDir whose name's first "."-separated token
    // is the Job ID. Mirrors `os.listdir(dest_base_dir)` + `folder.split(".")[0]`.
    const r = await window.api.listDirectory({ dirPath: destDir, filter: "dirs" });
    if (!r.ok) return [];
    return r.entries.map((e) => e.name.split(".")[0]).filter(Boolean);
  };

  const handleDistribute = async () => {
    if (!canRun) return;
    setRunning(true);
    setLogs([]);
    setStatus({ text: "Loading reference files...", color: "info" });

    try {
      const jobIds = await loadOrganizedJobIds();
      setOrganizedJobIds(jobIds);
      appendLog(`Found ${jobIds.length} organized Job IDs in destination.`);

      const refFilesResult = await window.api.listDirectory({
        dirPath: refDir, filter: "files", extension: ".txt",
      });
      const refFilenames = refFilesResult.ok ? refFilesResult.entries.map((e) => e.name) : [];
      const { fileMap, missingRefs } = findMissingReferences(refFilenames, jobIds);

      // Existing folders in dest
      const destFoldersResult = await window.api.listDirectory({ dirPath: destDir, filter: "dirs" });
      const existingFolderNames = destFoldersResult.ok ? destFoldersResult.entries.map((e) => e.name) : [];
      const missingFolders = findMissingFolders(existingFolderNames, jobIds);

      appendLog(buildDistributeSummary({ fileMap, missingRefs, missingFolders, organizedJobIds: jobIds }));

      const issues = buildDistributeIssues({ missingRefs, missingFolders });
      const skipIds = new Set();
      if (issues.length) {
        appendLog("\n" + issues.join("\n"));
        // For now, auto-skip missing (matches Python's "skip" action).
        // TODO: surface this as a real modal in the renderer.
        skipIds.add(...missingRefs);
        skipIds.add(...missingFolders);
        appendLog(`\nAuto-skipping ${skipIds.size} Job ID(s) with issues.`);
      }

      appendLog("\nDistributing reference files...");
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
      setStatus({
        text: `Done. Distributed ${distributedCount} file(s).`,
        color: "good",
      });
    } catch (err) {
      appendLog(`\nERROR: ${err.message}`);
      setStatus({ text: `Error: ${err.message}`, color: "bad" });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <Section title="Reference Files Directory (Tab 1 destination is implied)" />
      <FolderPicker value={refDir} onChange={setRefDir} onBrowse={() => chooseDir(setRefDir)} />
      <Section title="Destination Directory" />
      <FolderPicker value={destDir} onChange={setDestDir} onBrowse={() => chooseDir(setDestDir)} />

      <div className="flex items-center justify-between gap-4">
        <StatusDisplay status={status} running={running} />
        <ActionButton onClick={handleDistribute} disabled={!canRun} color="good" icon={<Play size={14} />}>
          {running ? "Distributing..." : "Distribute References"}
        </ActionButton>
      </div>

      {organizedJobIds.length > 0 && (
        <div className="bg-ink-800/40 border border-ink-700 rounded-lg p-4 text-xs">
          <span className="font-semibold">Last scan:</span> found {organizedJobIds.length} organized Job IDs.
        </div>
      )}

      <LogBox logs={logs} logEndRef={logEndRef} />
    </div>
  );
}

// =============================================================================
// Tab 3: SG Check Document
// =============================================================================
function SgCheckTab({ initialPaths }) {
  const [templateFile, setTemplateFile] = useState("");
  const [outputDir, setOutputDir] = useState("");
  const [destDir, setDestDir] = useState(""); // folder containing the organized JobID folders
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState({ text: "Ready", color: "info" });
  const [logs, setLogs] = useState([]);
  const logEndRef = useRef(null);
  const fileInputRef = useRef(null);

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
      const picked = await window.api.chooseFile({ filter: ".xlsx" });
      if (picked) setTemplateFile(picked);
    }
  };
  const onFileChange = (e) => {
    const f = e.target.files?.[0];
    if (f) setTemplateFile(f.name);
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

      const issues = buildSgCheckIssues(plan.invalid);
      let foldersToProcess = plan.valid;
      if (issues.length) {
        appendLog("\n" + issues.join("\n"));
        appendLog(`\n${buildSgCheckSummary(plan)}`);
        appendLog("Auto-skipping incomplete folders (Python app's 'Skip' action).");
        foldersToProcess = plan.valid;
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
      const XLSX = await import("xlsx");
      const wb = XLSX.read(readResult.bytes, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      // Write folder names into column A starting at row 2.
      let row = 2;
      for (const name of foldersToProcess) {
        ws[`A${row}`] = { t: "s", v: name };
        row++;
      }
      const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
      const filename = suggestSgCheckFilename();
      const outPath = joinPath(outputDir, filename);
      const writeResult = await window.api.writeBinaryFile({
        filePath: outPath,
        bytes: out,
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
      <Section title="Excel Template File" />
      <div className="flex items-center gap-2">
        <input
          type="text"
          readOnly
          value={templateFile}
          placeholder="No file selected"
          className="flex-1 px-3 py-2 rounded bg-ink-900/60 border border-ink-700 text-sm font-mono text-slate-300"
        />
        <input ref={fileInputRef} type="file" accept=".xlsx" className="hidden" onChange={onFileChange} />
        <button onClick={chooseFile} className="px-3 py-2 rounded bg-ink-700 hover:bg-ink-600 text-sm">
          Browse...
        </button>
      </div>

      <Section title="Document Destination Folder" />
      <FolderPicker value={outputDir} onChange={setOutputDir} onBrowse={() => chooseDir(setOutputDir)} />

      <Section title="Folder Source: organized folders from Tab 1" />
      <FolderPicker value={destDir} onChange={setDestDir} onBrowse={() => chooseDir(setDestDir)} />

      <div className="flex items-center justify-between gap-4">
        <StatusDisplay status={status} running={running} />
        <ActionButton onClick={handleGenerate} disabled={!canRun} color="good" icon={<Play size={14} />}>
          {running ? "Generating..." : "Generate SG Check Document"}
        </ActionButton>
      </div>

      <LogBox logs={logs} logEndRef={logEndRef} />
    </div>
  );
}

// =============================================================================
// Shared UI bits
// =============================================================================
function Section({ title }) {
  return (
    <h2 className="font-semibold flex items-center gap-2 text-slate-200">
      <FolderOpen size={14} className="text-accent-400" /> {title}
    </h2>
  );
}

function FolderPicker({ value, onChange, onBrowse }) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Click 'Browse' to choose the folder"
        className="flex-1 px-3 py-2 rounded bg-ink-900/60 border border-ink-700 text-sm font-mono text-slate-300"
      />
      <button
        onClick={onBrowse}
        className="px-3 py-2 rounded bg-ink-700 hover:bg-ink-600 text-sm"
      >
        Browse
      </button>
    </div>
  );
}

function ActionButton({ onClick, disabled, color, icon, children }) {
  const colors = {
    good: "bg-good hover:bg-good/90 text-white",
    bad: "bg-bad hover:bg-bad/90 text-white",
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-2 px-4 py-2 rounded font-medium ${
        disabled ? "bg-ink-700 text-slate-500 cursor-not-allowed" : colors[color] || colors.good
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

function StatusDisplay({ status, running }) {
  const colors = {
    info: "text-accent-400",
    good: "text-good",
    warn: "text-warn",
    bad:  "text-bad",
  };
  return (
    <div className="flex-1">
      <div className={`text-sm font-medium ${colors[status.color]}`}>
        {running && <Loader2 size={14} className="inline animate-spin mr-1" />}
        {status.text}
      </div>
    </div>
  );
}

function LogBox({ logs, logEndRef }) {
  return (
    <section className="bg-ink-800/40 border border-ink-700 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-ink-700">
        <h2 className="font-semibold">Log</h2>
        <button
          disabled={logs.length === 0}
          onClick={() => {}}
          className="text-xs text-slate-400 hover:text-slate-200 disabled:opacity-30"
        >
          Clear
        </button>
      </div>
      <div className="bg-black/30 font-mono text-xs text-slate-200 p-3 max-h-80 overflow-y-auto whitespace-pre-wrap">
        {logs.length === 0 ? (
          <span className="text-slate-500">Log output will appear here.</span>
        ) : (
          logs.map((l, i) => <div key={i}>{l.msg}</div>)
        )}
        <div ref={logEndRef} />
      </div>
    </section>
  );
}

// Join paths using the platform separator (Windows: \\, Mac/Linux: /).
function joinPath(dir, name) {
  if (!dir) return name;
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + sep + name;
}
