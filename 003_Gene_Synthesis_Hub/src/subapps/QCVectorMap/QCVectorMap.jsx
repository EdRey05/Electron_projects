import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  FileSpreadsheet,
  FlaskConical,
  FolderOpen,
  Dna,
} from "lucide-react";
import {
  loadPrimerLogSheets,
  primerLogHasRequiredSheets,
  getRowForJobId,
  readResolvedField,
} from "./excelHelpers.js";
import { columnResolutionLog } from "../../ui/columns.js";
import { buildGenbank } from "./genbankWriter.js";
import {
  C,
  AppHeader,
  Button,
  Panel,
  FilePickerRow,
  StatusLine,
  LogPanel,
  FONT_MONO,
} from "../../ui/kit.jsx";

/**
 * QC Vector Map Prep — React port of `vector_map_prep_biopython.py`.
 *
 * Behaviour parity:
 *   - User picks a Primer Log .xlsx (validated to contain `input addon` and/or
 *     `Obsolete input addon(completed)` sheets).
 *   - User picks an output folder via Electron's `dialog:showOpenDialog`.
 *   - User pastes Work Nos (one per line).
 *   - For each Work No.: locate the row in either relevant sheet, pull
 *     `Final Vector Sequence` (col I, fallback index 8) and `Insert Sequence`
 *     (col H, fallback index 7), emit a GenBank file with the insert
 *     annotated (single feature for in-frame inserts, two features for
 *     wrap-around).
 *
 * Differences from the Tkinter original:
 *   - No thread: the loop runs async/await with `setTimeout(0)` yields so
 *     the log textbox keeps rendering per-Work-No.
 *   - Output is one folder for all Work Nos; user picks once via the OS dialog
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
        // Three-way provenance report, matching the Python apps:
        //   "columns resolved by name (...)" /
        //   "header row not recognized; falling back to fixed columns (...)" /
        //   "partial header match; fixed fallback used for missing columns (...)"
        appendLog(columnResolutionLog(s.name, s.resolution));
      }

      const total = jobids.length;
      let successes = 0;
      const failures = [];
      for (let i = 0; i < total; i++) {
        const jid = jobids[i];
        appendLog(`[${i + 1}/${total}] Processing Work No.: ${jid}`);
        setStatus({ text: `Processing ${jid} (${i + 1}/${total})`, color: "info" });

        // Look in each sheet, first hit wins.
        let row = null;
        let sourceSheet = null;
        for (const s of sheets) {
          row = getRowForJobId(s.rows, s.headers, jid);
          if (row) {
            sourceSheet = s;
            break;
          }
        }
        if (!row) {
          appendLog(`  -> Work No. ${jid} not found. Skipping.`);
          failures.push({ jid, reason: "Not found" });
          continue;
        }

        // Use the resolution provenance of the sheet that gave us the row,
        // so the value comes from exactly the column that was logged.
        const resolution = sourceSheet?.resolution;
        const finalVector = resolution
          ? readResolvedField(row, resolution.indices.finalVectorSequence)
          : "";
        const insertSeq = resolution
          ? readResolvedField(row, resolution.indices.insertSequence)
          : "";

        if (!finalVector) {
          appendLog(`  -> No 'Final Vector Sequence' for ${jid}. Skipping.`);
          failures.push({ jid, reason: "Final Vector Sequence missing" });
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
  return (
    <div className="h-full flex flex-col" style={{ background: C.paper, color: C.ink }}>
      <AppHeader
        onBack={onBack}
        icon={<FlaskConical size={18} color="#fff" />}
        title="QC Vector Map Prep"
        subtitle="BioPython workflow — generates GenBank (.gb) files annotated with the insert sequence"
      />

      <main className="flex-1 overflow-y-auto p-6">
        <div className="max-w-4xl mx-auto space-y-5">
          {/* Primer Log */}
          <Panel
            icon={<FileSpreadsheet size={15} style={{ color: C.teal }} />}
            title="Primer Log"
            subtitle="Must contain 'input addon' and/or 'Obsolete input addon(completed)'"
          >
            <FilePickerRow
              inputRef={fileInputRef}
              value={primerFileName}
              onPick={handleFile}
              valid={primerFileValid}
              error={primerFileError}
              hint="Validated (input addon sheet found)"
            />
          </Panel>

          {/* Output folder */}
          <Panel
            icon={<FolderOpen size={15} style={{ color: C.teal }} />}
            title="Output Folder"
            subtitle="Destination for the generated .gb files"
          >
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={outputDir}
                onChange={(e) => setOutputDir(e.target.value)}
                placeholder="Click 'Select…' to choose an output folder"
                className="flex-1 px-3 py-2 rounded text-xs outline-none"
                style={{
                  background: C.surface,
                  border: "1px solid " + C.border,
                  borderRadius: 6,
                  color: outputDir ? C.ink : C.inkFaint,
                  fontFamily: FONT_MONO,
                  userSelect: "text",
                }}
              />
              <Button variant="primary" onClick={chooseOutputDir}>
                Select…
              </Button>
            </div>
          </Panel>

          {/* Work Nos */}
          <Panel
            icon={<Dna size={15} style={{ color: C.teal }} />}
            title="Work Nos (one per line)"
            actions={
              <span className="text-[11px]" style={{ color: C.inkFaint }}>
                {jobids.length} parsed
              </span>
            }
          >
            <textarea
              value={jobidsRaw}
              onChange={(e) => setJobidsRaw(e.target.value)}
              placeholder={"Paste Work Nos here…\njob-001\njob-002\n…"}
              rows={6}
              spellCheck={false}
              className="w-full px-3 py-2 rounded text-sm outline-none resize-y"
              style={{
                background: C.surface,
                border: "1px solid " + C.border,
                borderRadius: 6,
                color: C.ink,
                fontFamily: FONT_MONO,
                fontSize: 12,
                userSelect: "text",
              }}
            />
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
              {!running && results.failures.length > 0 && (
                <div className="mt-1 text-xs" style={{ color: C.coral }}>
                  Failures: {results.failures.map((f) => f.jid).join(", ")}
                </div>
              )}
            </div>
            <Button variant="primary" size="lg" disabled={!canRun} onClick={runProcessing}>
              {running
                ? "Processing…"
                : `Process ${jobids.length || ""} Work No.${jobids.length === 1 ? "" : "s"}`.trim()}
            </Button>
          </div>

          <LogPanel logs={logs} onClear={() => setLogs([])} endRef={logEndRef} title="Log / Progress" />
        </div>
      </main>
    </div>
  );
}
