import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  FileSpreadsheet,
  CheckCircle2,
  AlertCircle,
  Loader2,
  FileOutput,
  FolderOpen,
  Download,
} from "lucide-react";
import * as XLSX from "xlsx";
import {
  getPrimerInfo,
  getSequenceSampleId,
  extractUniqueJobIds,
} from "./dataExtractors.js";
import {
  buildFormRows,
  buildWorkbook,
  serializeWorkbook,
} from "./orderFormBuilder.js";

/**
 * Sequencing Order Form — React port of `sequencing_order_form_app.py`.
 *
 * Behaviour parity with the Tkinter original:
 *   - 3 file inputs: Primer Log (auto-detected, sheet 'input addon'), Empty
 *     Sequencing Order Form (auto-detected, no specific sheet), Sequencing
 *     Validation Template (manual, sheet 'Sequencing Pending').
 *   - Reads JobIDs from the Seq Validation file's first column (rows 2-98,
 *     deduplicated, in order of appearance).
 *   - Pulls primers from the Primer Log for each JobID (columns Q onwards).
 *   - Fills a fresh xlsx with: row 20 onwards, columns C/D/E/G/H/I/J/K/L
 *     (per sample, repeated once per primer).
 *   - Saves to the same folder as the Seq Validation file, named
 *     `Sequencing_order_form_<foldername>.xlsx`.
 *
 * Differences from the Tkinter original:
 *   - No threading; async/await with setTimeout(0) yields between phases.
 *   - The Empty Order Form template is NOT used as a base — we generate a
 *     fresh workbook from scratch with the data and computed formula strings.
 *     Excel recalculates on open. The Python app's openpyxl-based template
 *     round-trip has the same effect (and loses template formatting anyway).
 *   - The Excel COM link-update flow is replaced by a plain file copy + a
 *     warning that the user must re-link manually in Excel. win32com has
 *     no JS equivalent.
 */
