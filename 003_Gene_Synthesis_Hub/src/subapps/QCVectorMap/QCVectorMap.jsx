import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  FileSpreadsheet,
  CheckCircle2,
  AlertCircle,
  Loader2,
  FlaskConical,
  FolderOpen,
  Download,
} from "lucide-react";
import {
  loadPrimerLogSheets,
  primerLogHasRequiredSheets,
  getRowForJobId,
  getFieldFromRow,
} from "./excelHelpers.js";
import { buildGenbank } from "./genbankWriter.js";

/**
 * QC Vector Map Prep — React port of `vector_map_prep_biopython.py`.
 *
 * Behaviour parity:
 *   - User picks a Primer Log .xlsx (validated to contain `input addon` and/or
 *     `Obsolete input addon(completed)` sheets).
 *   - User picks an output folder via Electron's `dialog:showOpenDialog`.
 *   - User pastes JobIDs (one per line).
 *   - For each JobID: locate the row in either relevant sheet, pull
 *     `Final Vector` (col I, fallback index 8) and `Insert Seq` (col H,
 *     fallback index 7), emit a GenBank file with the insert annotated
 *     (single feature for in-frame inserts, two features for wrap-around).
 *
 * Differences from the Tkinter original:
 *   - No thread: the loop runs async/await with `setTimeout(0)` yields so
 *     the log textbox keeps rendering per-JobID.
 *   - Output is one folder for all JobIDs; user picks once via the OS dialog
 *     rather than the Tkinter filedialog.
 *   - SnapGene automation workflow is NOT ported (see BUILD.md "Why this
 *     split" — it requires pyautogui + win32gui which have no JS analogue).
 */
