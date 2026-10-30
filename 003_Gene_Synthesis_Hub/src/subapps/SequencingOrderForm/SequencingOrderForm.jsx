import React, { useEffect, useRef, useState } from "react";
import {
  FileSpreadsheet,
  FileOutput,
  Download,
} from "lucide-react";
import * as XLSX from "xlsx";
import {relinkSequencingLayout} from "../../ui/sequencingLinks.js";
import {
  getPrimerInfo,
  getSequenceSampleId,
  extractUniqueJobIds,
} from "./dataExtractors.js";
import {
  buildFormRows,
  buildOrderFormBytes,
} from "./orderFormBuilder.js";
import {
  C,
  AppHeader,
  Button,
  Panel,
  FilePickerRow,
  PathInput,
  StatusLine,
  LogPanel,
  FONT_MONO,
} from "../../ui/kit.jsx";

/**
 * Sequencing Order Form — React port of `sequencing_order_form_app.py`.
 *
 * Behaviour parity with the Tkinter original:
 *   - 3 file inputs: Primer Log (auto-detected, sheet 'input addon'), Empty
 *     Sequencing Order Form (auto-detected, no specific sheet), Sequencing
 *     Validation Template (manual, sheet 'Sequencing Pending').
 *   - Reads Work Nos from the Seq Validation file's first column (EXCEL rows
 *     2-98, deduplicated, in order of appearance).
 *   - Pulls primers from the Primer Log for each Work No.
 *   - Fills the EMPTY ORDER FORM TEMPLATE in place: row 20 onwards, columns
 *     B/C/D/E/F/G/H/I/J/K/L (per sample, repeated once per primer). The
 *     output keeps the template's header row 19, its merged cells, its
 *     column widths, its print setup and its "Order form" sheet name.
 *   - Saves to the same folder as the Seq Validation file, named
 *     `Sequencing_order_form_<foldername>.xlsx`.
 *
 * Differences from the Tkinter original:
 *   - No threading; async/await with setTimeout(0) yields between phases.
 *   - The layout external-link relationship is updated directly in its XLSX
 *     package, so generating a linked pair does not require Excel COM.
 */