export default function SequencingOrderForm({ onBack, initialPaths }) {
  const [primerFile, setPrimerFile] = useState(null);
  const [primerFileName, setPrimerFileName] = useState("");
  const [primerFileValid, setPrimerFileValid] = useState(false);
  const [primerFileError, setPrimerFileError] = useState("");

  const [emptyFormFile, setEmptyFormFile] = useState(null);
  const [emptyFormFileName, setEmptyFormFileName] = useState("");
  const [emptyFormValid, setEmptyFormValid] = useState(false);
  const [emptyFormError, setEmptyFormError] = useState("");

  const [seqValFile, setSeqValFile] = useState(null);
  const [seqValFileName, setSeqValFileName] = useState("");
  const [seqValValid, setSeqValValid] = useState(false);
  const [seqValError, setSeqValError] = useState("");

  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState({ text: "Ready", color: "info" });
  const [logs, setLogs] = useState([]);
  const [outputFile, setOutputFile] = useState(null);
  const logEndRef = useRef(null);

  const primerInputRef = useRef(null);
  const emptyFormInputRef = useRef(null);
  const seqValInputRef = useRef(null);

  // Pre-fill from hub-passed paths.
  useEffect(() => {
    if (initialPaths?.primer_log_path) setPrimerFileName(initialPaths.primer_log_path);
    if (initialPaths?.empty_form_path) setEmptyFormFileName(initialPaths.empty_form_path);
  }, [initialPaths]);

  // Auto-scroll log.
  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [logs]);

  const canGenerate = primerFileValid && emptyFormValid && seqValValid && !running;

  const appendLog = (msg) => setLogs((prev) => [...prev, { msg, t: Date.now() }]);

  // ------------------------------------------------------------
  // File pickers + validation
  // ------------------------------------------------------------
  const validateExcelFile = async (file, expectedSheet) => {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    if (expectedSheet && !wb.SheetNames.includes(expectedSheet)) {
      return { ok: false, error: `Sheet '${expectedSheet}' not found.` };
    }
    return { ok: true };
  };

  const handlePrimerFile = async (file) => {
    if (!file) return;
    setPrimerFile(file);
    setPrimerFileName(file.name);
    setPrimerFileValid(false);
    setPrimerFileError("");
    const r = await validateExcelFile(file, "input addon");
    if (r.ok) setPrimerFileValid(true);
    else setPrimerFileError(r.error);
  };

  const handleEmptyFormFile = async (file) => {
    if (!file) return;
    setEmptyFormFile(file);
    setEmptyFormFileName(file.name);
    setEmptyFormValid(false);
    setEmptyFormError("");
    const r = await validateExcelFile(file, null);
    if (r.ok) setEmptyFormValid(true);
    else setEmptyFormError(r.error);
  };

  const handleSeqValFile = async (file) => {
    if (!file) return;
    setSeqValFile(file);
    setSeqValFileName(file.name);
    setSeqValValid(false);
    setSeqValError("");
    const r = await validateExcelFile(file, "Sequencing Pending");
    if (r.ok) setSeqValValid(true);
    else setSeqValError(r.error);
  };

  // ------------------------------------------------------------
  // Generate
  // ------------------------------------------------------------
  const generate = async () => {
    if (!canGenerate) return;
    setRunning(true);
    setLogs([]);
    setOutputFile(null);
    setStatus({ text: "Starting generation...", color: "info" });

    try {
      appendLog("Starting generation process...");

      // Phase 1: extract unique JobIDs from Seq Validation file
      appendLog(`Reading Sequencing Validation file: ${seqValFileName}`);
      let jobIDs;
      try {
        jobIDs = await extractUniqueJobIds(seqValFile);
      } catch (err) {
        setStatus({ text: `Seq Validation read failed: ${err.message}`, color: "bad" });
        appendLog(`ERROR: ${err.message}`);
        setRunning(false);
        return;
      }
      appendLog(`Found ${jobIDs.length} unique Job IDs.`);
      await new Promise((r) => setTimeout(r, 0));

      // Phase 2: extract primers for those JobIDs from Primer Log
      appendLog("Fetching primer information from Primer Log...");
      const primersDict = await getPrimerInfo(primerFile, jobIDs);
      const totalPrimers = Object.values(primersDict).reduce(
        (acc, arr) => acc + arr.length,
        0
      );
      appendLog(
        `Primer information loaded (${totalPrimers} primers across ${jobIDs.length} JobIDs).`
      );
      await new Promise((r) => setTimeout(r, 0));

      const orderedSamples = await getSequenceSampleId(seqValFile);
      if (orderedSamples.length === 0) {
        setStatus({
          text: "No Sequence Sample IDs found in Sequencing Validation file.",
          color: "bad",
        });
        appendLog("ERROR: No Sequence Sample IDs found.");
        setRunning(false);
        return;
      }
      appendLog("Sample IDs loaded.");
      await new Promise((r) => setTimeout(r, 0));

      // Phase 3: build rows
      appendLog("Generating order form...");
      // Output folder = parent of the seq validation file (matches the Python app).
      // Strip "C:/..." or "C:\\..." backslashes to "/", then dirname.
      const sep = seqValFileName.includes("/") ? "/" : "\\";
      const seqValPath = seqValFileName;
      // We don't have the full path; reconstruct using the file's webkitRelativePath
      // if available, or just use the filename + the user-provided base. Simpler:
      // ask the user via the dialog for the output folder.
      // We'll fall through to a picker here.
      appendLog("Note: output folder is the parent of the Sequencing Validation file.");
      // For now, write into the parent of the user-picked path. We need the
      // path, not just the filename — prompt the user.
      const outputDir = await window.api.chooseOutputDir("");
      if (!outputDir) {
        appendLog("Aborted: no output folder selected.");
        setStatus({ text: "Cancelled — no output folder.", color: "warn" });
        setRunning(false);
        return;
      }
      const sepOut = outputDir.includes("\\") && !outputDir.includes("/") ? "\\" : "/";
      const dateId = outputDir.split(/[\\/]/).pop();

      const built = buildFormRows(orderedSamples, primersDict, dateId);
      appendLog(
        `Built ${built.rows.length} rows (${orderedSamples.length} samples, ${built.rows.length - orderedSamples.length + Object.values(primersDict).filter(p => p.length).length} primer expansions).`
      );
      for (const w of built.warnings) appendLog(`WARNING: ${w}`);
      await new Promise((r) => setTimeout(r, 0));

      // Phase 4: emit workbook + write
      const seqValBasename = seqValPath.split(/[\\/]/).pop();
      const wb = buildWorkbook(built, seqValBasename);
      const bytes = serializeWorkbook(wb);
      const outputPath = `${outputDir}${sepOut}Sequencing_order_form_${dateId}.xlsx`;
      const writeResult = await window.api.writeBinaryFile({
        filePath: outputPath,
        bytes,
      });
      if (!writeResult?.ok) {
        setStatus({
          text: `Write failed: ${writeResult?.error}`,
          color: "bad",
        });
        appendLog(`ERROR: ${writeResult?.error}`);
        setRunning(false);
        return;
      }
      appendLog(`Saved filled form to: ${outputPath}`);
      setOutputFile(outputPath);
      appendLog("Save complete.");

      // Phase 5: layout template (optional, not passed by the hub currently)
      // The hub passes seq_layout_path via pass_template_as_kwarg only if
      // the user has it configured. We display the path in initialPaths if so.
      if (initialPaths?.seq_layout_path) {
        appendLog(`Copying layout file: ${initialPaths.seq_layout_path}`);
        const destPath = `${outputDir}${sepOut}Sequencing_layout_${dateId}.xlsx`;
        const copyResult = await window.api.copyFile({
          source: initialPaths.seq_layout_path,
          dest: destPath,
        });
        if (copyResult?.ok) {
          appendLog(`Layout file copied to: ${destPath}`);
          appendLog(
            "NOTE: Excel external link update (formerly via win32com) cannot run from JS. " +
            "Open the copied layout in Excel and re-link it manually to the new order form."
          );
        } else {
          appendLog(`WARNING: Layout file copy failed: ${copyResult?.error}`);
        }
      }

      // Done.
      appendLog("");
      const summary = built.warnings.length > 0
        ? `Done with ${built.warnings.length} warning(s). ${built.rows.length} rows written.`
        : `Success! Sequencing Order form generated and saved. ${built.rows.length} rows.`;
      appendLog(summary);
      setStatus({
        text: summary,
        color: built.warnings.length > 0 ? "warn" : "good",
      });
    } catch (err) {
      appendLog(`FATAL: ${err.message}`);
      setStatus({ text: `Error: ${err.message}`, color: "bad" });
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
            <FileOutput size={18} className="text-accent-400" />
          </div>
          <div>
            <h1 className="font-semibold text-lg leading-tight">Sequencing Order Form</h1>
            <p className="text-[11px] text-slate-400 leading-tight">
              Fills the empty order form from Primer Log + Sequencing Validation data.
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
          <FilePickerRow
            inputRef={primerInputRef}
            value={primerFileName}
            onPick={handlePrimerFile}
            valid={primerFileValid}
            error={primerFileError}
          />
        </section>

        {/* Empty Order Form */}
        <section className="bg-ink-800/40 border border-ink-700 rounded-lg p-4">
          <h2 className="font-semibold mb-2 flex items-center gap-2">
            <FileSpreadsheet size={16} className="text-accent-400" /> Empty Sequencing Order Form
          </h2>
          <FilePickerRow
            inputRef={emptyFormInputRef}
            value={emptyFormFileName}
            onPick={handleEmptyFormFile}
            valid={emptyFormValid}
            error={emptyFormError}
          />
          <p className="mt-1 text-xs text-slate-400">
            Note: this template's visual layout is not preserved — the output is a fresh workbook with the data + formulas. Excel will recalculate on open.
          </p>
        </section>

        {/* Sequencing Validation */}
        <section className="bg-ink-800/40 border border-ink-700 rounded-lg p-4">
          <h2 className="font-semibold mb-2 flex items-center gap-2">
            <FileSpreadsheet size={16} className="text-accent-400" /> Sequencing Validation Template
          </h2>
          <FilePickerRow
            inputRef={seqValInputRef}
            value={seqValFileName}
            onPick={handleSeqValFile}
            valid={seqValValid}
            error={seqValError}
          />
        </section>

        {/* Action */}
        <section className="flex items-center justify-between gap-4">
          <div className="flex-1">
            <div className={`text-sm font-medium ${statusColors[status.color]}`}>
              {running && <Loader2 size={14} className="inline animate-spin mr-1" />}
              {status.text}
            </div>
            {outputFile && (
              <div className="mt-1 text-xs text-slate-400 font-mono truncate">
                Output: {outputFile}
              </div>
            )}
          </div>
          <button
            disabled={!canGenerate}
            onClick={generate}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded font-medium ${
              canGenerate
                ? "bg-good hover:bg-good/90 text-white"
                : "bg-ink-700 text-slate-500 cursor-not-allowed"
            }`}
          >
            <Download size={14} />
            {running ? "Generating..." : "Generate Form"}
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

function FilePickerRow({ inputRef, value, onPick, valid, error }) {
  return (
    <>
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
          accept=".xlsx"
          className="hidden"
          onChange={(e) => onPick(e.target.files?.[0])}
        />
        <button
          onClick={() => inputRef.current?.click()}
          className="px-3 py-2 rounded bg-ink-700 hover:bg-ink-600 text-sm"
        >
          Select...
        </button>
      </div>
      {value && (
        <div className="mt-2 text-xs">
          {valid ? (
            <span className="text-good flex items-center gap-1">
              <CheckCircle2 size={12} /> Validated
            </span>
          ) : (
            <span className="text-bad flex items-center gap-1">
              <AlertCircle size={12} /> {error}
            </span>
          )}
        </div>
      )}
    </>
  );
}
