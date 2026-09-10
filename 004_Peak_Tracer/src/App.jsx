import React, { useState, useCallback, useEffect } from "react";
import {
  Activity,
  FolderInput,
  FolderOutput,
  Play,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ExternalLink,
  Settings as SettingsIcon,
} from "lucide-react";

// ---------- design tokens (mirror SequenceBindingFinder for hub consistency) ----------
const paper = "#F5F7F6";
const ink = "#1F2A33";
const border = "#DCE5E1";
const panelDark = "#1F3A5F";        // primary accent
const panelDarkInk = "#FFFFFF";
const teal = "#3FB6A8";             // success / "trace looks good"
const amber = "#E0A52A";            // warning / mixed-base
const coral = "#E26B5A";            // error / process failed
const muted = "#8FA39D";            // secondary text
const inputBg = "#FFFFFF";

// ---------- default settings ----------
const DEFAULT_SETTINGS = {
  // v1.6: preprocessing mode toggle.
  mode: "with_preprocess",
};

// ---------- helpers ----------
function fmtBytes(n) {
  if (!n) return "\u2014";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function lowestQvColor(v) {
  if (v == null) return muted;
  if (v >= 20) return teal;
  if (v >= 10) return amber;
  return coral;
}

// ============================================================
//  APP
// ============================================================
export default function PeakTracer() {
  // ---- input / output folders ----
  const [inputDir, setInputDir] = useState("");
  const [inputFiles, setInputFiles] = useState([]);
  const [outputDir, setOutputDir] = useState("");

  // ---- settings ----
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);

  // ---- run state ----
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState([]);   // [{name, status, message, qc, extBasesAdded, ...}]
  const [logs, setLogs] = useState([]);

  // ---- advanced parameters popup ----
  // Placeholder: visible defaults that mirror what the CLI / PT pipeline uses,
  // but changes are NOT propagated to the spawn args yet (planned for a later
  // version). User can poke at them to learn what knobs exist.
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [adv, setAdv] = useState({
    rebasecallData14: true,      // --rebasecall-data14 (default ON)
    minRebasecallLen: 1000,      // --min-rebasecall-len (default 1000)
    extendMinSnr: 1.3,           // --extend-min-snr (default 1.3)
    baselineSmooth: true,        // --baseline-smooth (default ON)
    leadDropEnabled: true,       // --lead-drop-enabled (default ON, but disabled in practice)
    leadDropQv: 5,               // --lead-drop-qv (default 5)
    skipShorterThan: 50,         // --skip-shorter-than (default 50)
    setAbiLimits: true,          // --set-abi-limits (default ON)
    stripWellId: true,           // --strip-well-id (default ON)
    doSmooth: true,              // --do-smooth (default ON)
    smoothWindow: 11,            // --smooth-window (default 11)
  });
  const setAdvField = (k, v) => setAdv((s) => ({ ...s, [k]: v }));

  // ---- subscribe to streaming events ----
  useEffect(() => {
    if (!window.api) return;
    const offProgress = window.api.onProgress((msg) => {
      if (msg.type === "file_start") {
        setResults((prev) => {
          const existing = prev.findIndex((r) => r.name === msg.name);
          if (existing >= 0) return prev;
          return [...prev, { name: msg.name, status: "running", message: "Processing\u2026" }];
        });
      } else if (msg.type === "file_done") {
        const name = (msg.src || msg.name || "").split(/[\\/]/).pop();
        setResults((prev) =>
          prev.map((r) =>
            r.name === name
              ? {
                  ...r,
                  status: msg.error ? "error" : "ok",
                  message: msg.error ? `Error: ${msg.error}` : "",
                  outputPath: msg.out || msg.outputPath || null,
                  qc: { n_bases_in: msg.n_bases_in ?? null,
                        n_bases_out: msg.n_bases_out ?? null,
                        qv_mean: msg.qv_mean ?? null,
                        first_5_bases: msg.first_5_bases ?? null,
                        last_5_bases: msg.last_5_bases ?? null,
                        lead_dropped: msg.lead_dropped ?? false,
                        extended: msg.extended ?? false,
                        ext_bases_added: msg.ext_bases_added ?? 0,
                        map_r_squared: msg.map_r_squared ?? 0,
                        lowest_qv: msg.lowest_qv ?? null,
                        n_count: msg.n_count ?? null },
                  extended: msg.extended ?? false,
                  extBasesAdded: msg.ext_bases_added ?? 0,
                  mapRSquared: msg.map_r_squared ?? 0,
                }
              : r
          )
        );
      } else if (msg.type === "file_skip") {
        const name = (msg.src || "").split(/[\\/]/).pop();
        setResults((prev) =>
          prev.map((r) =>
            r.name === name ? { ...r, status: "skipped", message: msg.reason || "skipped" } : r
          )
        );
      } else if (msg.type === "file_error") {
        const name = (msg.src || "").split(/[\\/]/).pop();
        setResults((prev) =>
          prev.map((r) =>
            r.name === name ? { ...r, status: "error", message: msg.error || "Error" } : r
          )
        );
      }
    });
    const offLog = window.api.onLog((msg) => {
      setLogs((prev) => [...prev.slice(-200), msg]);   // keep last 200
    });
    const offDone = window.api.onDone((msg) => {
      setRunning(false);
    });
    return () => {
      offProgress && offProgress();
      offLog && offLog();
      offDone && offDone();
    };
  }, []);

  // ---- list files whenever input changes ----
  useEffect(() => {
    if (!window.api || !inputDir) return;
    window.api.listAb1(inputDir).then((files) => {
      setInputFiles(files);
      setResults([]);
    });
  }, [inputDir]);

  // ---- auto-suggest output = parent of input ----
  useEffect(() => {
    if (!inputDir || outputDir) return;
    const sep = inputDir.includes("\\") ? "\\" : "/";
    const parts = inputDir.split(/[\\/]/).filter(Boolean);
    if (parts.length >= 1) {
      const parent = parts.slice(0, -1).join(sep) || (sep + parts[0]);
      setOutputDir(parent.startsWith(sep) ? parent : sep + parent);
    }
  }, [inputDir, outputDir]);

  // ---- handlers ----
  const onPickInput = useCallback(async () => {
    const p = await window.api.pickInputFolder();
    if (p) setInputDir(p);
  }, []);

  const onPickOutput = useCallback(async () => {
    const p = await window.api.pickOutputFolder(outputDir);
    if (p) setOutputDir(p);
  }, [outputDir]);

  const onRun = useCallback(async () => {
    if (!inputDir || !outputDir || inputFiles.length === 0) return;
    setRunning(true);
    setResults([]);
    setLogs([]);
    const res = await window.api.runBatch({
      inputDir,
      outputDir,
      settings,
    });
    if (!res.ok) {
      setRunning(false);
      setLogs((prev) => [...prev, { level: "error", message: res.error || "Batch failed" }]);
    }
  }, [inputDir, outputDir, inputFiles, settings]);

  const onReset = useCallback(() => {
    setResults([]);
    setLogs([]);
    }, []);

  // ---- derived ----
  const runnable = !!inputDir && !!outputDir && inputFiles.length > 0 && !running;
  const okCount = results.filter((r) => r.status === "ok").length;
  const errCount = results.filter((r) => r.status === "error").length;
  const doneCount = results.length;
  // Progress bar: derive from completed rows.
  const progressPct = inputFiles.length > 0
    ? Math.round((doneCount / inputFiles.length) * 100)
    : 0;

  // ---- render ----
  return (
    <div style={{ background: paper, color: ink, minHeight: "100%", fontFamily: "'IBM Plex Sans', sans-serif" }}>
      <div className="max-w-6xl mx-auto px-6 pt-4 pb-6">
        {/* Header */}
        <div className="flex items-center gap-3 mb-5 border-b pb-4" style={{ borderColor: border }}>
          <div
            style={{ background: panelDark }}
            className="w-11 h-11 rounded-md flex items-center justify-center shrink-0"
          >
            <Activity size={22} color="#FFFFFF" />
          </div>
          <div>
            <h1 className="text-[28px] font-extrabold leading-tight font-display" style={{ color: ink }}>
              Peak Tracer
            </h1>
            <p className="text-xs mt-0.5" style={{ color: muted }}>
              In-house replacement for Nucleics Auto PeakTrace RP \u00b7 Sanger .ab1 trace processing
            </p>
          </div>
        </div>

        {/* ============================================================ */}
        {/*  2-COLUMN LAYOUT                                              */}
        {/* ============================================================ */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* LEFT COL (narrower): 2 of 5 = 40% */}
          <div className="lg:col-span-2 flex flex-col gap-6">

            {/* ---- 1. INPUT FOLDER ---- */}
            <section>
              <h2 className="text-base font-bold tracking-wide mb-2" style={{ color: ink }}>
                1. Input folder
              </h2>
              <div className="rounded-lg border overflow-hidden" style={{ borderColor: border, background: inputBg }}>
                <div className="p-3 flex gap-2">
                  <input
                    type="text"
                    readOnly
                    value={inputDir}
                    placeholder="Pick the plate folder\u2026"
                    className="flex-1 px-3 py-2 text-sm rounded border font-mono"
                    style={{ borderColor: border, color: inputDir ? ink : muted, background: "#FAFBFA" }}
                  />
                  <button
                    type="button"
                    className="px-3 py-2 rounded text-sm flex items-center gap-1.5 shrink-0 font-medium"
                    style={{ background: panelDark, color: panelDarkInk }}
                    onClick={onPickInput}
                  >
                    <FolderInput size={14} /> Pick
                  </button>
                </div>
                {inputFiles.length > 0 && (
                  <div className="px-4 py-2 text-xs border-t" style={{ borderColor: border, background: "#FAFBFA" }}>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm" style={{ color: ink }}>
                        {inputFiles.length} file{inputFiles.length === 1 ? "" : "s"}
                      </span>
                      <span style={{ color: muted }}>.ab1</span>
                    </div>
                  </div>
                )}
              </div>
            </section>

            {/* ---- 2. OUTPUT FOLDER ---- */}
            <section>
              <h2 className="text-base font-bold tracking-wide mb-2" style={{ color: ink }}>
                2. Output folder
              </h2>
              <div className="rounded-lg border overflow-hidden" style={{ borderColor: border, background: inputBg }}>
                <div className="p-3 flex gap-2">
                  <input
                    type="text"
                    readOnly
                    value={outputDir}
                    placeholder="Auto-set to parent of input\u2026"
                    className="flex-1 px-3 py-2 text-sm rounded border font-mono"
                    style={{ borderColor: border, color: outputDir ? ink : muted, background: "#FAFBFA" }}
                  />
                  <button
                    type="button"
                    className="px-3 py-2 rounded text-sm flex items-center gap-1.5 shrink-0 font-medium"
                    style={{ background: panelDark, color: panelDarkInk }}
                    onClick={onPickOutput}
                  >
                    <FolderOutput size={14} /> Pick
                  </button>
                  {outputDir && (
                    <button
                      type="button"
                      className="px-2 py-2 rounded text-sm flex items-center gap-1 shrink-0"
                      style={{ borderColor: border, color: muted, background: "#FAFBFA" }}
                      title="Open in Explorer"
                      onClick={() => window.api.openFolder(outputDir)}
                    >
                      <ExternalLink size={13} />
                    </button>
                  )}
                </div>
              </div>
            </section>

            {/* ---- 3. SETTINGS (2-mode toggle + engine button for advanced params) ---- */}
            <section>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-base font-bold tracking-wide" style={{ color: ink }}>
                3. Settings
              </h2>
              <button
                type="button"
                className="p-1.5 rounded"
                title="Advanced processing parameters"
                style={{ color: muted, background: inputBg, border: `1px solid ${border}` }}
                onClick={() => setShowAdvanced(true)}
              >
                <SettingsIcon size={16} />
              </button>
            </div>
            <div className="flex flex-col gap-2">
              <ModeCard
                selected={settings.mode === "with_preprocess"}
                onClick={() => setSettings((s) => ({ ...s, mode: "with_preprocess" }))}
                title="Preprocessing + PT"
                steps={[
                  "Strips well-ID from .seq",
                  "Converts .seq to .fa",
                  "Renames files",
                  "Runs PT",
                ]}
              />
              <ModeCard
                selected={settings.mode === "pt_only"}
                onClick={() => setSettings((s) => ({ ...s, mode: "pt_only" }))}
                title="PT only"
                steps={["Runs PT"]}
              />
            </div>
            </section>

            {/* ---- 4. RUN (button + status, moved to end of col 1) ---- */}
            <section>
              <h2 className="text-base font-bold tracking-wide mb-2" style={{ color: ink }}>
                4. Run
              </h2>
              <div className="rounded-lg border p-4" style={{ borderColor: border, background: inputBg }}>
                <div className="text-sm mb-3" style={{ color: muted }}>
                  {inputFiles.length === 0
                    ? "Pick an input folder to enable."
                    : running
                    ? `Processing ${doneCount + 1} of ${inputFiles.length}\u2026`
                    : doneCount > 0
                    ? `Done \u2014 ${okCount} ok, ${errCount} failed, ${inputFiles.length - doneCount} skipped.`
                    : `Ready \u2014 ${inputFiles.length} file${inputFiles.length === 1 ? "" : "s"} to process.`}
                </div>
                {(running || progressPct > 0) && (
                  <div className="mb-3 h-1.5 rounded-full overflow-hidden" style={{ background: border }}>
                    <div
                      className="h-full transition-all"
                      style={{ width: `${progressPct}%`, background: panelDark }}
                    />
                  </div>
                )}
                <button
                  type="button"
                  className="w-full px-5 py-2.5 rounded-md text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ background: panelDark, color: panelDarkInk }}
                  disabled={!runnable}
                  onClick={onRun}
                >
                  <Play size={14} />
                  {running ? "Running\u2026" : "Run Peak Tracer"}
                </button>
              </div>
            </section>
          </div>

          {/* RIGHT COL (wider): 3 of 5 = 60% — Run log only */}
          <div className="lg:col-span-3 flex flex-col gap-6">

            {/* ---- RUN LOG (per-file table) ---- */}
            <section>
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-base font-bold tracking-wide" style={{ color: ink }}>
                  Run Log
                </h2>
                {(results.length > 0 || logs.length > 0) && (
                  <button
                    type="button"
                    className="text-xs px-2 py-1 rounded"
                    style={{ color: muted, background: inputBg, border: `1px solid ${border}` }}
                    onClick={onReset}
                  >
                    Clear
                  </button>
                )}
              </div>

              {results.length === 0 && logs.length === 0 ? (
                <div
                  className="rounded-lg border-2 border-dashed p-8 text-center text-sm"
                  style={{ borderColor: border, color: muted, background: inputBg }}
                >
                  No files processed yet. Pick an input folder and click <strong>Run</strong>.
                </div>
              ) : (
                <div
                  className="rounded-lg border overflow-hidden"
                  style={{ borderColor: border, background: inputBg }}
                >
                  {/* Sticky header row */}
                  <div
                    className="grid items-center gap-2 px-3 py-2 text-xs font-bold uppercase tracking-wide sticky top-0 z-10"
                    style={{
                      gridTemplateColumns: "1fr 64px 64px 60px 60px 80px",
                      color: ink,
                      background: "#EEF3F1",
                      borderBottom: `1px solid ${border}`,
                    }}
                  >
                    <div>File</div>
                    <div className="text-right">Bases</div>
                    <div className="text-right">Mean QV</div>
                    <div className="text-right">Min QV</div>
                    <div className="text-right">N&apos;s</div>
                    <div className="text-right">Extended</div>
                  </div>

                  {/* Scrollable body (18 rows + frozen header visible at default row height) */}
                  <div
                    className="overflow-y-auto"
                    style={{ maxHeight: 625 }}
                  >
                    {/* File rows */}
                    {results.map((r, i) => {
                      const extBasesAdded = r.extBasesAdded ?? r.qc?.ext_bases_added ?? 0;
                      const extended = r.extended || extBasesAdded > 0;
                      const qvMean = r.qc?.qv_mean;
                      const lowestQv = r.qc?.lowest_qv;
                      const nCount = r.qc?.n_count;
                      const nBasesOut = r.qc?.n_bases_out;
                      const statusIcon =
                        r.status === "ok" ? (
                          <CheckCircle2 size={14} color={teal} className="shrink-0" />
                        ) : r.status === "error" ? (
                          <XCircle size={14} color={coral} className="shrink-0" />
                        ) : (
                          <AlertTriangle size={14} color={muted} className="shrink-0" />
                        );
                      const lqvColor = lowestQvColor(lowestQv);
                      return (
                        <div
                          key={r.name + i}
                          className="grid items-center gap-2 px-3 py-2 text-xs"
                          style={{
                            gridTemplateColumns: "1fr 64px 64px 60px 60px 80px",
                            borderTop: i === 0 ? "none" : `1px solid ${border}`,
                          }}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            {statusIcon}
                            <span className="font-mono truncate" style={{ color: ink }} title={r.message || r.name}>
                              {r.name}
                            </span>
                          </div>
                          <div className="text-right font-mono" style={{ color: nBasesOut != null ? ink : muted }}>
                            {nBasesOut != null ? nBasesOut : "\u2014"}
                          </div>
                          <div className="text-right font-mono" style={{ color: qvMean != null ? ink : muted }}>
                            {qvMean != null ? qvMean.toFixed(1) : "\u2014"}
                          </div>
                          <div
                            className="text-right font-mono font-medium"
                            style={{ color: lqvColor }}
                          >
                            {lowestQv != null ? lowestQv : "\u2014"}
                          </div>
                          <div
                            className="text-right font-mono"
                            style={{ color: nCount == null ? muted : nCount > 0 ? amber : ink }}
                          >
                            {nCount != null ? nCount : "\u2014"}
                          </div>
                          <div
                            className="text-right font-mono"
                            style={{ color: extended ? teal : muted, fontWeight: extended ? 600 : 400 }}
                          >
                            {extended ? `+${extBasesAdded}` : "\u2014"}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Raw log lines (preprocess events, errors) — appended below the table */}
                  {logs.length > 0 && (
                    <div
                      className="font-mono text-[10px] max-h-32 overflow-y-auto"
                      style={{ background: "#1F2A33", color: "#D8E2EE", borderTop: `1px solid ${border}` }}
                    >
                      {logs.slice(-50).map((l, i) => (
                        <div
                          key={i}
                          className="px-3 py-0.5 truncate"
                          style={{ color: l.level === "error" ? "#FFB4AB" : "#D8E2EE" }}
                          title={l.message}
                        >
                          {l.message}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                              )}
                            </section>
                          </div>
                        </div>
                      </div>

        {showAdvanced && (
          <AdvModal
            adv={adv}
            onChange={setAdvField}
            onClose={() => setShowAdvanced(false)}
          />
        )}
                    </div>
                  );
                }

// ---------- Advanced parameters popup (modal) ----------
function AdvModal({ adv, onChange, onClose }) {
  // Group definitions. Each field has a key (state field name), label, type
  // (bool/int/float), and optional hint text. The onChange handler receives
  // (key, value) and updates the adv state in the parent.
  const groups = [
    {
      title: "Re-basecall (v1.3+)",
      fields: [
        { key: "rebasecallData14", label: "Re-basecall from DATA1–4 channels", type: "bool" },
        { key: "minRebasecallLen", label: "Min rebasecall length",             type: "int",   hint: "ignore traces shorter than this" },
        { key: "extendMinSnr",     label: "Extend min SNR threshold",          type: "float", hint: "extend bases below this SNR" },
      ],
    },
    {
      title: "Signal processing",
      fields: [
        { key: "baselineSmooth", label: "Baseline smoothing",    type: "bool" },
        { key: "doSmooth",       label: "Trace smoothing",       type: "bool" },
        { key: "smoothWindow",   label: "Smoothing window (bases)", type: "int" },
        { key: "setAbiLimits",   label: "Set ABI signal limits", type: "bool" },
      ],
    },
    {
      title: "Filenames & QC",
      fields: [
        { key: "stripWellId",     label: "Strip well-ID from .ab1 names", type: "bool" },
        { key: "skipShorterThan", label: "Skip traces shorter than (bases)", type: "int" },
      ],
    },
    {
      title: "Leader-base drop",
      fields: [
        { key: "leadDropEnabled", label: "Drop low-QV leader bases", type: "bool", hint: "currently disabled in practice (writer bug)" },
        { key: "leadDropQv",      label: "Leader-drop QV threshold", type: "int" },
      ],
    },
  ];

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 26, 35, 0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: paper,
          borderRadius: 10,
          border: `1px solid ${border}`,
          boxShadow: "0 20px 50px rgba(0,0,0,0.25)",
          width: "min(560px, 92vw)",
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          className="flex items-center justify-between px-5 py-3 border-b"
          style={{ borderColor: border }}
        >
          <h3 className="text-lg font-bold" style={{ color: ink }}>
            Advanced processing parameters
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-xl leading-none px-2"
            style={{ color: muted }}
          >
            {"\u00d7"}
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4" style={{ flex: 1 }}>
          <div
            className="rounded-md p-3 mb-4 text-xs"
            style={{
              background: "#FFF8E1",
              color: "#7A5A00",
              border: "1px solid #E0C36F",
            }}
          >
            <strong>Placeholder.</strong> These defaults mirror what the CLI / PT pipeline uses internally.
            Changes here are <em>not</em> wired to the run command yet — left for a future version
            when the other team's samples may need fine-tuning.
          </div>

          {groups.map((g) => (
            <div key={g.title} className="mb-5">
              <h4
                className="text-sm font-semibold uppercase tracking-wide mb-2"
                style={{ color: panelDark }}
              >
                {g.title}
              </h4>
              <div className="flex flex-col gap-2">
                {g.fields.map((f) => (
                  <label
                    key={f.key}
                    className="flex items-center justify-between gap-3 text-sm py-1"
                    style={{ color: ink }}
                  >
                    <span className="flex-1">
                      {f.label}
                      {f.hint && (
                        <span className="block text-[11px] mt-0.5" style={{ color: muted }}>
                          {f.hint}
                        </span>
                      )}
                    </span>
                    {f.type === "bool" ? (
                      <input
                        type="checkbox"
                        checked={!!adv[f.key]}
                        onChange={(e) => onChange(f.key, e.target.checked)}
                        style={{ accentColor: panelDark, width: 18, height: 18 }}
                      />
                    ) : (
                      <input
                        type="number"
                        step={f.type === "float" ? "0.1" : "1"}
                        value={adv[f.key]}
                        onChange={(e) => {
                          const v = e.target.value;
                          const num = f.type === "float" ? parseFloat(v) : parseInt(v, 10);
                          onChange(f.key, Number.isNaN(num) ? 0 : num);
                        }}
                        className="px-2 py-1 rounded border font-mono text-sm w-24 text-right"
                        style={{ borderColor: border, color: ink, background: "#FAFBFA" }}
                      />
                    )}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div
          className="flex justify-end gap-2 px-5 py-3 border-t"
          style={{ borderColor: border, background: "#FAFBFA" }}
        >
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded text-sm font-medium"
            style={{ border: `1px solid ${border}`, background: paper, color: ink }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

                // ---------- Mode card (compact mode selector) ----------
function ModeCard({ selected, onClick, title, steps }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left p-3 rounded-lg border-2 transition-colors"
      style={{
        borderColor: selected ? panelDark : border,
        background: selected ? "#F0F4F8" : inputBg,
      }}
    >
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-sm font-semibold" style={{ color: ink }}>
          {title}
        </span>
        {selected && (
          <CheckCircle2 size={14} color={panelDark} />
        )}
      </div>
      <ol className="text-xs space-y-0.5" style={{ color: muted }}>
        {steps.map((s, i) => (
          <li key={i} className="flex gap-1.5">
            <span style={{ color: panelDark, fontWeight: 600 }}>{i + 1}.</span>
            <span>{s}</span>
          </li>
        ))}
      </ol>
    </button>
  );
}
