import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  FileSpreadsheet,
  CheckCircle2,
  AlertCircle,
  Loader2,
  FileText,
  FolderOpen,
  Download,
} from "lucide-react";
import * as XLSX from "xlsx";
import {
  extractSequences,
  planOutputs,
  resolveColumnIndices,
} from "./extractor.js";

/**
 * Sequencing Reference Files — React port.
 *
 * Behaviour parity with the Tkinter original:
 *   - User picks a Primer Log .xlsx (validated to contain `input addon` sheet).
 *   - User picks an output folder.
 *   - Click "Export Sequences" → for each row:
 *       {JobID}.txt with the Insert Seq (column H by default)
 *       {JobID}+{Vector}.txt with the Final Vector (column I by default)
 *
 * Column mapping is auto-detected from headers (case-insensitive, with
 * positional fallbacks matching the Python app).
 *
 * Differences from the Tkinter original:
 *   - No threading: the loop runs async/await with `setTimeout(0)` yields
 *     between rows so the log keeps rendering.
 *   - File writing goes through the Electron `hub:writeTextFile` IPC (the
 *     renderer has no direct filesystem access in this sandboxed config).
 */
export default function SequencingReferenceFiles({ onBack, initialPaths }) {
  const [primerFile, setPrimerFile] = useState(null);
  const [primerFileName, setPrimerFileName] = useState("");
  const [primerFileValid, setPrimerFileValid] = useState(false);
  const [primerFileError, setPrimerFileError] = useState("");
  const [outputDir, setOutputDir] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState({ text: "Ready", color: "info" });
  const [logs, setLogs] = useState([]);
  const [results, setResults] = useState({ filesWritten: 0, rowsProcessed: 0 });
  const [previewColumns, setPreviewColumns] = useState(null);

  const fileInputRef = useRef(null);
  const logEndRef = useRef(null);

  // Pre-fill from the hub's passed paths.
  useEffect(() => {
    if (initialPaths?.primer_log_path) {
      setPrimerFileName(initialPaths.primer_log_path);
    }
    if (initialPaths?.reference_files_path) {
      setOutputDir(initialPaths.reference_files_path);
    }
  }, [initialPaths]);

  // Auto-scroll the log.
  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [logs]);

  const canRun = primerFileValid && outputDir && !running;

  const appendLog = (msg) => {
    setLogs((prev) => [...prev, { msg, t: Date.now() }]);
  };

  // ------------------------------------------------------------
  // File picker — validates the file contains `input addon` sheet
  // and remembers the column-resolution so we can show it in the UI.
  // ------------------------------------------------------------
  const handleFile = async (file) => {
    if (!file) return;
    setPrimerFile(file);
    setPrimerFileName(file.name);
    setPrimerFileValid(false);
    setPrimerFileError("");
    setPreviewColumns(null);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      if (!wb.SheetNames.includes("input addon")) {
        setPrimerFileError("Sheet 'input addon' not found in workbook.");
        return;
      }
      // Show the resolved column mapping so the user knows what'll be used.
      const sheet = wb.Sheets["input addon"];
      const aoa = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        blankrows: false,
        raw: false,
      });
      if (aoa.length === 0) {
        setPrimerFileError("Workbook is empty.");
        return;
      }
      const headers = aoa[0].map((h) => (h == null ? "" : String(h)));
      const idx = resolveColumnIndices(headers);
      setPreviewColumns({ headers, indices: idx });
      setPrimerFileValid(true);
    } catch (err) {
      setPrimerFileError(`Not a valid Excel file: ${err.message}`);
    }
  };

  // ------------------------------------------------------------
  // Output folder picker
  // ------------------------------------------------------------
  const chooseOutputDir = async () => {
    if (window.api?.chooseOutputDir) {
      const picked = await window.api.chooseOutputDir(outputDir);
      if (picked) setOutputDir(picked);
    } else {
      alert("Output folder picker requires the Electron host.");
    }
  };

  // ------------------------------------------------------------
  // Run export
  // ------------------------------------------------------------
  const runExport = async () => {
    if (!canRun) return;
    setRunning(true);
    setLogs([]);
    setResults({ filesWritten: 0, rowsProcessed: 0 });
    setProgress(0);
    setStatus({ text: "Loading Primer Log...", color: "info" });

    try {
      const extracted = await extractSequences(primerFile);
      if (!extracted.ok) {
        setStatus({ text: extracted.error, color: "bad" });
        appendLog(`ERROR: ${extracted.error}`);
        setRunning(false);
        return;
      }
      appendLog(`Loaded Primer Log: ${primerFileName}`);
      appendLog(
        `Using column indices: JobID=${extracted.indices.jobId}, Vector=${extracted.indices.vector}, InsertSeq=${extracted.indices.insertSeq}, FinalVector=${extracted.indices.finalVector}`
      );
      appendLog(`Output folder: ${outputDir}`);
      appendLog("");

      const total = extracted.rows.length;
      let filesWritten = 0;
      for (let i = 0; i < total; i++) {
        const row = extracted.rows[i];
        const outputs = planOutputs(row);
        for (const o of outputs) {
          const filePath = `${outputDir}/${o.name}`.replace(/\\/g, "/");
          const result = await window.api.writeTextFile({
            filePath,
            text: o.contents,
          });
          if (!result?.ok) {
            appendLog(`  ✗ ${o.name}: ${result?.error || "write failed"}`);
          } else {
            appendLog(`  ✓ Created: ${o.name}`);
            filesWritten++;
          }
        }
        setProgress((i + 1) / total);
        // Yield to the UI so the log keeps rendering per-row.
        await new Promise((r) => setTimeout(r, 0));
      }

      setResults({ filesWritten, rowsProcessed: total });
      setProgress(1);
      const summary = `--- Processing Finished ---\nRows processed: ${total}\nFiles created: ${filesWritten}`;
      appendLog("");
      appendLog(summary);
      setStatus({
        text: `Done. ${filesWritten} file${filesWritten === 1 ? "" : "s"} written.`,
        color: filesWritten > 0 ? "good" : "warn",
      });
    } catch (err) {
      setStatus({ text: `Error: ${err.message}`, color: "bad" });
      appendLog(`FATAL: ${err.message}`);
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
            <FileText size={18} className="text-accent-400" />
          </div>
          <div>
            <h1 className="font-semibold text-lg leading-tight">Sequencing Reference Files</h1>
            <p className="text-[11px] text-slate-400 leading-tight">
              Extract Insert Seq + Final Vector from Primer Log → individual .txt files.
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
              accept=".xlsx,.xls"
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
          {previewColumns && (
            <div className="mt-3 text-xs font-mono text-slate-400 bg-ink-900/40 rounded px-3 py-2">
              <div className="text-slate-500 mb-1">Detected columns:</div>
              <div>JobID → column {previewColumns.indices.jobId + 1} ({previewColumns.headers[previewColumns.indices.jobId] || "?"})</div>
              <div>Vector → column {previewColumns.indices.vector + 1} ({previewColumns.headers[previewColumns.indices.vector] || "?"})</div>
              <div>Insert Seq → column {previewColumns.indices.insertSeq + 1} ({previewColumns.headers[previewColumns.indices.insertSeq] || "?"})</div>
              <div>Final Vector → column {previewColumns.indices.finalVector + 1} ({previewColumns.headers[previewColumns.indices.finalVector] || "?"})</div>
            </div>
          )}
        </section>

        {/* Output folder */}
        <section className="bg-ink-800/40 border border-ink-700 rounded-lg p-4">
          <h2 className="font-semibold mb-2 flex items-center gap-2">
            <FolderOpen size={16} className="text-accent-400" /> Reference Files Folder
          </h2>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={outputDir}
              onChange={(e) => setOutputDir(e.target.value)}
              placeholder="Click 'Select...' to choose the output folder"
              className="flex-1 px-3 py-2 rounded bg-ink-900/60 border border-ink-700 text-sm font-mono text-slate-300"
            />
            <button
              onClick={chooseOutputDir}
              className="px-3 py-2 rounded bg-ink-700 hover:bg-ink-600 text-sm"
            >
              Select...
            </button>
          </div>
          <p className="mt-2 text-xs text-slate-400">
            Each row produces up to two files: <span className="font-mono">{`{JobID}.txt`}</span> (Insert Seq)
            and <span className="font-mono">{`{JobID}+{Vector}.txt`}</span> (Final Vector).
          </p>
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
            {!running && results.filesWritten > 0 && (
              <div className="mt-1 text-xs text-slate-400">
                {results.rowsProcessed} row{results.rowsProcessed === 1 ? "" : "s"} processed,
                {" "}{results.filesWritten} file{results.filesWritten === 1 ? "" : "s"} written
              </div>
            )}
          </div>
          <button
            disabled={!canRun}
            onClick={runExport}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded font-medium ${
              canRun
                ? "bg-good hover:bg-good/90 text-white"
                : "bg-ink-700 text-slate-500 cursor-not-allowed"
            }`}
          >
            <Download size={14} />
            {running ? "Exporting..." : "Export Sequences"}
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
    </div>
  );
}