export default function SequencingOrderForm({ onBack, initialPaths }) {
  const [primerFile, setPrimerFile] = useState(null);
  const [primerFileName, setPrimerFileName] = useState("");
  const [primerFilePath, setPrimerFilePath] = useState("");
  const [primerFileValid, setPrimerFileValid] = useState(false);
  const [primerFileError, setPrimerFileError] = useState("");

  const [emptyFormFile, setEmptyFormFile] = useState(null);
  const [emptyFormFileName, setEmptyFormFileName] = useState("");
  const [emptyFormFilePath, setEmptyFormFilePath] = useState("");
  const [emptyFormValid, setEmptyFormValid] = useState(false);
  const [emptyFormError, setEmptyFormError] = useState("");

  const [seqValFile, setSeqValFile] = useState(null);
  const [seqValFileName, setSeqValFileName] = useState("");
  const [seqValFilePath, setSeqValFilePath] = useState("");
  const [seqValValid, setSeqValValid] = useState(false);
  const [seqValError, setSeqValError] = useState("");

  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState({ text: "Ready", color: "info" });
  const [logs, setLogs] = useState([]);
  const [outputFile, setOutputFile] = useState(null);
  const logEndRef = useRef(null);
  const loadIds=useRef({primer:0,form:0,seq:0});

  // The layout template path (Sequencing_layout_v*.xlsx) — the Python
  // receives it as `seq_layout_path` and copies it next to the order form.
  const [layoutPath, setLayoutPath] = useState("");

  const primerInputRef = useRef(null);
  const emptyFormInputRef = useRef(null);
  const seqValInputRef = useRef(null);

  // Pre-fill from hub-passed paths.
  //
  // `initialPaths.primer_log_path` comes from `pass_dir_as_kwarg` (a
  // configured folder). `initialPaths.empty_form_path` and
  // `initialPaths.seq_layout_path` come from `pass_template_as_kwarg` — the
  // hub resolves those patterns against python-app/Templates and hands the
  // ABSOLUTE path of the newest match (e.g.
  // .../python-app/Templates/Sequencing_order_form_v5.xlsx).
  useEffect(() => {
    let disposed=false;
    const load=async(key,filePath,handler,setName,setError)=>{
      if(!filePath)return;
      const id=++loadIds.current[key];setName(filePath);
      try {
        const read=await window.api.readBinaryFile({filePath});
        if(disposed||id!==loadIds.current[key])return;
        if(!read.ok){setError(read.error||"Choose a local file.");return;}
        await handler(new File([read.bytes],filePath.split(/[\\/]/).pop()),filePath);
      } catch(error){if(!disposed)setError(error.message);}
    };
    load('primer',initialPaths?.primer_log_path,handlePrimerFile,setPrimerFileName,setPrimerFileError);
    load('form',initialPaths?.empty_form_path,handleEmptyFormFile,setEmptyFormFileName,setEmptyFormError);
    if(initialPaths?.seq_layout_path)setLayoutPath(initialPaths.seq_layout_path);
    return()=>{disposed=true;};
  },[initialPaths]);

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
    try {
      const buf=await file.arrayBuffer(),wb=XLSX.read(buf,{type:"array"});
      if(expectedSheet&&!wb.SheetNames.includes(expectedSheet))return {ok:false,error:`Sheet '${expectedSheet}' not found.`};
      return {ok:true};
    }catch(error){return {ok:false,error:`Could not read workbook: ${error.message}`};}
  };

  /**
   * The absolute path of a File picked through an <input type=file>.
   *
   * Electron 32 removed the non-standard `File.path` property, so the
   * renderer cannot read the location itself — the preload's
   * `webUtils.getPathForFile` bridge does it.
   */
  const absolutePathOf = (file) => {
    if (!file) return "";
    try {
      if (typeof file.path === "string" && file.path) return file.path;
    } catch (err) {
      /* not available — fall through to the bridge */
    }
    try {
      return window.api?.getPathForFile?.(file) || "";
    } catch (err) {
      return "";
    }
  };

  const handlePrimerFile = async (file, sourcePath="") => {
    if (!file) return;
    const id=++loadIds.current.primer;setOutputFile(null);
    setPrimerFile(file);
    setPrimerFileName(file.name);
    setPrimerFilePath(sourcePath||absolutePathOf(file));
    setPrimerFileValid(false);
    setPrimerFileError("");
    const r = await validateExcelFile(file, "input addon");
    if(id!==loadIds.current.primer)return;
    if (r.ok) setPrimerFileValid(true);
    else setPrimerFileError(r.error);
  };

  const handleEmptyFormFile = async (file, sourcePath="") => {
    if (!file) return;
    const id=++loadIds.current.form;setOutputFile(null);
    setEmptyFormFile(file);
    setEmptyFormFileName(file.name);
    setEmptyFormFilePath(sourcePath||absolutePathOf(file));
    setEmptyFormValid(false);
    setEmptyFormError("");
    const r = await validateExcelFile(file, null);
    if(id!==loadIds.current.form)return;
    if (r.ok) setEmptyFormValid(true);
    else setEmptyFormError(r.error);
  };

  const handleSeqValFile = async (file, sourcePath="") => {
    if (!file) return;
    const id=++loadIds.current.seq;setOutputFile(null);
    setSeqValFile(file);
    setSeqValFileName(file.name);
    setSeqValFilePath(sourcePath||absolutePathOf(file));
    setSeqValValid(false);
    setSeqValError("");
    const r = await validateExcelFile(file, "Sequencing Pending");
    if(id!==loadIds.current.seq)return;
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

      // Phase 0: resolve the output folder.
      //
      // The Python (`sequencing_order_form_app.py:681`):
      //
      //     output_dir = os.path.dirname(seq_validation_file)
      //
      // so the output folder is ALWAYS the folder that holds the
      // Sequencing Validation file — there is no prompt, and the date_ID
      // is that folder's basename (`:120`).
      const seqValPath = seqValFilePath || absolutePathOf(seqValFile);
      const outputDir = parentDir(seqValPath);
      if (!outputDir) {
        setStatus({
          text: "Could not determine the Sequencing Validation file's folder.",
          color: "bad",
        });
        appendLog(
          "ERROR: could not resolve the Sequencing Validation file's absolute path, " +
          "so the output folder is unknown."
        );
        setRunning(false);
        return;
      }
      const sepOut = outputDir.includes("\\") && !outputDir.includes("/") ? "\\" : "/";
      const dateId = outputDir.split(/[\\/]/).filter(Boolean).pop() || outputDir;
      appendLog(`Output folder: ${outputDir}`);
      appendLog(`Plate Date ID: ${dateId}`);

      // Phase 1: extract unique Work Nos from Seq Validation file
      appendLog(`Reading Sequencing Validation file: ${seqValFileName}`);
      let workNos;
      try {
        workNos = await extractUniqueJobIds(seqValFile);
      } catch (err) {
        setStatus({ text: `Seq Validation read failed: ${err.message}`, color: "bad" });
        appendLog(`ERROR: ${err.message}`);
        setRunning(false);
        return;
      }
      appendLog(`Found ${workNos.length} unique Work Nos.`);
      await new Promise((r) => setTimeout(r, 0));

      // Phase 2: extract primers for those Work Nos from Primer Log
      appendLog("Fetching primer information from Primer Log...");
      const { primers: primersDict, log: primerLog } = await getPrimerInfo(primerFile, workNos);
      appendLog(primerLog);
      const totalPrimers = Object.values(primersDict).reduce(
        (acc, arr) => acc + arr.length,
        0
      );
      appendLog(
        `Primer information loaded (${totalPrimers} primers across ${workNos.length} Work Nos.).`
      );
      await new Promise((r) => setTimeout(r, 0));

      // One tuple per matching row — a Work No. on several rows yields
      // several order-form rows (matches the Python).
      const orderedSamples = await getSequenceSampleId(seqValFile, workNos);
      if (orderedSamples.length === 0) {
        setStatus({
          text: "No Sequence Sample IDs found in Sequencing Validation file.",
          color: "bad",
        });
        appendLog("ERROR: No Sequence Sample IDs found.");
        setRunning(false);
        return;
      }
      appendLog(`Sample IDs loaded (${orderedSamples.length} row(s)).`);
      await new Promise((r) => setTimeout(r, 0));

      // Phase 3: build rows
      appendLog("Generating order form...");
      const built = buildFormRows(orderedSamples, primersDict, dateId);
      appendLog(
        `Built ${built.rows.length} rows (${orderedSamples.length} samples, ${built.rows.length - orderedSamples.length + Object.values(primersDict).filter(p => p.length).length} primer expansions).`
      );
      if (built.orderFormId) {
        appendLog(`Order form ID (B18): ${built.orderFormId}`);
      }
      for (const w of built.warnings) appendLog(`WARNING: ${w}`);

      // The Python raises when no Work No. has any primer at all — it must
      // not write a header-only order form.
      if (built.rows.length === 0) {
        setStatus({
          text: "No primers found for any of the Work Nos. Nothing was written.",
          color: "bad",
        });
        appendLog("ERROR: No primers found for any of the Work Nos.");
        setRunning(false);
        return;
      }
      await new Promise((r) => setTimeout(r, 0));

      // Phase 4: fill the Empty Order Form template and write it.
      //
      // The template is the BASE of the output (the Python mutates it with
      // openpyxl). Its bytes come from disk when we know its path (the
      // hub-resolved `empty_form_path`), otherwise from the picked File.
      const templateBytes = await readTemplateBytes(emptyFormFile, emptyFormFilePath);
      if (!templateBytes) {
        setStatus({ text: "Could not read the Empty Order Form template.", color: "bad" });
        appendLog("ERROR: could not read the Empty Order Form template.");
        setRunning(false);
        return;
      }

      const seqValBasename = seqValFileName.split(/[\\/]/).pop();
      const bytes = await buildOrderFormBytes(built, {
        templateBytes,
        outputDir,
        seqValidationFilename: seqValBasename,
      });

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

      // Phase 5: layout template (the Python copies it next to the form).
      if (layoutPath) {
        appendLog(`Copying layout file: ${layoutPath}`);
        const destPath = `${outputDir}${sepOut}Sequencing_layout_${dateId}.xlsx`;
        const template=await window.api.readBinaryFile({filePath:layoutPath});
        if(!template.ok)throw new Error(template.error||"Layout template could not be read.");
        const linked=relinkSequencingLayout(template.bytes,`Sequencing_order_form_${dateId}.xlsx`);
        const written=await window.api.writeBinaryFile({filePath:destPath,bytes:linked.bytes});
        if(!written.ok)throw new Error(written.error||"Layout could not be saved.");
        appendLog(`Layout saved with ${linked.linksUpdated} link(s) to the new order form.`);
      } else {
        appendLog("NOTE: no Sequencing layout template was configured — nothing to copy.");
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
  return (
    <div className="h-full flex flex-col" style={{ background: C.paper, color: C.ink }}>
      <AppHeader
        onBack={onBack}
        icon={<FileOutput size={18} color="#fff" />}
        title="Sequencing Order Form"
        subtitle="Fills the empty order form from Primer Log + Sequencing Validation data"
      />

      <main className="flex-1 overflow-y-auto p-6">
        <div className="max-w-4xl mx-auto space-y-5">
          {/* Primer Log */}
          <Panel
            icon={<FileSpreadsheet size={15} style={{ color: C.teal }} />}
            title="Primer Log"
            subtitle="Sheet 'input addon'"
          >
            <FilePickerRow
              disabled={running}
              inputRef={primerInputRef}
              value={primerFileName}
              onPick={handlePrimerFile}
              valid={primerFileValid}
              error={primerFileError}
            />
          </Panel>

          {/* Empty Order Form */}
          <Panel
            icon={<FileSpreadsheet size={15} style={{ color: C.teal }} />}
            title="Empty Sequencing Order Form"
            subtitle="Template source"
          >
            <FilePickerRow
              disabled={running}
              inputRef={emptyFormInputRef}
              value={emptyFormFileName}
              onPick={handleEmptyFormFile}
              valid={emptyFormValid}
              error={emptyFormError}
            />
            <p className="mt-2 text-[11px]" style={{ color: C.inkFaint }}>
              The output is this template filled in — the form&apos;s header row, merged
              cells, column widths and print setup are preserved.
            </p>
          </Panel>

          {/* Sequencing Validation */}
          <Panel
            icon={<FileSpreadsheet size={15} style={{ color: C.teal }} />}
            title="Sequencing Validation Template"
            subtitle="Sheet 'Sequencing Pending'"
          >
            <FilePickerRow
              disabled={running}
              inputRef={seqValInputRef}
              value={seqValFileName}
              onPick={handleSeqValFile}
              valid={seqValValid}
              error={seqValError}
            />
            <p className="mt-2 text-[11px]" style={{ color: C.inkFaint }}>
              The filled order form is written to this file&apos;s folder.
            </p>
          </Panel>

          {/* Sequencing layout template (optional) */}
          <Panel
            icon={<FileSpreadsheet size={15} style={{ color: C.teal }} />}
            title="Sequencing Layout Template"
            subtitle="Copied next to the order form"
          >
            <PathInput value={layoutPath} placeholder="No layout template configured" />
          </Panel>

          {/* Action */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1 min-w-0">
              <StatusLine status={status} running={running} />
              {outputFile && (
                <div
                  className="mt-1 text-[11px] truncate"
                  style={{ color: C.inkMuted, fontFamily: FONT_MONO }}
                >
                  Output: {outputFile}
                </div>
              )}
            </div>
            <Button variant="primary" size="lg" disabled={!canGenerate} onClick={generate}>
              <Download size={15} />
              {running ? "Generating…" : "Generate Form"}
            </Button>
          </div>

          <LogPanel logs={logs} onClear={() => setLogs([])} endRef={logEndRef} />
        </div>
      </main>
    </div>
  );
}

// =============================================================================
// Helpers
// =============================================================================

/** The parent folder of an absolute path ("" when there is none). */
function parentDir(absPath) {
  if (!absPath) return "";
  const norm = String(absPath).replace(/[\\/]+$/, "");
  const idx = Math.max(norm.lastIndexOf("\\"), norm.lastIndexOf("/"));
  if (idx < 0) return "";
  return norm.slice(0, idx);
}

/**
 * Read the Empty Order Form template's bytes.
 *
 * The workbook is built FROM the template, so a missing/unreadable template
 * is a hard error — we must not fall back to a from-scratch workbook (that
 * loses the form's header row, merged cells and print setup).
 */
async function readTemplateBytes(file, absPath) {
  try {
    if (file && typeof file.arrayBuffer === "function") {
      return await file.arrayBuffer();
    }
  } catch (err) {
    /* fall through to the IPC read */
  }
  if (!absPath) return null;
  try {
    const r = await window.api.readBinaryFile({ filePath: absPath });
    if (!r?.ok) return null;
    return r.bytes;
  } catch (err) {
    return null;
  }
}
