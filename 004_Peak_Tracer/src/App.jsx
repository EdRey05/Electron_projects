import React, { useState, useCallback, useEffect, useMemo } from "react";
import {
  Activity,
  FolderInput,
  FolderOutput,
  Play,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Settings,
  Eye,
  EyeOff,
  RotateCcw,
  ExternalLink,
} from "lucide-react";

// ---------- design tokens (mirror SequenceBindingFinder for hub consistency) ----------
const paper = "#F5F7F6";
const ink = "#1F2A33";
const border = "#DCE5E1";
const panelDark = "#1F3A5F";        // primary accent — matches Sequence Binding Finder
const panelDarkInk = "#FFFFFF";
const teal = "#3FB6A8";             // success / "trace looks good"
const amber = "#E0A52A";            // warning / mixed-base
const coral = "#E26B5A";            // error / process failed
const muted = "#8FA39D";            // secondary text
const inputBg = "#FFFFFF";

// ---------- default settings (mirrors BBI's actual PeakTrace RP 6.961 config from Aug 24 2026 screenshot) ----------
const DEFAULT_SETTINGS = {
  mode: "rp",                       // "rp" | "full" | "passthrough"  — RP matches PeakTrace RP
  cleanBaseline: true,              // "clean baseline" checkbox in PeakTrace RP — ON
  smoothingLevel: 3,                // "extra smoothing level" in PeakTrace RP — 3
                                   // (maps to Savitzky-Golay window = 2*level+1 = 7)
  smoothingOrder: 2,                // Savitzky-Golay polynomial order
  baselineWindow: 400,              // rolling baseline window in scan points
  baselinePercentile: 10,           // low-percentile floor for baseline
  applyPeakResolution: true,        // "no peak resolution" unchecked → RP does apply some resolution
  waveletSharpening: false,         // OFF in RP mode; ON for full PeakTrace emulation
  skipShorterThan: 500,             // "skip short/pcr base" in PeakTrace RP
  setAbiLimits: true,               // "set abi limits" checkbox — clamp output to uint16 range
  traceRescaleFactor: 0.5,          // PeakTrace RP rescales channel data to ~½ input amplitude (verified Aug 24 on real data)
  dropLeadingBase: true,            // Drop leading-base injection artifact (verified Aug 24 — seq7 starts with C, pt starts with G)

  // Basecaller settings
  qualityThreshold: 20,             // "good quality threshold" — Q20 = "good" base
  nBaseThreshold: 5,                // "n base threshold" — QV below this becomes N
  mixedPeakThreshold: 0,            // "mixed peak threshold" — 0% = NO mixed bases (BBI uses pure single-base mode)
  qAverageTrimValue: 9,             // "q average trim value" — 9
  qAverageTrimWindow: 40,           // "q average trim window" — 40
  trim3EndOnly: true,               // "trim 3' end only" — ON (critical, don't trim 5')
  signalStartPeak: "auto",          // "signal start peak" — auto
  goodBaseImprovement: -10,         // "good base improvement" — -10

  // v1.3: Re-basecall from raw channels (recovers late reads Seq7 dropped)
  rebasecallData14: false,          // re-call peaks from DATA1-4 full-resolution channels
  minRebasecallLen: 1000,           // only attempt on reads >= this many bases
  extendMinSnr: 1.3,                // min SNR for re-basecalled peaks

  // Output settings
  filenameSuffix: "",                   // PeakTrace RP strips well ID, doesn't add suffix (Aug 24 real-data finding)
  stripWellId: true,                    // Default ON: strip trailing _C09 etc.
  preserveMetadata: true,
  emitSeq: true,                        // PeakTrace emits .seq; Ed confirmed Aug 24 some customers need them. ON by default.
  maxWorkers: 4,
};

