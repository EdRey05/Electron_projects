import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  FileSpreadsheet,
  Loader2,
  FolderOpen,
  Play,
  Plus,
  X,
  Database,
  ListChecks,
  ClipboardList,
  Settings,
  FlaskConical,
} from "lucide-react";
import {
  extractVectorDbLookups,
  extractJobLogInfo,
  extractFragments,
  applyManualEntries,
  buildLayoutRowsWithControls,
  generateSheetPrefixes,
  generateOutputFilename,
} from "./extractor.js";
import { matchFragmentsToJobs } from "./matcher.js";
import { writeLayoutRows, writeFragmentsToLayout, serializeWorkbook } from "./workbookBuilder.js";

// Common vectors shown at the top of the manual-entry dropdown.
const COMMON_VECTORS = [
  "pUC57-Amp",
  "pUC57-Kan",
  "pUC19",
  "pcDNA3.1(+)",
  "pUCm-T",
  "pBluescript II KS+",
  "pBluescript II SK+",
  "pET-28a(+)",
];

/**
 * Ligation Layout — React port.
 *
 * Behaviour parity with the Tkinter original:
 *   1. Pick Job Log + Fragments + Vector DB + Ligation Template.
 *   2. Paste a list of Job IDs (one per line).
 *   3. Optional: add per-job special Host/Temperature conditions.
 *   4. Click Generate. App reads files, builds lookups, finds
 *      missing-from-log or placeholder jobs, and (if any) opens
 *      the manual-vector-entry modal.
 *   5. After manual entries, builds layout rows + matches fragments,
 *      writes everything to a fresh .xlsx workbook based on the template,
 *      and saves as `{yearChar}{MMDD}-Ligation-FL.xlsx` via native dialog.
 */
