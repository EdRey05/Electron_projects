import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  FileSpreadsheet,
  FlaskConical,
  FolderOpen,
  Play,
  Plus,
  X,
} from "lucide-react";
import {
  readLigationLayout,
  readPrimerLog,
  buildSummary,
  uniqueJobDetails,
} from "./extractor.js";
import { planPlates } from "./platePlanner.js";
import { buildWorkbookBytes, buildOutputFilename } from "./workbookBuilder.js";
import {
  C,
  AppHeader,
  Button,
  Panel,
  PathInput,
  StatusLine,
  LogPanel,
  Modal,
  FONT_MONO,
} from "../../ui/kit.jsx";

/**
 * Colony PCR Layout — React port.
 *
 * Behaviour parity with the Tkinter original:
 *   1. Pick one or more Ligation Layout files (sheet 'Layout').
 *   2. Pick a Primer Log (sheet 'input addon') — auto-detected by the hub.
 *   3. Pick a Colony PCR Layout template — auto-detected by the hub.
 *   4. App reads files, builds summary data, shows a modal with a
 *      clone-count spinner per (Work No., SourceFile).
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
    ligationInputRef.current?.click();
  };
  const onLigationInputChange = (e) => {
    const files = Array.from(e.target.files || []).map(f=>({name:f.name,path:window.api.getPathForFile(f)})).filter(f=>f.path);
    setLigationFiles((prev) => {
      const next = [...prev];
      for (const f of files) {
        if (!next.some((p) => p.path.toLowerCase() === f.path.toLowerCase())) next.push(f);
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
      const { map: primerMap, log: primerLog } = readPrimerLog(plFile);
      appendLog(primerLog);
      appendLog(`Primer Log loaded (${Object.keys(primerMap).length} Work Nos.).`);

      // Step 2: read each ligation file
      let allRows = [];
      for (const lf of ligationFiles) {
        const lfBuf = await readFileAsArrayBuffer(lf.path);
        const { rows, log } = readLigationLayout(lfBuf, lf.path);
        appendLog(log);
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
      for (const d of details) initial[makeKey(d["Work No."], d.SourceFile)] = 4;
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
      const { map: primerMap } = readPrimerLog(plFile);

      let allRows = [];
      for (const lf of ligationFiles) {
        const lfBuf = await readFileAsArrayBuffer(lf.path);
        const { rows } = readLigationLayout(lfBuf, lf.path);
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

      // Build the workbook FROM the Colony PCR template, the way the Python
      // does (`openpyxl.load_workbook(template)` then mutate). The template
      // carries the printed plate frame (row letters A-H, column numbers
      // 1-12), the borders and the merged section headers — a from-scratch
      // workbook has none of that, so a printed plate cannot be read.
      const templateBytes = await readTemplateBytes(templatePath);
      if (!templateBytes) {
        appendLog("ERROR: could not read the Colony PCR template.");
        setStatus({ text: "Template read failed.", color: "bad" });
        setRunning(false);
        return;
      }
      // The mix calculation table uses the REQUESTED clone counts (the
      // `counts` map), matching the Python's `all_clone_counts`.
      const bytes = await buildWorkbookBytes(plan, summaryRows, counts, templateBytes, new Date());

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
  return (
    <div className="h-full flex flex-col" style={{ background: C.paper, color: C.ink }}>
      <AppHeader
        onBack={onBack}
        icon={<FlaskConical size={18} color="#fff" />}
        title="Colony PCR Layout"
        subtitle="Reads Ligation Layouts, fills the Colony PCR template"
      />

      <main className="flex-1 overflow-y-auto p-6">
        <div className="max-w-4xl mx-auto space-y-5">
          {/* Ligation files */}
          <Panel
            icon={<FileSpreadsheet size={15} style={{ color: C.teal }} />}
            title="Ligation Layout Files"
            subtitle="One or more .xlsx files with a 'Layout' sheet"
            actions={
              <>
                <input
                  ref={ligationInputRef}
                  type="file"
                  accept=".xlsx,.xlsm"
                  multiple
                  className="hidden"
                  onChange={onLigationInputChange}
                />
                <Button variant="primary" size="sm" onClick={chooseLigationFiles}>
                  <Plus size={13} /> Add…
                </Button>
                {ligationFiles.length > 0 && (
                  <Button variant="ghost" size="sm" onClick={() => setLigationFiles([])}>
                    Clear
                  </Button>
                )}
              </>
            }
          >
            {ligationFiles.length === 0 ? (
              <p className="text-xs italic" style={{ color: C.inkFaint }}>
                No files selected
              </p>
            ) : (
              <div
                className="rounded-md px-3 py-2 space-y-1"
                style={{ background: C.subtle, border: "1px solid " + C.border }}
              >
                {ligationFiles.map((f, i) => (
                  <div key={i} className="flex items-center justify-between gap-2">
                    <span className="text-xs truncate" style={{ fontFamily: FONT_MONO }}>
                      {baseName(f.path)}
                    </span>
                    <button
                      onClick={() => setLigationFiles((prev) => prev.filter((_, j) => j !== i))}
                      style={{ color: C.inkFaint }}
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          {/* Primer Log */}
          <Panel
            icon={<FileSpreadsheet size={15} style={{ color: C.teal }} />}
            title="Primer Log"
            subtitle="Sheet 'input addon'"
          >
            <div className="flex items-center gap-2">
              <PathInput value={primerLogPath} style={{ flex: 1 }} />
              <input
                ref={primerLogInputRef}
                type="file"
                accept=".xlsx,.xlsm"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) setPrimerLogPath(window.api.getPathForFile(f));
                  e.target.value = "";
                }}
              />
              <Button variant="primary" onClick={choosePrimerLog}>
                Select…
              </Button>
            </div>
          </Panel>

          {/* Colony PCR Template */}
          <Panel
            icon={<FileSpreadsheet size={15} style={{ color: C.teal }} />}
            title="Colony PCR Layout Template"
            subtitle="Detected automatically from the bundled Templates folder"
          >
            <div className="flex items-center gap-2">
              <PathInput value={templatePath} style={{ flex: 1 }} />
              <input
                ref={templateInputRef}
                type="file"
                accept=".xlsx,.xlsm"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) setTemplatePath(window.api.getPathForFile(f));
                  e.target.value = "";
                }}
              />
              <Button variant="secondary" onClick={chooseTemplate}>
                Replace…
              </Button>
            </div>
          </Panel>

          {/* Output Folder */}
          <Panel
            icon={<FolderOpen size={15} style={{ color: C.teal }} />}
            title="Output Folder"
            subtitle="Defaults to the same folder as your first ligation file"
          >
            <div className="flex items-center gap-2">
              <PathInput
                value={outputDir}
                readOnly={false}
                onChange={(e) => setOutputDir(e.target.value)}
                placeholder="Defaults to the same folder as your first ligation file"
                style={{ flex: 1 }}
              />
              <Button variant="primary" onClick={chooseOutputDir}>
                Browse…
              </Button>
            </div>
          </Panel>

          {/* Generate */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1 min-w-0">
              <StatusLine status={status} running={running} />
            </div>
            <Button variant="primary" size="lg" disabled={!canGenerate} onClick={handleGenerate}>
              <Play size={15} />
              {running ? "Working…" : "Generate Layout"}
            </Button>
          </div>

          <LogPanel logs={logs} onClear={() => setLogs([])} endRef={logEndRef} />
        </div>
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
  const totalClones = useMemo(
    () => Object.values(values).reduce((a, b) => a + (Number(b) || 0), 0),
    [values]
  );
  return (
    <Modal
      open
      title="Number of Clones per Job"
      subtitle={`${jobDetails.length} job entries · ${totalClones} clones total`}
      onCancel={onCancel}
      width={860}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm}>
            Confirm
          </Button>
        </>
      }
    >
      <div
        className="grid gap-2 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide"
        style={{
          gridTemplateColumns: "90px 80px 90px 70px 1fr 120px",
          color: C.inkMuted,
          borderBottom: "1px solid " + C.border,
        }}
      >
        <div>Work No.</div>
        <div>BBI ID</div>
        <div>Vector</div>
        <div>Length (bp)</div>
        <div>Ligation File</div>
        <div># Clones</div>
      </div>
      <div className="mt-1">
        {jobDetails.map((d, i) => {
          const key = makeKey(d["Work No."], d.SourceFile);
          const val = values[key] ?? 4;
          return (
            <div
              key={i}
              className="grid gap-2 px-2 py-1 text-xs items-center"
              style={{
                gridTemplateColumns: "90px 80px 90px 70px 1fr 120px",
                background: i % 2 === 0 ? C.subtle2 : "transparent",
              }}
            >
              <div style={{ fontFamily: FONT_MONO }}>{d["Work No."]}</div>
              <div style={{ fontFamily: FONT_MONO }}>{d["BBI ID"]}</div>
              <div style={{ fontFamily: FONT_MONO }} className="truncate">
                {d.Vector}
              </div>
              <div style={{ fontFamily: FONT_MONO }}>{d["Length (bp)"]}</div>
              <div style={{ fontFamily: FONT_MONO }} className="truncate" title={d.SourceFile}>
                {truncate(baseName(d.SourceFile), 28)}
              </div>
              <div className="inline-flex items-center gap-1">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onChange({ ...values, [key]: Math.max(0, val - 1) })}
                  style={{ width: 26, padding: "3px 0" }}
                >
                  −
                </Button>
                <input
                  type="number"
                  min={0}
                  max={96}
                  value={val}
                  onChange={(e) => {
                    const n = Math.max(0, Math.min(96, parseInt(e.target.value, 10) || 0));
                    onChange({ ...values, [key]: n });
                  }}
                  className="w-12 text-center px-1 py-1 rounded text-xs outline-none"
                  style={{
                    background: C.surface,
                    border: "1px solid " + C.border,
                    borderRadius: 5,
                    fontFamily: FONT_MONO,
                    color: C.ink,
                  }}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onChange({ ...values, [key]: Math.min(96, val + 1) })}
                  style={{ width: 26, padding: "3px 0" }}
                >
                  +
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

// =============================================================================
// Helpers
// =============================================================================

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

/**
 * Read the Colony PCR template and return its bytes.
 *
 * The workbook is built FROM the template, so a missing/unreadable
 * template is a hard error — we must not silently fall back to a
 * from-scratch workbook (that loses the plate frame and the borders).
 */
async function readTemplateBytes(path) {
  if (!path) return null;
  try {
    return await readFileAsArrayBuffer(path);
  } catch (err) {
    return null;
  }
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
