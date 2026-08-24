import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  FileSpreadsheet,
  CheckCircle2,
  AlertCircle,
  Loader2,
  FlaskConical,
  FolderOpen,
  Play,
  Plus,
  X,
  Settings,
} from "lucide-react";
import {
  readLigationLayout,
  readPrimerLog,
  buildSummary,
  uniqueJobDetails,
} from "./extractor.js";
import { planPlates } from "./platePlanner.js";
import { buildWorkbook, buildOutputFilename, serializeWorkbook } from "./workbookBuilder.js";

/**
 * Colony PCR Layout — React port.
 *
 * Behaviour parity with the Tkinter original:
 *   1. Pick one or more Ligation Layout files (sheet 'Layout').
 *   2. Pick a Primer Log (sheet 'input addon') — auto-detected by the hub.
 *   3. Pick a Colony PCR Layout template — auto-detected by the hub.
 *   4. App reads files, builds summary data, shows a modal with a
 *      clone-count spinner per (JobID, SourceFile).
 *   5. On confirm, runs planPlates() + buildWorkbook() + writes the .xlsx
 *      to <output_dir>/<output_filename>.
 */
export default function ColonyPCRLayout({ onBack, initialPaths }) {
  const [ligationFiles, setLigationFiles] = useState([]);
  const [primerLogPath, setPrimerLogPath] = useState(initialPaths?.primer_log_path || "");
  const [templatePath, setTemplatePath] = useState(initialPaths?.colony_pcr_template_path || "");
  const [outputDir, setOutputDir] = useState("");

  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState({ text: "Ready", color: "info" });
  const [logs, setLogs] = useState([]);

  // Modal state: when set, the clone-count dialog is open with these job details.
  const [modalOpen, setModalOpen] = useState(false);
  const [pendingJobDetails, setPendingJobDetails] = useState([]);
  const [pendingCloneCounts, setPendingCloneCounts] = useState({}); // (jobId|file) -> number

  const ligationInputRef = useRef(null);
  const primerLogInputRef = useRef(null);
  const templateInputRef = useRef(null);
  const logEndRef = useRef(null);

  useEffect(() => {
    if (initialPaths?.colony_pcr_template_path) setTemplatePath(initialPaths.colony_pcr_template_path);
  }, [initialPaths]);

  useEffect(() => {
    if (logEndRef.current) logEndRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [logs]);

  const appendLog = (msg) => setLogs((prev) => [...prev, { msg, t: Date.now() }]);

  const canGenerate = ligationFiles.length > 0 && primerLogPath && templatePath && !running;

  // -------- file pickers --------
  const chooseLigationFiles = async () => {
    if (!window.api.chooseFile) return;
    // Show native multi-select; the IPC returns just one path. Use the
    // hidden <input type=file multiple> as a fallback for multi-pick.
    ligationInputRef.current?.click();
  };
  const onLigationInputChange = (e) => {
    const files = Array.from(e.target.files || []);
    setLigationFiles((prev) => {
      const next = [...prev];
      for (const f of files) {
        if (!next.some((p) => p.name === f.name)) next.push(f);
      }
      return next;
    });
    e.target.value = "";
  };
  const choosePrimerLog = async () => primerLogInputRef.current?.click();
  const chooseTemplate = async () => templateInputRef.current?.click();
  const chooseOutputDir = async () => {
    const picked = await window.api.chooseOutputDir(outputDir);
    if (picked) setOutputDir(picked);
  };

  // -------- generate flow --------
  const handleGenerate = async () => {
    if (!canGenerate) return;
    setRunning(true);
    setLogs([]);
    setStatus({ text: "Loading files...", color: "info" });

    try {
      // Step 1: read primer log
      const plFile = await readFileAsArrayBuffer(primerLogPath);
      const primerMap = readPrimerLog(plFile);
      appendLog(`Primer Log loaded (${Object.keys(primerMap).length} JobIDs).`);

      // Step 2: read each ligation file
      let allRows = [];
      for (const lf of ligationFiles) {
        const lfBuf = await readFileAsArrayBuffer(lf.path);
        const rows = readLigationLayout(lfBuf, lf.path);
        appendLog(`Loaded ${rows.length} rows from ${baseName(lf.path)}.`);
        allRows = allRows.concat(rows);
      }

      // Step 3: build summary data
      const { rows: summaryRows, warnings } = buildSummary(allRows, primerMap);
      for (const w of warnings) appendLog(`WARNING: ${w}`);
      appendLog(`Summary data: ${summaryRows.length} unique job entries.`);

      if (summaryRows.length === 0) {
        appendLog("ERROR: No valid ligation rows found.");
        setStatus({ text: "No ligation rows found.", color: "bad" });
        setRunning(false);
        return;
      }

      // Step 4: ask the user for clone counts via the modal.
      const details = uniqueJobDetails(summaryRows);
      const initial = {};
      for (const d of details) initial[makeKey(d.JobID, d.SourceFile)] = 4;
      setPendingJobDetails(details);
      setPendingCloneCounts(initial);
      setRunning(false);
      setModalOpen(true);
    } catch (err) {
      appendLog(`ERROR: ${err.message}`);
      setStatus({ text: `Error: ${err.message}`, color: "bad" });
      setRunning(false);
    }
  };

  // -------- modal handlers --------
  const onConfirmClones = async () => {
    setModalOpen(false);
    setRunning(true);

    try {
      // Re-read everything (state was cleared during the modal).
      const plFile = await readFileAsArrayBuffer(primerLogPath);
      const primerMap = readPrimerLog(plFile);

      let allRows = [];
      for (const lf of ligationFiles) {
        const lfBuf = await readFileAsArrayBuffer(lf.path);
        const rows = readLigationLayout(lfBuf, lf.path);
        allRows = allRows.concat(rows);
      }
      const { rows: summaryRows } = buildSummary(allRows, primerMap);

      // Build clone-counts Map for the planner.
      const counts = new Map();
      for (const [key, val] of Object.entries(pendingCloneCounts)) {
        if (val > 0) counts.set(key, val);
      }

      // Plan plates
      const plan = planPlates(summaryRows, counts);
      appendLog(`Planned ${plan.plates.length} plate(s).`);
      for (let i = 0; i < plan.plates.length; i++) {
        const p = plan.plates[i];
        appendLog(`  Plate ${i + 1}: ${p.jobs.length} clones + ${p.controls.length} controls.`);
      }

      // Build workbook
      const wb = buildWorkbook(plan, summaryRows);
      const bytes = serializeWorkbook(wb);

      // Choose output dir if user didn't pick one
      let destDir = outputDir;
      if (!destDir) {
        destDir = await window.api.chooseOutputDir("");
        if (!destDir) {
          appendLog("Aborted: no output folder selected.");
          setStatus({ text: "Cancelled — no output folder.", color: "warn" });
          setRunning(false);
          return;
        }
        setOutputDir(destDir);
      }

      const filename = buildOutputFilename(new Date());
      const sep = destDir.includes("\\") && !destDir.includes("/") ? "\\" : "/";
      const outPath = `${destDir}${sep}${filename}`;
      const writeResult = await window.api.writeBinaryFile({ filePath: outPath, bytes });
      if (!writeResult?.ok) {
        appendLog(`ERROR saving file: ${writeResult.error}`);
        setStatus({ text: `Save failed: ${writeResult.error}`, color: "bad" });
        setRunning(false);
        return;
      }

      appendLog(`Saved: ${outPath}`);
      appendLog("\n--- Processing Finished ---");
      setStatus({
        text: `Done. ${plan.plates.length} plate(s) saved to ${filename}.`,
        color: "good",
      });
    } catch (err) {
      appendLog(`ERROR: ${err.message}`);
      setStatus({ text: `Error: ${err.message}`, color: "bad" });
    } finally {
      setRunning(false);
    }
  };

  const onCancelClones = () => {
    setModalOpen(false);
    setStatus({ text: "Cancelled — no clone counts set.", color: "warn" });
  };

  // -------- render --------
  const statusColors = {
    info: "text-accent-400",
    good: "text-good",
    warn: "text-warn",
    bad: "text-bad",
  };

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
            <FlaskConical size={18} className="text-accent-400" />
          </div>
          <div>
            <h1 className="font-semibold text-lg leading-tight">Colony PCR Layout</h1>
            <p className="text-[11px] text-slate-400 leading-tight">
              Reads Ligation Layouts, fills Colony PCR template.
            </p>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-6 space-y-5">
        {/* Ligation files */}
        <section className="bg-ink-800/40 border border-ink-700 rounded-lg p-4">
          <h2 className="font-semibold mb-2 flex items-center gap-2">
            <FileSpreadsheet size={16} className="text-accent-400" /> Ligation Layout Files
          </h2>
          <div className="flex gap-2 items-start">
            <div className="flex-1 bg-ink-900/60 border border-ink-700 rounded p-2 text-xs min-h-[80px]">
              {ligationFiles.length === 0 ? (
                <div className="text-slate-500 italic">No files selected</div>
              ) : (
                ligationFiles.map((f, i) => (
                  <div key={i} className="flex items-center justify-between py-0.5">
                    <span className="font-mono">{baseName(f.path)}</span>
                    <button
                      onClick={() => setLigationFiles((prev) => prev.filter((_, j) => j !== i))}
                      className="text-slate-400 hover:text-bad"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="flex flex-col gap-1">
              <input
                ref={ligationInputRef}
                type="file"
                accept=".xlsx,.xlsm"
                multiple
                className="hidden"
                onChange={onLigationInputChange}
              />
              <button
                onClick={chooseLigationFiles}
                className="px-3 py-2 rounded bg-ink-700 hover:bg-ink-600 text-sm inline-flex items-center gap-1"
              >
                <Plus size={12} /> Add...
              </button>
              <button
                onClick={() => setLigationFiles([])}
                className="px-3 py-2 rounded bg-ink-700 hover:bg-ink-600 text-sm"
              >
                Clear
              </button>
            </div>
          </div>
        </section>

        {/* Primer Log */}
        <section className="bg-ink-800/40 border border-ink-700 rounded-lg p-4">
          <h2 className="font-semibold mb-2 flex items-center gap-2">
            <FileSpreadsheet size={16} className="text-accent-400" /> Primer Log
          </h2>
          <FilePickerRow
            inputRef={primerLogInputRef}
            value={primerLogPath}
            onPick={(f) => setPrimerLogPath(f.path)}
            onBrowse={choosePrimerLog}
          />
        </section>

        {/* Colony PCR Template */}
        <section className="bg-ink-800/40 border border-ink-700 rounded-lg p-4">
          <h2 className="font-semibold mb-2 flex items-center gap-2">
            <FileSpreadsheet size={16} className="text-accent-400" /> Colony PCR Layout Template
          </h2>
          <FilePickerRow
            inputRef={templateInputRef}
            value={templatePath}
            onPick={(f) => setTemplatePath(f.path)}
            onBrowse={chooseTemplate}
          />
        </section>

        {/* Output Folder */}
        <section className="bg-ink-800/40 border border-ink-700 rounded-lg p-4">
          <h2 className="font-semibold mb-2 flex items-center gap-2">
            <FolderOpen size={16} className="text-accent-400" /> Output Folder
          </h2>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={outputDir}
              onChange={(e) => setOutputDir(e.target.value)}
              placeholder="Defaults to the same folder as your first ligation file"
              className="flex-1 px-3 py-2 rounded bg-ink-900/60 border border-ink-700 text-sm font-mono text-slate-300"
            />
            <button onClick={chooseOutputDir} className="px-3 py-2 rounded bg-ink-700 hover:bg-ink-600 text-sm">
              Browse
            </button>
          </div>
        </section>

        {/* Generate */}
        <section className="flex items-center justify-between gap-4">
          <div className="flex-1">
            <div className={`text-sm font-medium ${statusColors[status.color]}`}>
              {running && <Loader2 size={14} className="inline animate-spin mr-1" />}
              {status.text}
            </div>
          </div>
          <button
            disabled={!canGenerate}
            onClick={handleGenerate}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded font-medium ${
              canGenerate
                ? "bg-good hover:bg-good/90 text-white"
                : "bg-ink-700 text-slate-500 cursor-not-allowed"
            }`}
          >
            <Play size={14} />
            {running ? "Working..." : "Generate Layout"}
          </button>
        </section>

        {/* Log */}
        <section className="bg-ink-800/40 border border-ink-700 rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-ink-700">
            <h2 className="font-semibold">Log</h2>
            <button
              disabled={logs.length === 0}
              onClick={() => setLogs([])}
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
      </main>

      {modalOpen && (
        <CloneCountModal
          jobDetails={pendingJobDetails}
          values={pendingCloneCounts}
          onChange={setPendingCloneCounts}
          onConfirm={onConfirmClones}
          onCancel={onCancelClones}
        />
      )}
    </div>
  );
}

// =============================================================================
// Clone Count modal — replaces the Tkinter CloneCountDialog + CTkSpinBox.
// =============================================================================
function CloneCountModal({ jobDetails, values, onChange, onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="bg-ink-800 border border-ink-700 rounded-lg max-w-3xl w-full max-h-[80vh] flex flex-col">
        <header className="px-5 py-3 border-b border-ink-700 flex items-center gap-2">
          <Settings size={16} className="text-accent-400" />
          <h2 className="font-semibold">Number of Clones per Job</h2>
        </header>

        <div className="flex-1 overflow-y-auto p-3">
          {/* Header */}
          <div className="grid grid-cols-[90px_80px_80px_60px_180px_100px] gap-2 px-2 py-1 text-xs font-bold text-slate-300 border-b border-ink-700 mb-2">
            <div>JobID</div>
            <div>BBID</div>
            <div>Vector</div>
            <div>Length</div>
            <div>Ligation File</div>
            <div># Clones</div>
          </div>

          {jobDetails.map((d, i) => {
            const key = makeKey(d.JobID, d.SourceFile);
            const val = values[key] ?? 4;
            return (
              <div
                key={i}
                className={`grid grid-cols-[90px_80px_80px_60px_180px_100px] gap-2 px-2 py-1 text-xs items-center ${
                  i % 2 === 0 ? "bg-ink-900/30" : ""
                }`}
              >
                <div className="font-mono">{d.JobID}</div>
                <div className="font-mono">{d.BBID}</div>
                <div className="font-mono">{d.Vector}</div>
                <div className="font-mono">{d.Length}</div>
                <div className="font-mono truncate" title={d.SourceFile}>
                  {truncate(baseName(d.SourceFile), 25)}
                </div>
                <div className="inline-flex items-center gap-1">
                  <button
                    onClick={() => onChange({ ...values, [key]: Math.max(0, val - 1) })}
                    className="w-7 h-7 rounded bg-ink-700 hover:bg-ink-600 text-sm"
                  >
                    -
                  </button>
                  <input
                    type="number"
                    min={0}
                    max={96}
                    value={val}
                    onChange={(e) => {
                      const n = Math.max(0, Math.min(96, parseInt(e.target.value, 10) || 0));
                      onChange({ ...values, [key]: n });
                    }}
                    className="w-14 text-center px-1 py-1 rounded bg-ink-900/60 border border-ink-700 text-xs"
                  />
                  <button
                    onClick={() => onChange({ ...values, [key]: Math.min(96, val + 1) })}
                    className="w-7 h-7 rounded bg-ink-700 hover:bg-ink-600 text-sm"
                  >
                    +
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <footer className="px-5 py-3 border-t border-ink-700 flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-2 rounded bg-ink-700 hover:bg-ink-600 text-sm">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 rounded bg-good hover:bg-good/90 text-white font-medium"
          >
            Confirm
          </button>
        </footer>
      </div>
    </div>
  );
}

// =============================================================================
// Helpers
// =============================================================================
function FilePickerRow({ inputRef, value, onPick, onBrowse }) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        readOnly
        value={value}
        placeholder="No file selected"
        className="flex-1 px-3 py-2 rounded bg-ink-900/60 border border-ink-700 text-sm font-mono text-slate-300"
      />
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xlsm"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
          e.target.value = "";
        }}
      />
      <button onClick={onBrowse} className="px-3 py-2 rounded bg-ink-700 hover:bg-ink-600 text-sm">
        Select
      </button>
    </div>
  );
}

async function readFileAsArrayBuffer(path) {
  // If the caller is passing a File object (from <input type=file>), use it directly.
  // Otherwise, go through the IPC handler.
  if (typeof File !== "undefined" && path instanceof File) {
    return await path.arrayBuffer();
  }
  const r = await window.api.readBinaryFile({ filePath: path });
  if (!r?.ok) throw new Error(r?.error || "Failed to read file");
  return r.bytes;
}

function baseName(p) {
  if (!p) return "";
  return p.split(/[\\/]/).pop();
}

function truncate(s, n) {
  return s && s.length > n ? s.slice(0, n - 3) + "..." : s;
}

function makeKey(jobId, sourceFile) {
  return `${jobId}\0${sourceFile}`;
}