export default function QCVectorMap({ onBack, initialPaths }) {
  const [primerFile, setPrimerFile] = useState(null);
  const [primerFileName, setPrimerFileName] = useState("");
  const [primerFileValid, setPrimerFileValid] = useState(false);
  const [primerFileError, setPrimerFileError] = useState("");
  const [outputDir, setOutputDir] = useState("");
  const [jobidsRaw, setJobidsRaw] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState({ text: "Ready", color: "info" });
  const [logs, setLogs] = useState([]);
  const [results, setResults] = useState({ successes: 0, failures: [] });
  const fileInputRef = useRef(null);
  const logEndRef = useRef(null);

  // Pre-fill Primer Log path from the hub (read-only — user still has to
  // confirm by clicking "Select file" because the renderer can't read raw
  // paths from disk without an explicit File handle).
  useEffect(() => {
    if (initialPaths?.primer_log_path) {
      setPrimerFileName(initialPaths.primer_log_path);
    }
  }, [initialPaths]);

  // Auto-scroll the log to the bottom on new entries.
  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [logs]);

  const jobids = useMemo(() => {
    return jobidsRaw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }, [jobidsRaw]);

  const canRun = primerFileValid && outputDir && jobids.length > 0 && !running;

  const appendLog = (msg) => {
    setLogs((prev) => [...prev, { msg, t: Date.now() }]);
  };

  // ------------------------------------------------------------
  // File picker
  // ------------------------------------------------------------
  const handleFile = async (file) => {
    if (!file) return;
    setPrimerFile(file);
    setPrimerFileName(file.name);
    setPrimerFileValid(false);
    setPrimerFileError("");
    const ok = await primerLogHasRequiredSheets(file);
    if (ok) {
      setPrimerFileValid(true);
    } else {
      setPrimerFileError(
        "Missing required sheets: 'input addon' or 'Obsolete input addon(completed)'"
      );
    }
  };

  // ------------------------------------------------------------
  // Output folder picker (Electron native dialog via preload)
  // ------------------------------------------------------------
  const chooseOutputDir = async () => {
    if (window.api?.chooseOutputDir) {
      const picked = await window.api.chooseOutputDir(outputDir);
      if (picked) setOutputDir(picked);
    } else {
      // Browser fallback: <input webkitdirectory> — Electron always has the
      // native API so this is mainly for running outside Electron.
      alert("Output folder picker requires the Electron host. Open via Gene Synthesis Hub.exe.");
    }
  };

  // ------------------------------------------------------------
  // Run processing
  // ------------------------------------------------------------
  const runProcessing = async () => {
    if (!canRun) return;
    setRunning(true);
    setLogs([]);
    setResults({ successes: 0, failures: [] });
    setProgress(0);
    setStatus({ text: "Loading Primer Log sheets...", color: "info" });

    try {
      const { sheets, missing } = await loadPrimerLogSheets(primerFile);
      if (sheets.length === 0) {
        setStatus({ text: `Sheets missing: ${missing.join(", ")}`, color: "bad" });
        setRunning(false);
        return;
      }
      for (const s of sheets) {
        appendLog(`Loaded sheet: ${s.name} (${s.rows.length} rows)`);
      }

      const total = jobids.length;
      let successes = 0;
      const failures = [];
      for (let i = 0; i < total; i++) {
        const jid = jobids[i];
        appendLog(`[${i + 1}/${total}] Processing JobID: ${jid}`);
        setStatus({ text: `Processing ${jid} (${i + 1}/${total})`, color: "info" });

        // Look in each sheet, first hit wins.
        let row = null;
        for (const s of sheets) {
          row = getRowForJobId(s.rows, s.headers, jid);
          if (row) break;
        }
        if (!row) {
          appendLog(`  -> JobID ${jid} not found. Skipping.`);
          failures.push({ jid, reason: "Not found" });
          continue;
        }

        // Resolve headers from whichever sheet gave us the row.
        const headers = (() => {
          for (const s of sheets) {
            if (s.rows.includes(row)) return s.headers;
          }
          return sheets[0].headers;
        })();

        const finalVector = getFieldFromRow(
          row,
          headers,
          ["Final Vector", "FinalVector"],
          8
        );
        const insertSeq = getFieldFromRow(
          row,
          headers,
          ["Insert Seq", "InsertSeq"],
          7
        );

        if (!finalVector) {
          appendLog(`  -> No 'Final Vector' for ${jid}. Skipping.`);
          failures.push({ jid, reason: "Final Vector missing" });
          continue;
        }

        const result = buildGenbank({
          jobid: jid,
          finalVector,
          insertSeq,
        });
        if (!result.ok) {
          appendLog(`  -> ERROR for ${jid}: ${result.error}`);
          failures.push({ jid, reason: result.error });
          continue;
        }

        // Write the file via the Electron main process (renderer has no
        // direct filesystem access in this sandboxed config).
        const writeResult = await window.api.writeTextFile({
          filePath: `${outputDir}/${jid}.gb`.replace(/\\/g, "/"),
          text: result.text,
        });
        if (!writeResult?.ok) {
          appendLog(`  -> Write error for ${jid}: ${writeResult?.error || "unknown"}`);
          failures.push({ jid, reason: writeResult?.error || "Write failed" });
          continue;
        }
        appendLog(`  -> Written: ${jid}.gb`);
        successes++;
        setProgress((i + 1) / total);
        await new Promise((r) => setTimeout(r, 0));
      }

      setResults({ successes, failures });
      setProgress(1);
      const summary = `Done. Successes: ${successes}, Failures: ${failures.length}`;
      appendLog("");
      appendLog(summary);
      setStatus({
        text: summary,
        color: failures.length === 0 ? "good" : "warn",
      });
    } catch (err) {
      setStatus({ text: `Error: ${err.message}`, color: "bad" });
      appendLog(`Fatal: ${err.message}`);
    } finally {
      setRunning(false);
    }
  };

  // ------------------------------------------------------------
  // Render
  // ------------------------------------------------------------
  const statusColors = {
    info: "text-accent-400",
    good: "text-good",
    warn: "text-warn",
    bad:  "text-bad",
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
            <h1 className="font-semibold text-lg leading-tight">QC Vector Map Prep</h1>
            <p className="text-[11px] text-slate-400 leading-tight">
              BioPython workflow — generates GenBank (.gb) files annotated with the insert sequence.
              For SnapGene automation, use the legacy QC Digestion Design subapp.
            </p>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-6 space-y-5">
        {/* Primer Log */}
        <section className="bg-ink-800/40 border border-ink-700 rounded-lg p-4">
          <h2 className="font-semibold mb-2 flex items-center gap-2">
            <FileSpreadsheet size={16} className="text-accent-400" /> Primer Log
          </h2>
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={primerFileName}
              placeholder="No file selected"
              className="flex-1 px-3 py-2 rounded bg-ink-900/60 border border-ink-700 text-sm font-mono text-slate-300"
            />
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx"
              className="hidden"
              onChange={(e) => handleFile(e.target.files?.[0])}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="px-3 py-2 rounded bg-ink-700 hover:bg-ink-600 text-sm"
            >
              Select...
            </button>
          </div>
          {primerFile && (
            <div className="mt-2 text-xs">
              {primerFileValid ? (
                <span className="text-good flex items-center gap-1">
                  <CheckCircle2 size={12} /> Validated (input addon sheet found)
                </span>
              ) : (
                <span className="text-bad flex items-center gap-1">
                  <AlertCircle size={12} /> {primerFileError}
                </span>
              )}
            </div>
          )}
        </section>

        {/* Output folder */}
        <section className="bg-ink-800/40 border border-ink-700 rounded-lg p-4">
          <h2 className="font-semibold mb-2 flex items-center gap-2">
            <FolderOpen size={16} className="text-accent-400" /> Output Folder
          </h2>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={outputDir}
              onChange={(e) => setOutputDir(e.target.value)}
              placeholder="Click 'Select...' to choose an output folder"
              className="flex-1 px-3 py-2 rounded bg-ink-900/60 border border-ink-700 text-sm font-mono text-slate-300"
            />
            <button
              onClick={chooseOutputDir}
              className="px-3 py-2 rounded bg-ink-700 hover:bg-ink-600 text-sm"
            >
              Select...
            </button>
          </div>
        </section>

        {/* JobIDs */}
        <section className="bg-ink-800/40 border border-ink-700 rounded-lg p-4">
          <h2 className="font-semibold mb-2">JobIDs (one per line)</h2>
          <textarea
            value={jobidsRaw}
            onChange={(e) => setJobidsRaw(e.target.value)}
            placeholder={"Paste JobIDs here...\njob-001\njob-002\n..."}
            className="w-full h-32 px-3 py-2 rounded bg-ink-900/60 border border-ink-700 text-sm font-mono focus:border-accent-500 focus:outline-none resize-y"
            spellCheck={false}
          />
          <div className="mt-1 text-xs text-slate-400">
            {jobids.length} JobID{jobids.length === 1 ? "" : "s"} parsed
          </div>
        </section>

        {/* Action */}
        <section className="flex items-center justify-between gap-4">
          <div className="flex-1">
            <div className={`text-sm font-medium ${statusColors[status.color]}`}>
              {running && <Loader2 size={14} className="inline animate-spin mr-1" />}
              {status.text}
            </div>
            {running && (
              <div className="mt-2 h-1.5 bg-ink-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent-500 transition-all"
                  style={{ width: `${Math.round(progress * 100)}%` }}
                />
              </div>
            )}
            {!running && results.failures.length > 0 && (
              <div className="mt-1 text-xs text-slate-400">
                Failures: {results.failures.map((f) => f.jid).join(", ")}
              </div>
            )}
          </div>
          <button
            disabled={!canRun}
            onClick={runProcessing}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded font-medium ${
              canRun
                ? "bg-good hover:bg-good/90 text-white"
                : "bg-ink-700 text-slate-500 cursor-not-allowed"
            }`}
          >
            {running ? "Processing..." : `Process ${jobids.length || ""} JobID${jobids.length === 1 ? "" : "s"}`.trim()}
          </button>
        </section>

        {/* Log */}
        <section className="bg-ink-800/40 border border-ink-700 rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-ink-700">
            <h2 className="font-semibold">Log / Progress</h2>
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
    </div>
  );
}
