import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Download,
} from "lucide-react";
import * as XLSX from "xlsx";
import {
  extractSequences,
  planWorkbookOutputs,
  resolveColumnIndices,
} from "./extractor.js";
import {
  C,
  AppHeader,
  Button,
  Panel,
  FilePickerRow,
  Pill,
  StatusLine,
  LogPanel,
  EmptyState,
  FONT_MONO,
} from "../../ui/kit.jsx";

/**
 * Sequencing Reference Files — React port.
 *
 * Behaviour parity with the Tkinter original:
 *   - User picks a Primer Log .xlsx (validated to contain `input addon` sheet).
 *   - User picks an output folder.
 *   - Click "Export Sequences" → for each row:
 *       {Work No}.txt with the Insert Sequence
 *       {Work No}+{Vector}.txt with the Final Vector Sequence
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
  const loadGeneration = useRef(0);
  const logEndRef = useRef(null);

  // Pre-fill from the hub's passed paths.
  useEffect(() => {
    let disposed=false;
    if (initialPaths?.primer_log_path) {
      const filePath=initialPaths.primer_log_path;
      const generation=++loadGeneration.current;
      setPrimerFileName(filePath);
      window.api.readBinaryFile({filePath}).then(result=>{
        if(disposed || generation!==loadGeneration.current)return;
        if(!result.ok){setPrimerFileError(result.error||"Choose a local Primer Log.");return;}
        handleFile(new File([result.bytes],filePath.split(/[\\/]/).pop()));
      }).catch(error=>{if(!disposed)setPrimerFileError(error.message);});
    }
    if (initialPaths?.reference_files_path) {
      setOutputDir(initialPaths.reference_files_path);
    }
    return()=>{disposed=true;};
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
    const generation=++loadGeneration.current;
    setPrimerFile(file);
    setPrimerFileName(file.name);
    setPrimerFileValid(false);
    setPrimerFileError("");
    setPreviewColumns(null);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      if(generation!==loadGeneration.current)return;
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
      if(generation!==loadGeneration.current)return;
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
      appendLog(extracted.resolutionLog || "");
      appendLog(`Output folder: ${outputDir}`);
      appendLog("");

      const planned = planWorkbookOutputs(extracted.rows); // Validate every name/collision before any write.
      const total = planned.length;
      let filesWritten = 0;
      let failures = 0;
      for (let i = 0; i < total; i++) {
        const outputs = [planned[i]];
        for (const o of outputs) {
          const filePath = `${outputDir}/${o.name}`.replace(/\\/g, "/");
          const result = await window.api.writeTextFile({
            filePath,
            text: o.contents,
          });
          if (!result?.ok) {
            failures++;
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

      setResults({ filesWritten, rowsProcessed: extracted.rows.length });
      setProgress(1);
      const summary = `--- Processing Finished ---\nRows processed: ${extracted.rows.length}\nFiles created: ${filesWritten}`;
      appendLog("");
      appendLog(summary);
      setStatus({
        text: failures ? `${filesWritten} written · ${failures} failed. See log.` : `Done. ${filesWritten} file${filesWritten === 1 ? "" : "s"} written.`,
        color: failures ? "bad" : filesWritten > 0 ? "good" : "warn",
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
  const columnRows = useMemo(() => {
    if (!previewColumns) return [];
    const idx = previewColumns.indices;
    const label = (key, name) => ({
      key,
      label: name,
      render: (r) => (
        <span style={{ fontFamily: FONT_MONO }}>
          col {r.col} — {r.header || "?"}
        </span>
      ),
    });
    return [
      { key: "jobId", col: idx.jobId + 1, header: previewColumns.headers[idx.jobId] },
      { key: "vector", col: idx.vector + 1, header: previewColumns.headers[idx.vector] },
      { key: "insertSeq", col: idx.insertSeq + 1, header: previewColumns.headers[idx.insertSeq] },
      { key: "finalVector", col: idx.finalVector + 1, header: previewColumns.headers[idx.finalVector] },
    ].map((r) => label(r.key, r.key));
  }, [previewColumns]);

  return (
    <div className="h-full flex flex-col" style={{ background: C.paper, color: C.ink }}>
      <AppHeader
        onBack={onBack}
        icon={<FileText size={18} color="#fff" />}
        title="Sequencing Reference Files"
        subtitle="Extract Insert + Final Vector sequences from the Primer Log into individual .txt files"
      />

      <main className="flex-1 overflow-y-auto p-6">
        <div className="max-w-4xl mx-auto space-y-5">
          {/* Primer Log */}
          <Panel
            icon={<FileSpreadsheet size={15} style={{ color: C.teal }} />}
            title="Primer Log"
            subtitle="Must contain the 'input addon' sheet"
          >
            <FilePickerRow
              disabled={running}
              inputRef={fileInputRef}
              value={primerFileName}
              onPick={handleFile}
              valid={primerFileValid}
              error={primerFileError}
              accept=".xlsx,.xls"
              hint="Validated (input addon sheet found)"
            />
            {previewColumns && (
              <details><summary style={{fontSize:14,cursor:"pointer"}}>Workbook details</summary><div
                className="mt-3 text-[11px] rounded px-3 py-2 space-y-0.5"
                style={{
                  fontFamily: FONT_MONO,
                  color: C.inkMuted,
                  background: C.subtle,
                  border: "1px solid " + C.border,
                }}
              >
                <div style={{ color: C.inkFaint }}>Detected columns:</div>
                <div>
                  Work No. → column {previewColumns.indices.workNo + 1} (
                  {previewColumns.headers[previewColumns.indices.workNo] || "?"})
                </div>
                <div>
                  Vector → column {previewColumns.indices.vector + 1} (
                  {previewColumns.headers[previewColumns.indices.vector] || "?"})
                </div>
                <div>
                  Insert Sequence → column {previewColumns.indices.insertSequence + 1} (
                  {previewColumns.headers[previewColumns.indices.insertSequence] || "?"})
                </div>
                <div>
                  Final Vector Sequence → column{" "}
                  {previewColumns.indices.finalVectorSequence + 1} (
                  {previewColumns.headers[previewColumns.indices.finalVectorSequence] || "?"})
                </div>
              </div></details>
            )}
          </Panel>

          {/* Output folder */}
          <Panel
            icon={<FolderOpen size={15} style={{ color: C.teal }} />}
            title="Reference Files Folder"
            subtitle="Destination for the generated .txt files"
          >
            <div className="flex items-center gap-2">
              <input
                type="text"
                disabled={running}
                value={outputDir}
                onChange={(e) => setOutputDir(e.target.value)}
                placeholder="Click 'Select…' to choose the output folder"
                className="flex-1 px-3 py-2 text-xs rounded outline-none"
                style={{
                  background: C.surface,
                  border: "1px solid " + C.border,
                  borderRadius: 6,
                  color: outputDir ? C.ink : C.inkFaint,
                  fontFamily: FONT_MONO,
                  userSelect: "text",
                }}
              />
              <Button variant="primary" disabled={running} onClick={chooseOutputDir}>
                Select…
              </Button>
            </div>
            <p className="mt-2 text-[11px]" style={{ color: C.inkFaint }}>
              Each row produces up to two files:{" "}
              <span style={{ fontFamily: FONT_MONO }}>{`{Work No.}.txt`}</span> (Insert
              Sequence) and{" "}
              <span style={{ fontFamily: FONT_MONO }}>
                {`{Work No.}+{Vector}.txt`}
              </span>{" "}
              (Final Vector Sequence).
            </p>
          </Panel>

          {/* Action */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1 min-w-0">
              <StatusLine status={status} running={running} />
              {running && (
                <div
                  className="mt-2 h-1.5 rounded-full overflow-hidden"
                  style={{ background: C.border }}
                >
                  <div
                    className="h-full transition-all"
                    style={{ width: `${Math.round(progress * 100)}%`, background: C.teal }}
                  />
                </div>
              )}
              {!running && results.filesWritten > 0 && (
                <div className="mt-1 text-xs" style={{ color: C.inkMuted }}>
                  {results.rowsProcessed} row{results.rowsProcessed === 1 ? "" : "s"} processed,{" "}
                  {results.filesWritten} file{results.filesWritten === 1 ? "" : "s"} written
                </div>
              )}
            </div>
            <Button variant="primary" size="lg" disabled={!canRun} onClick={runExport}>
              <Download size={15} />
              {running ? "Exporting…" : "Export Sequences"}
            </Button>
          </div>

          <LogPanel logs={logs} onClear={() => setLogs([])} endRef={logEndRef} />
        </div>
      </main>
    </div>
  );
}