export default function LigationLayout({ onBack, initialPaths }) {
  const [jobLogPath, setJobLogPath] = useState(initialPaths?.job_log_path || "");
  const [fragmentsPath, setFragmentsPath] = useState(initialPaths?.fragments_log_path || "");
  const [templatePath, setTemplatePath] = useState(initialPaths?.ligation_template_path || "");
  const [vectorDbPath, setVectorDbPath] = useState(initialPaths?.vector_db_path || "");

  const [jobIdsText, setJobIdsText] = useState("");
  const [conditions, setConditions] = useState([]); // [{ jobId, host, temperature }]

  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState({ text: "Ready", color: "info" });
  const [logs, setLogs] = useState([]);

  // Modal: when set, the manual vector entry dialog is open with these job IDs.
  const [manualOpen, setManualOpen] = useState(false);
  const [pendingManualJobs, setPendingManualJobs] = useState([]);
  const [manualResults, setManualResults] = useState({});

  const jobLogInputRef = useRef(null);
  const fragmentsInputRef = useRef(null);
  const templateInputRef = useRef(null);
  const vectorDbInputRef = useRef(null);
  const logEndRef = useRef(null);

  useEffect(() => {
    if (initialPaths?.ligation_template_path) setTemplatePath(initialPaths.ligation_template_path);
    if (initialPaths?.vector_db_path) setVectorDbPath(initialPaths.vector_db_path);
  }, [initialPaths]);
  useEffect(() => {
    if (logEndRef.current) logEndRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [logs]);

  const appendLog = (msg) => setLogs((prev) => [...prev, { msg, t: Date.now() }]);

  const canGenerate =
    jobLogPath && fragmentsPath && templatePath && vectorDbPath && !running;

  const jobIdsList = useMemo(
    () => jobIdsText.split("\n").map((s) => s.trim()).filter(Boolean),
    [jobIdsText]
  );
  const canGenerateWithIds = canGenerate && jobIdsList.length > 0;

  // -------- generate flow --------
  const handleGenerate = async () => {
    if (!canGenerate) return;
    if (jobIdsList.length === 0) {
      setStatus({ text: "Please paste Job IDs first.", color: "warn" });
      return;
    }
    setRunning(true);
    setLogs([]);
    setStatus({ text: "Loading files...", color: "info" });

    try {
      // Step 0: Load vector DB lookups
      appendLog("Loading vector database lookups...");
      const vdbBuf = await readFileAsArrayBuffer(vectorDbPath);
      const lookups = extractVectorDbLookups(vdbBuf);
      appendLog(`  Resistance lookup: ${Object.keys(lookups.resistance).length} entries.`);
      appendLog(`  Length map: ${Object.keys(lookups.length).length} entries.`);
      appendLog(`  Digested vectors: ${Object.keys(lookups.digested).length} entries.`);

      // Step 1: Extract Job Log info
      appendLog("\nExtracting Job ID information from Job Log...");
      const jlBuf = await readFileAsArrayBuffer(jobLogPath);
      const jobExtraction = extractJobLogInfo(jlBuf, jobIdsList);
      appendLog(`  Found ${Object.keys(jobExtraction.rows).length} jobs in log.`);
      appendLog(`  Missing from log: ${jobExtraction.missing_from_log.length}.`);
      appendLog(`  Jobs needing manual entry: ${jobExtraction.jobs_needing_manual_entry.length}.`);

      // If anything needs manual entry, open the modal and pause.
      const allManualJobs = [
        ...jobExtraction.jobs_needing_manual_entry,
        ...jobExtraction.missing_from_log,
      ];
      if (allManualJobs.length > 0) {
        const initialManual = {};
        for (const jid of allManualJobs) initialManual[jid] = { vector: "", enzyme: "", resistance: "" };
        setPendingManualJobs(allManualJobs);
        setManualResults(initialManual);
        setManualOpen(true);
        setStatus({
          text: `Manual vector entry required for ${allManualJobs.length} job(s).`,
          color: "warn",
        });
        setRunning(false);
        return;
      }

      // No manual entry needed -> proceed immediately.
      await runFinalSteps(lookups, jobExtraction, {});
    } catch (err) {
      appendLog(`ERROR: ${err.message}`);
      setStatus({ text: `Error: ${err.message}`, color: "bad" });
      setRunning(false);
    }
  };

  const onConfirmManual = async () => {
    setManualOpen(false);
    setRunning(true);
    try {
      appendLog("\nLoading vector database lookups...");
      const vdbBuf = await readFileAsArrayBuffer(vectorDbPath);
      const lookups = extractVectorDbLookups(vdbBuf);

      appendLog("Extracting Job ID information from Job Log...");
      const jlBuf = await readFileAsArrayBuffer(jobLogPath);
      const jobExtraction = extractJobLogInfo(jlBuf, jobIdsList);

      // Filter out manual jobs that weren't filled in
      const filteredManualResults = {};
      for (const [jid, m] of Object.entries(manualResults)) {
        if (m.vector && m.vector.trim()) filteredManualResults[jid] = m;
        else appendLog(`  WARNING: ${jid} skipped (no vector entered).`);
      }
      await runFinalSteps(lookups, jobExtraction, filteredManualResults);
    } catch (err) {
      appendLog(`ERROR: ${err.message}`);
      setStatus({ text: `Error: ${err.message}`, color: "bad" });
      setRunning(false);
    }
  };

  const onCancelManual = () => {
    setManualOpen(false);
    setStatus({ text: "Cancelled — manual vector entry aborted.", color: "warn" });
  };

  // The post-extraction flow: build rows, match fragments, write workbook.
  const runFinalSteps = async (lookups, jobExtraction, manual) => {
    // Step 1.5: Apply manual entries
    const finalRows = applyManualEntries(jobExtraction, manual);
    appendLog(`Final rows after manual entries: ${finalRows.length}.`);

    // Step 2: Build layout rows with controls + special conditions
    const conditionsMap = {};
    for (const c of conditions) {
      if (c.jobId) conditionsMap[c.jobId] = { host: c.host, temperature: c.temperature };
    }
    const layoutRows = buildLayoutRowsWithControls(finalRows, conditionsMap);
    appendLog(`Layout rows (with controls): ${layoutRows.length}.`);

    // Step 3: Extract fragments
    appendLog("\nSearching for fragment data...");
    const fragmentsBuf = await readFileAsArrayBuffer(fragmentsPath);
    const sheetPrefixes = generateSheetPrefixes(new Date());
    appendLog(`  Searching for sheets with prefixes: ${sheetPrefixes}`);
    const fragments = extractFragments(fragmentsBuf, sheetPrefixes);
    appendLog(`  Found ${fragments.length} fragment rows.`);

    // Step 4: Match fragments to jobs
    appendLog("\nMatching fragments to jobs...");
    const fragmentsToWrite = matchFragmentsToJobs(layoutRows, fragments);
    appendLog(`  Matched fragments for ${Object.keys(fragmentsToWrite).length} job(s).`);

    // Step 5: Load template + write
    appendLog("\nLoading ligation template...");
    const tplBuf = await readFileAsArrayBuffer(templatePath);
    const XLSX = await import("xlsx");
    const wb = XLSX.read(tplBuf, { type: "array" });

    appendLog("Writing layout rows...");
    const { insertColumns } = writeLayoutRows(wb, layoutRows, lookups);

    if (Object.keys(insertColumns).length === 0) {
      appendLog("  WARNING: Could not find 'Insert 1/2/3' columns. Skipping fragment writing.");
    } else {
      appendLog(`  Found Insert columns: ${Object.keys(insertColumns).join(", ")}`);
      appendLog("Writing fragments...");
      const manualJobIds = new Set(layoutRows.filter((r) => r.is_manual).map((r) => r.job_id));
      const fr = writeFragmentsToLayout(
        wb,
        insertColumns,
        fragmentsToWrite,
        manualJobIds,
        lookups.length
      );
      appendLog(`  Wrote ${fr.written.length} fragment entries.`);
    }

    // Step 6: Save
    const bytes = serializeWorkbook(wb);
    const filename = generateOutputFilename(new Date());
    appendLog(`\nSuggested filename: ${filename}`);
    appendLog("Prompting for save location...");
    const saved = await window.api.saveResultsXlsx?.(filename, bytes);
    if (saved) {
      appendLog(`File successfully saved to: ${saved}`);
      appendLog("\n--- Processing Finished ---");
      setStatus({ text: `Done. Saved to ${baseName(saved)}.`, color: "good" });
    } else {
      appendLog("Save cancelled (or saveResultsXlsx IPC not available).");
      setStatus({ text: "Save cancelled.", color: "warn" });
    }
  };

  const removeCondition = (idx) => setConditions((prev) => prev.filter((_, i) => i !== idx));
  const addCondition = () =>
    setConditions((prev) => [...prev, { jobId: "", host: "TOP10", temperature: "37C" }]);

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
            <h1 className="font-semibold text-lg leading-tight">Ligation Layout</h1>
            <p className="text-[11px] text-slate-400 leading-tight">
              Generates a Ligation Layout .xlsx from Job Log + Fragments + Vector DB.
            </p>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-6 space-y-5">
        {/* File pickers */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FilePicker
            label="Job Log"
            inputRef={jobLogInputRef}
            value={jobLogPath}
            onPick={(f) => setJobLogPath(f.path)}
            icon={<FileSpreadsheet size={14} />}
          />
          <FilePicker
            label="Fragments File"
            inputRef={fragmentsInputRef}
            value={fragmentsPath}
            onPick={(f) => setFragmentsPath(f.path)}
            icon={<FileSpreadsheet size={14} />}
          />
          <FilePicker
            label="Ligation Layout Template"
            inputRef={templateInputRef}
            value={templatePath}
            onPick={(f) => setTemplatePath(f.path)}
            icon={<FileSpreadsheet size={14} />}
          />
          <FilePicker
            label="Vector Database (.xlsx)"
            inputRef={vectorDbInputRef}
            value={vectorDbPath}
            onPick={(f) => setVectorDbPath(f.path)}
            icon={<Database size={14} />}
          />
        </section>

        {/* Job IDs textarea */}
        <section className="bg-ink-800/40 border border-ink-700 rounded-lg p-4">
          <h2 className="font-semibold mb-2 flex items-center gap-2">
            <ClipboardList size={16} className="text-accent-400" /> Job IDs (one per line)
          </h2>
          <textarea
            value={jobIdsText}
            onChange={(e) => setJobIdsText(e.target.value)}
            placeholder={"JOB-001\nJOB-002\nJOB-003"}
            rows={6}
            className="w-full px-3 py-2 rounded bg-ink-900/60 border border-ink-700 text-sm font-mono text-slate-300"
          />
          <div className="text-xs text-slate-400 mt-1">
            {jobIdsList.length} Job ID(s) parsed.
          </div>
        </section>

        {/* Conditions list */}
        <section className="bg-ink-800/40 border border-ink-700 rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="font-semibold flex items-center gap-2">
              <Settings size={16} className="text-accent-400" /> Special Conditions (optional)
            </h2>
            <button
              onClick={addCondition}
              className="px-3 py-1 rounded bg-ink-700 hover:bg-ink-600 text-xs inline-flex items-center gap-1"
            >
              <Plus size={12} /> Add
            </button>
          </div>
          {conditions.length === 0 ? (
            <div className="text-xs text-slate-500 italic">
              Default: every job uses TOP10 host at 37°C. Add a row here to override.
            </div>
          ) : (
            <div className="grid grid-cols-[1fr_1fr_1fr_30px] gap-2">
              <div className="text-xs font-bold text-slate-300">Job ID</div>
              <div className="text-xs font-bold text-slate-300">Host</div>
              <div className="text-xs font-bold text-slate-300">Temperature</div>
              <div></div>
              {conditions.map((c, i) => (
                <React.Fragment key={i}>
                  <input
                    type="text"
                    value={c.jobId}
                    onChange={(e) =>
                      setConditions((prev) => prev.map((row, j) => (j === i ? { ...row, jobId: e.target.value } : row)))
                    }
                    placeholder="JOB-ID"
                    className="px-2 py-1 rounded bg-ink-900/60 border border-ink-700 text-xs font-mono"
                  />
                  <input
                    type="text"
                    value={c.host}
                    onChange={(e) =>
                      setConditions((prev) => prev.map((row, j) => (j === i ? { ...row, host: e.target.value } : row)))
                    }
                    className="px-2 py-1 rounded bg-ink-900/60 border border-ink-700 text-xs"
                  />
                  <input
                    type="text"
                    value={c.temperature}
                    onChange={(e) =>
                      setConditions((prev) => prev.map((row, j) => (j === i ? { ...row, temperature: e.target.value } : row)))
                    }
                    className="px-2 py-1 rounded bg-ink-900/60 border border-ink-700 text-xs"
                  />
                  <button onClick={() => removeCondition(i)} className="text-slate-400 hover:text-bad">
                    <X size={14} />
                  </button>
                </React.Fragment>
              ))}
            </div>
          )}
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
            disabled={!canGenerateWithIds}
            onClick={handleGenerate}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded font-medium ${
              canGenerateWithIds
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

      {manualOpen && (
        <ManualVectorModal
          jobIds={pendingManualJobs}
          values={manualResults}
          onChange={setManualResults}
          vectorNames={COMMON_VECTORS}
          onConfirm={onConfirmManual}
          onCancel={onCancelManual}
        />
      )}
    </div>
  );
}

// =============================================================================
// Manual Vector Modal — mirrors BulkManualVectorDialog.
// =============================================================================
function ManualVectorModal({ jobIds, values, onChange, vectorNames, onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="bg-ink-800 border border-ink-700 rounded-lg max-w-4xl w-full max-h-[80vh] flex flex-col">
        <header className="px-5 py-3 border-b border-ink-700 flex items-center gap-2">
          <ListChecks size={16} className="text-accent-400" />
          <h2 className="font-semibold">Manual Vector Entry</h2>
          <span className="text-xs text-slate-400 ml-2">{jobIds.length} job(s)</span>
        </header>

        <div className="flex-1 overflow-y-auto p-3">
          <div className="grid grid-cols-[120px_1fr_1fr_120px] gap-2 px-2 py-1 text-xs font-bold text-slate-300 border-b border-ink-700 mb-2 sticky top-0 bg-ink-800">
            <div>Job ID</div>
            <div>Vector Name</div>
            <div>Cloning Site</div>
            <div>Resistance</div>
          </div>

          {jobIds.map((jid) => {
            const v = values[jid] || { vector: "", enzyme: "", resistance: "" };
            return (
              <div
                key={jid}
                className="grid grid-cols-[120px_1fr_1fr_120px] gap-2 px-2 py-1 text-xs items-center"
              >
                <div className="font-mono">{jid}</div>
                <input
                  type="text"
                  list={`vec-${jid}`}
                  value={v.vector}
                  onChange={(e) => onChange({ ...values, [jid]: { ...v, vector: e.target.value } })}
                  placeholder="e.g. pUC19"
                  className="px-2 py-1 rounded bg-ink-900/60 border border-ink-700"
                />
                <datalist id={`vec-${jid}`}>
                  {vectorNames.map((vn) => <option key={vn} value={vn} />)}
                </datalist>
                <input
                  type="text"
                  value={v.enzyme}
                  onChange={(e) => onChange({ ...values, [jid]: { ...v, enzyme: e.target.value } })}
                  placeholder="e.g. EcoRI"
                  className="px-2 py-1 rounded bg-ink-900/60 border border-ink-700"
                />
                <input
                  type="text"
                  value={v.resistance}
                  onChange={(e) => onChange({ ...values, [jid]: { ...v, resistance: e.target.value } })}
                  placeholder="e.g. Amp"
                  className="px-2 py-1 rounded bg-ink-900/60 border border-ink-700"
                />
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
            Apply
          </button>
        </footer>
      </div>
    </div>
  );
}

// =============================================================================
// Shared file picker
// =============================================================================
function FilePicker({ label, inputRef, value, onPick, icon }) {
  return (
    <div className="bg-ink-800/40 border border-ink-700 rounded-lg p-4">
      <h2 className="font-semibold mb-2 flex items-center gap-2">
        {icon} {label}
      </h2>
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
        <button
          onClick={() => inputRef.current?.click()}
          className="px-3 py-2 rounded bg-ink-700 hover:bg-ink-600 text-sm"
        >
          Select
        </button>
      </div>
    </div>
  );
}

async function readFileAsArrayBuffer(path) {
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