const MODES = [
  {
    value: "rp",
    label: "Raw Proportional (RP)",
    desc: "Match current Nucleics behavior. Peak heights kept proportional to raw signal — best for SNP / mixed-base detection.",
  },
  {
    value: "full",
    label: "Full PeakTrace (with sharpening)",
    desc: "Adds wavelet sharpening to resolve overlapping peaks past base 850. Best for maximum read length.",
  },
  {
    value: "passthrough",
    label: "Pass-through (no processing)",
    desc: "Skip our processing. Use Seq7's KB basecall verbatim. Useful as an A/B baseline.",
  },
];

// ---------- helpers ----------
function fmtBytes(n) {
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function statusColor(status) {
  if (status === "ok") return teal;
  if (status === "warn") return amber;
  if (status === "error") return coral;
  return muted;
}

// ---------- numeric slider widget (reusable across all settings groups) ----------
function NumSlider({ label, value, onChange, min, max, step, suffix }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-xs">
        <span style={{ color: muted }}>{label}</span>
        <span className="font-mono font-medium" style={{ color: ink }}>
          {value}{suffix || ""}
        </span>
      </div>
      <input
        type="range"
        className="pt-range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

// ---------- collapsible section (for advanced settings hidden by default) ----------
function Section({ title, icon: Icon, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="mb-6">
      <button
        type="button"
        className="flex items-center gap-2 mb-3 w-full text-left"
        onClick={() => setOpen(!open)}
      >
        {Icon && <Icon size={16} color={panelDark} />}
        <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: panelDark }}>
          {title}
        </h2>
        <span className="ml-auto">
          {open ? <ChevronUp size={16} color={muted} /> : <ChevronDown size={16} color={muted} />}
        </span>
      </button>
      {open && <div>{children}</div>}
    </section>
  );
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
  const [showAdvanced, setShowAdvanced] = useState(false);

  // ---- run state ----
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState([]);   // [{name, status, message, outputPath?}]
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState([]);
  const [expanded, setExpanded] = useState(null);

  // ---- subscribe to streaming events ----
  useEffect(() => {
    if (!window.api) return;
    const offProgress = window.api.onProgress((msg) => {
      if (msg.type === "file_start") {
        setResults((prev) => {
          const existing = prev.findIndex((r) => r.name === msg.name);
          if (existing >= 0) return prev;
          return [...prev, { name: msg.name, status: "running", message: "Processing…" }];
        });
      } else if (msg.type === "file_done") {
        setResults((prev) =>
          prev.map((r) =>
            r.name === msg.name
              ? {
                  ...r,
                  status: msg.ok ? "ok" : "error",
                  message: msg.message || (msg.ok ? "OK" : "Failed"),
                  outputPath: msg.outputPath,
                  qc: msg.qc || null,
                  extended: msg.extended ?? false,
                  extBasesAdded: msg.ext_bases_added ?? 0,
                  mapRSquared: msg.map_r_squared ?? 0,
                }
              : r
          )
        );
      } else if (msg.type === "batch_progress") {
        setProgress(msg.percent);
      }
    });
    const offLog = window.api.onLog((msg) => {
      setLogs((prev) => [...prev.slice(-200), msg]);   // keep last 200
    });
    const offDone = window.api.onDone((msg) => {
      setRunning(false);
      setProgress(100);
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
      setProgress(0);
    });
  }, [inputDir]);

  // ---- auto-suggest output = parent of input ----
  useEffect(() => {
    if (!inputDir || outputDir) return;
    // inputDir like "C:/.../Plate123/raw" → parent is "C:/.../Plate123"
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
    setProgress(0);
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
    setProgress(0);
    setLogs([]);
  }, []);

  const onResetSettings = useCallback(() => setSettings(DEFAULT_SETTINGS), []);

  // ---- derived: any file selected? runnable? ----
  const runnable = !!inputDir && !!outputDir && inputFiles.length > 0 && !running;
  const okCount = results.filter((r) => r.status === "ok").length;
  const errCount = results.filter((r) => r.status === "error").length;
  const doneCount = results.length;

  // ---- render ----
  return (
    <div style={{ background: paper, color: ink, minHeight: "100%", fontFamily: "'IBM Plex Sans', sans-serif" }}>
      <div className="max-w-6xl mx-auto px-6 py-10">
        {/* Header */}
        <div className="flex items-start justify-between mb-10 border-b pb-6" style={{ borderColor: border }}>
          <div className="flex items-center gap-3">
            <div
              style={{ background: panelDark }}
              className="w-11 h-11 rounded-md flex items-center justify-center shrink-0"
            >
              <Activity size={22} color="#FFFFFF" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold font-display" style={{ color: ink }}>
                Peak Tracer
              </h1>
              <p className="text-xs mt-0.5" style={{ color: muted }}>
                In-house replacement for Nucleics Auto PeakTrace RP · Sanger .ab1 trace processing
              </p>
            </div>
          </div>
          <button
            type="button"
            className="text-xs flex items-center gap-1.5 px-3 py-1.5 rounded border"
            style={{ borderColor: border, color: muted, background: inputBg }}
            onClick={() => setShowAdvanced(!showAdvanced)}
          >
            {showAdvanced ? <EyeOff size={13} /> : <Eye size={13} />}
            {showAdvanced ? "Hide advanced" : "Show advanced"}
          </button>
        </div>

        {/* ---- INPUT / OUTPUT ---- */}
        <Section title="1. Plate folder" icon={FolderInput}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* INPUT */}
            <div className="rounded-lg overflow-hidden border" style={{ borderColor: border }}>
              <div className="px-4 py-2 text-xs flex items-center justify-between" style={{ background: "#EEF3F1", color: muted }}>
                <span>Input folder (.ab1 files)</span>
                {inputFiles.length > 0 && (
                  <span className="font-mono">{inputFiles.length} files</span>
                )}
              </div>
              <div className="p-3 flex gap-2" style={{ background: inputBg }}>
                <input
                  type="text"
                  readOnly
                  value={inputDir}
                  placeholder="Pick the raw/ subfolder…"
                  className="flex-1 px-3 py-2 text-sm rounded border font-mono"
                  style={{ borderColor: border, color: ink, background: "#FAFBFA" }}
                />
                <button
                  type="button"
                  className="px-3 py-2 rounded text-sm flex items-center gap-1.5 shrink-0"
                  style={{ background: panelDark, color: panelDarkInk }}
                  onClick={onPickInput}
                >
                  <FolderInput size={14} /> Pick
                </button>
              </div>
              {inputFiles.length > 0 && (
                <div className="px-4 py-2 text-xs font-mono border-t max-h-32 overflow-y-auto pt-scroll"
                     style={{ borderColor: border, color: muted, background: "#FAFBFA" }}>
                  {inputFiles.slice(0, 6).map((f) => (
                    <div key={f.path} className="truncate">
                      {f.name} <span style={{ color: "#B5C2BD" }}>({fmtBytes(f.sizeBytes)})</span>
                    </div>
                  ))}
                  {inputFiles.length > 6 && (
                    <div style={{ color: muted }}>… and {inputFiles.length - 6} more</div>
                  )}
                </div>
              )}
            </div>

            {/* OUTPUT */}
            <div className="rounded-lg overflow-hidden border" style={{ borderColor: border }}>
              <div className="px-4 py-2 text-xs flex items-center justify-between" style={{ background: "#EEF3F1", color: muted }}>
                <span>Output folder (parent of input, by default)</span>
                {outputDir && (
                  <button
                    type="button"
                    className="text-xs flex items-center gap-1"
                    style={{ color: muted }}
                    onClick={() => window.api.openFolder(outputDir)}
                  >
                    <ExternalLink size={11} /> Reveal
                  </button>
                )}
              </div>
              <div className="p-3 flex gap-2" style={{ background: inputBg }}>
                <input
                  type="text"
                  readOnly
                  value={outputDir}
                  placeholder="Auto-set to parent of input…"
                  className="flex-1 px-3 py-2 text-sm rounded border font-mono"
                  style={{ borderColor: border, color: ink, background: "#FAFBFA" }}
                />
                <button
                  type="button"
                  className="px-3 py-2 rounded text-sm flex items-center gap-1.5 shrink-0"
                  style={{ background: panelDark, color: panelDarkInk }}
                  onClick={onPickOutput}
                >
                  <FolderOutput size={14} /> Pick
                </button>
              </div>
              <div className="px-4 py-2 text-xs border-t" style={{ borderColor: border, color: muted, background: "#FAFBFA" }}>
                {settings.filenameSuffix ? (
                  <>Files will be written as <span className="font-mono">NAME{settings.filenameSuffix}.ab1</span></>
                ) : (
                  <>Files will be written with the same name as the input (no suffix).</>
                )}
              </div>
            </div>
          </div>
        </Section>

        {/* ---- SETTINGS ---- */}
        <Section title="2. Processing settings" icon={Settings}>
          <div className="rounded-lg border p-5" style={{ borderColor: border, background: inputBg }}>
            {/* Mode dropdown */}
            <div className="mb-5">
              <label className="text-xs font-semibold uppercase tracking-wide" style={{ color: muted }}>
                Mode
              </label>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-2">
                {MODES.map((m) => {
                  const selected = settings.mode === m.value;
                  return (
                    <button
                      key={m.value}
                      type="button"
                      onClick={() => setSettings((s) => ({ ...s, mode: m.value }))}
                      className="text-left p-3 rounded-lg border-2 transition-colors"
                      style={{
                        borderColor: selected ? panelDark : border,
                        background: selected ? "#F0F4F8" : inputBg,
                      }}
                    >
                      <div className="text-sm font-medium" style={{ color: ink }}>
                        {m.label}
                      </div>
                      <div className="text-xs mt-1" style={{ color: muted }}>
                        {m.desc}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Advanced settings — mirrors every PeakTrace RP option from the Aug 24 2026 screenshot */}
            {showAdvanced && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4 mt-4 pt-4 border-t" style={{ borderColor: border }}>
                {/* --- Group 1: Trace processing --- */}
                <label className="flex items-center gap-2 text-sm cursor-pointer md:col-span-2">
                  <input
                    type="checkbox"
                    checked={settings.cleanBaseline}
                    onChange={(e) => setSettings((s) => ({ ...s, cleanBaseline: e.target.checked }))}
                  />
                  <span style={{ color: ink }}>Clean baseline (apply baseline subtraction)</span>
                  <span className="text-xs" style={{ color: muted }}>(matches PeakTrace RP default: ON)</span>
                </label>
                <NumSlider
                  label="Smoothing level (extra smoothing)"
                  value={settings.smoothingLevel}
                  onChange={(v) => setSettings((s) => ({ ...s, smoothingLevel: v }))}
                  min={0} max={10} step={1}
                  suffix={` (Savitzky-Golay win=${settings.smoothingLevel * 2 + 1})`}
                />
                <NumSlider
                  label="Smoothing polynomial order"
                  value={settings.smoothingOrder}
                  onChange={(v) => setSettings((s) => ({ ...s, smoothingOrder: v }))}
                  min={1} max={5} step={1}
                />
                <NumSlider
                  label="Baseline window"
                  value={settings.baselineWindow}
                  onChange={(v) => setSettings((s) => ({ ...s, baselineWindow: v }))}
                  min={50} max={2000} step={50}
                />
                <NumSlider
                  label="Baseline percentile"
                  value={settings.baselinePercentile}
                  onChange={(v) => setSettings((s) => ({ ...s, baselinePercentile: v }))}
                  min={1} max={50} step={1}
                  suffix="%"
                />
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.applyPeakResolution}
                    onChange={(e) => setSettings((s) => ({ ...s, applyPeakResolution: e.target.checked }))}
                  />
                  <span style={{ color: ink }}>Apply light peak resolution</span>
                  <span className="text-xs" style={{ color: muted }}>(RP does this despite the name)</span>
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.waveletSharpening}
                    onChange={(e) => setSettings((s) => ({ ...s, waveletSharpening: e.target.checked }))}
                  />
                  <span style={{ color: ink }}>Enable wavelet sharpening</span>
                  <span className="text-xs" style={{ color: muted }}>(Full mode only)</span>
                </label>
                <NumSlider
                  label="Skip reads shorter than"
                  value={settings.skipShorterThan}
                  onChange={(v) => setSettings((s) => ({ ...s, skipShorterThan: v }))}
                  min={0} max={2000} step={50}
                  suffix=" bases"
                />
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.setAbiLimits}
                    onChange={(e) => setSettings((s) => ({ ...s, setAbiLimits: e.target.checked }))}
                  />
                  <span style={{ color: ink }}>Set ABI limits (clamp output values)</span>
                </label>
                <NumSlider
                  label="Trace rescale factor"
                  value={settings.traceRescaleFactor}
                  onChange={(v) => setSettings((s) => ({ ...s, traceRescaleFactor: v }))}
                  min={0.1} max={2.0} step={0.05}
                  suffix="x (≈0.5 matches PeakTrace RP)"
                />
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.dropLeadingBase}
                    onChange={(e) => setSettings((s) => ({ ...s, dropLeadingBase: e.target.checked }))}
                  />
                  <span style={{ color: ink }}>Drop leading-base artifact</span>
                  <span className="text-xs" style={{ color: muted }}>(verified: PT skips first base)</span>
                </label>

                {/* --- Group 2: Basecaller --- */}
                <NumSlider
                  label="Quality threshold (good QV)"
                  value={settings.qualityThreshold}
                  onChange={(v) => setSettings((s) => ({ ...s, qualityThreshold: v }))}
                  min={5} max={60} step={1}
                />
                <NumSlider
                  label="N-base threshold (QV → N)"
                  value={settings.nBaseThreshold}
                  onChange={(v) => setSettings((s) => ({ ...s, nBaseThreshold: v }))}
                  min={0} max={30} step={1}
                />
                <NumSlider
                  label="Mixed peak threshold"
                  value={settings.mixedPeakThreshold}
                  onChange={(v) => setSettings((s) => ({ ...s, mixedPeakThreshold: v }))}
                  min={0} max={200} step={5}
                  suffix="%"
                />
                <NumSlider
                  label="Q-average trim value"
                  value={settings.qAverageTrimValue}
                  onChange={(v) => setSettings((s) => ({ ...s, qAverageTrimValue: v }))}
                  min={0} max={40} step={1}
                />
                <NumSlider
                  label="Q-average trim window"
                  value={settings.qAverageTrimWindow}
                  onChange={(v) => setSettings((s) => ({ ...s, qAverageTrimWindow: v }))}
                  min={5} max={200} step={5}
                />
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.trim3EndOnly}
                    onChange={(e) => setSettings((s) => ({ ...s, trim3EndOnly: e.target.checked }))}
                  />
                  <span style={{ color: ink }}>Trim 3' end only</span>
                  <span className="text-xs" style={{ color: muted }}>(critical: keep 5' primer intact)</span>
                </label>
                <NumSlider
                  label="Good base improvement delta"
                  value={settings.goodBaseImprovement}
                  onChange={(v) => setSettings((s) => ({ ...s, goodBaseImprovement: v }))}
                  min={-999} max={999} step={1}
                />

                {/* v1.3: Re-basecall from raw channels — the differentiating feature */}
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.rebasecallData14}
                    onChange={(e) => setSettings((s) => ({ ...s, rebasecallData14: e.target.checked }))}
                  />
                  <span style={{ color: ink }}>Re-basecall from raw channels</span>
                  <span className="text-xs" style={{ color: muted }}>(recovers late reads Seq7 missed)</span>
                </label>
                <NumSlider
                  label="Min read length for re-basecall"
                  value={settings.minRebasecallLen}
                  onChange={(v) => setSettings((s) => ({ ...s, minRebasecallLen: v }))}
                  min={500} max={2000} step={50}
                  suffix="bases"
                />
                <NumSlider
                  label="Re-basecall min SNR"
                  value={settings.extendMinSnr}
                  onChange={(v) => setSettings((s) => ({ ...s, extendMinSnr: v }))}
                  min={1.0} max={3.0} step={0.1}
                  decimalScale={1}
                />

                <NumSlider
                  label="Max parallel workers"
                  value={settings.maxWorkers}
                  onChange={(v) => setSettings((s) => ({ ...s, maxWorkers: v }))}
                  min={1} max={16} step={1}
                />

                {/* --- Group 3: Output --- */}
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.preserveMetadata}
                    onChange={(e) => setSettings((s) => ({ ...s, preserveMetadata: e.target.checked }))}
                  />
                  <span style={{ color: ink }}>Preserve Seq7 metadata</span>
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.emitSeq}
                    onChange={(e) => setSettings((s) => ({ ...s, emitSeq: e.target.checked }))}
                  />
                  <span style={{ color: ink }}>Emit .seq files (PeakTrace artifact)</span>
                  <span className="text-xs" style={{ color: muted }}>(some customers need these — Ed Aug 24)</span>
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.stripWellId}
                    onChange={(e) => setSettings((s) => ({ ...s, stripWellId: e.target.checked }))}
                  />
                  <span style={{ color: ink }}>Strip well-ID suffix from filename</span>
                  <span className="text-xs" style={{ color: muted }}>(e.g. _C09 → removed; matches PeakTrace RP)</span>
                </label>
                <div className="flex flex-col gap-1 md:col-span-2">
                  <label className="text-xs" style={{ color: muted }}>Filename suffix (only added if strip is OFF)</label>
                  <input
                    type="text"
                    value={settings.filenameSuffix}
                    onChange={(e) => setSettings((s) => ({ ...s, filenameSuffix: e.target.value }))}
                    className="px-3 py-2 text-sm rounded border font-mono"
                    style={{ borderColor: border, color: ink, background: inputBg }}
                    placeholder="(empty)"
                  />
                </div>
              </div>
            )}

            <div className="flex justify-end mt-4">
              <button
                type="button"
                className="text-xs flex items-center gap-1.5"
                style={{ color: muted }}
                onClick={onResetSettings}
              >
                <RotateCcw size={12} /> Reset to defaults
              </button>
            </div>
          </div>
        </Section>

        {/* ---- RUN ---- */}
        <Section title="3. Run" icon={Play}>
          <div className="rounded-lg border p-5" style={{ borderColor: border, background: inputBg }}>
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="text-sm" style={{ color: muted }}>
                {inputFiles.length === 0
                  ? "Pick an input folder to enable."
                  : running
                  ? `Processing ${doneCount + 1} of ${inputFiles.length}…`
                  : doneCount > 0
                  ? `Done — ${okCount} ok, ${errCount} failed, ${inputFiles.length - doneCount} skipped.`
                  : `Ready — ${inputFiles.length} file${inputFiles.length === 1 ? "" : "s"} to process.`}
              </div>
              <button
                type="button"
                className="px-5 py-2.5 rounded-md text-sm font-semibold flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: panelDark, color: panelDarkInk }}
                disabled={!runnable}
                onClick={onRun}
              >
                <Play size={14} />
                {running ? "Running…" : "Run Peak Tracer"}
              </button>
            </div>

            {/* Progress bar */}
            {(running || progress > 0) && (
              <div className="mt-3 h-1.5 rounded-full overflow-hidden" style={{ background: border }}>
                <div
                  className="h-full transition-all"
                  style={{ width: `${progress}%`, background: panelDark }}
                />
              </div>
            )}
          </div>
        </Section>

        {/* ---- RESULTS ---- */}
        {results.length > 0 && (
          <section>
            <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: panelDark }}>
                  4. Results
                </h2>
                <span className="text-xs font-mono" style={{ color: muted }}>
                  {okCount}/{results.length} ok
                </span>
              </div>
              <button
                type="button"
                className="text-xs flex items-center gap-1.5 px-3 py-1.5 rounded border"
                style={{ borderColor: border, color: muted, background: inputBg }}
                onClick={onReset}
              >
                <RotateCcw size={12} /> Clear
              </button>
            </div>

            <div className="rounded-lg border overflow-hidden" style={{ borderColor: border }}>
              {results.map((r, i) => {
                const isOpen = expanded === i;
                const color = statusColor(r.status);
                return (
                  <div key={r.name + i} style={{ borderTop: i === 0 ? "none" : `1px solid ${border}` }}>
                    <div
                      className="flex items-center gap-3 px-4 py-3 cursor-pointer"
                      onClick={() => setExpanded(isOpen ? null : i)}
                    >
                      {r.status === "ok" ? (
                        <CheckCircle2 size={17} color={teal} className="shrink-0" />
                      ) : r.status === "error" ? (
                        <XCircle size={17} color={coral} className="shrink-0" />
                      ) : (
                        <AlertTriangle size={17} color={muted} className="shrink-0" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">{r.name}</div>
                        <div className="text-xs mt-0.5 truncate" style={{ color: muted }}>
                          {r.message}
                        </div>
                      </div>
                      {r.qc && (
                        <div
                          className="font-mono text-xs shrink-0 px-2 py-0.5 rounded"
                          style={{ color: muted, background: "#F0F4F8" }}
                        >
                          {r.qc.length} bp
                        </div>
                      )}
                      <ChevronDown size={16} color={muted} className={isOpen ? "rotate-180 transition-transform" : "transition-transform"} />
                    </div>

                    {isOpen && (
                      <div className="px-4 pb-4 pt-1">
                        {r.outputPath && (
                          <div className="text-xs font-mono mb-2" style={{ color: muted }}>
                            → {r.outputPath}
                          </div>
                        )}
                        {r.qc && (
                          <pre
                            className="font-mono text-[10px] leading-snug rounded-md p-3 overflow-x-auto whitespace-pre-wrap max-h-40 pt-scroll"
                            style={{ background: panelDark, color: "#D8E2EE" }}
                          >
                            {JSON.stringify(r.qc, null, 2)}
                          </pre>
                        )}
                        {(r.extended || r.extBasesAdded > 0) && (
                          <div className="font-mono text-xs mt-2 flex items-center gap-2" style={{ color: teal }}>
                            <span>+{r.extBasesAdded} bases from raw channels</span>
                            {r.mapRSquared > 0 && (
                              <span style={{ color: muted }}>r²={r.mapRSquared.toFixed(3)}</span>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* ---- LOGS (collapsible, last) ---- */}
        {logs.length > 0 && (
          <section className="mt-8">
            <details>
              <summary className="text-xs cursor-pointer" style={{ color: muted }}>
                Show log ({logs.length} lines)
              </summary>
              <pre
                className="font-mono text-[10px] mt-2 rounded-md p-3 max-h-48 overflow-y-auto pt-scroll"
                style={{ background: "#1F2A33", color: "#D8E2EE" }}
              >
                {logs.map((l, i) => (
                  <div key={i} style={{ color: l.level === "error" ? "#FFB4AB" : "#D8E2EE" }}>
                    [{l.level}] {l.message}
                  </div>
                ))}
              </pre>
            </details>
          </section>
        )}
      </div>
    </div>
  );
}
