/**
 * KM Plotter — main application shell.
 *
 * Flow (mirrors the Streamlit app):
 *   1. Load the clinical file (required) and optionally an RNA file.
 *   2. Pick the time-to-event column and the event-observation column.
 *   3. Map the event column's values onto 0 (no event) and 1 (event).
 *   4. Optionally define subgroups (1-5 variables × 1-5 groups each).
 *   5. Generate the plot, then export it as PNG / the data as XLSX.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  FileSpreadsheet,
  FileUp,
  FolderOpen,
  Image as ImageIcon,
  Info,
  Layers,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";

import { Alert, Badge, Button, Checkbox, EmptyState, Field, Panel, Select, Slider } from "./components/ui.jsx";
import KmPlot from "./components/KmPlot.jsx";

const MAX_VARIABLES = 5;
const MAX_GROUPS = 5;

// The Electron preload exposes `window.api`. We read it lazily (through a
// proxy) rather than capturing it at module load, so the binding always
// reflects the live bridge — this also keeps the app testable in a plain
// browser where a stub can be installed at any time.
const api = new Proxy(
  {},
  {
    get(_target, prop) {
      return window.api ? window.api[prop] : undefined;
    },
  }
);

// ---------------------------------------------------------------- helpers

function fileName(path) {
  if (!path) return "";
  return path.split(/[\\/]/).pop();
}

function defaultGroupName(values) {
  if (!values || !values.length) return "";
  if (values.length === 1) return String(values[0]);
  return `${values.length} values`;
}

// ---------------------------------------------------------------- App

export default function App() {
  // --- file state
  const [clinical, setClinical] = useState(null);
  const [rna, setRna] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  // --- analysis parameters
  const [timeColumn, setTimeColumn] = useState("");
  const [eventColumn, setEventColumn] = useState("");
  const [noEventValues, setNoEventValues] = useState([]);
  const [eventValues, setEventValues] = useState([]);

  // --- subgroup definitions
  const [useSubgroups, setUseSubgroups] = useState(false);
  const [nVariables, setNVariables] = useState(1);
  const [variables, setVariables] = useState([]);

  // --- plot options
  const [showCI, setShowCI] = useState(true);
  const [showAtRisk, setShowAtRisk] = useState(true);
  const [showCensors, setShowCensors] = useState(true);
  const [legendOnSide, setLegendOnSide] = useState(false);
  const [detail, setDetail] = useState(95);
  const [alpha, setAlpha] = useState(0.05);

  // --- results
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);

  // ---------------------------------------------------------------- files

  const pickClinical = useCallback(async () => {
    setError(null);
    const res = await api?.pickFile({
      title: "Select the clinical data file (tab-separated, .txt)",
      filters: [{ name: "Text/TSV", extensions: ["txt", "tsv", "tab"] }],
    });
    if (!res) return;
    await loadFiles(res.path, rna?.path || null, true);
  }, [rna]);

  const pickRna = useCallback(async () => {
    setError(null);
    const res = await api?.pickFile({
      title: "Select the RNA expression file (optional)",
      filters: [{ name: "Text/TSV", extensions: ["txt", "tsv", "tab"] }],
    });
    if (!res) return;
    await loadFiles(clinical?.path || null, res.path, true);
  }, [clinical]);

  const loadFiles = useCallback(async (clinicalPath, rnaPath, reset) => {
    if (!clinicalPath) {
      setError("A clinical file is required.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api.run({
        command: "inspect",
        clinicalPath,
        rnaPath: rnaPath || null,
      });
      if (!res.ok) {
        setError(res.error || "Could not read the file.");
        return;
      }
      setClinical({ path: clinicalPath, ...res.clinical, options: res.options });
      setRna(res.rna ? { path: rnaPath, ...res.rna } : null);

      if (reset) {
        // Pick sensible defaults: first time column, then its matching status.
        const timeOpts = res.options.timeToEventOptions;
        const firstTime = timeOpts[0] || "";
        setTimeColumn(firstTime);
        setEventColumn(res.options.eventObservationOptions[0] || "");
        setNoEventValues([]);
        setEventValues([]);
        setVariables([]);
        setNVariables(1);
        setResult(null);
      }
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const resetAll = useCallback(() => {
    setClinical(null);
    setRna(null);
    setTimeColumn("");
    setEventColumn("");
    setNoEventValues([]);
    setEventValues([]);
    setVariables([]);
    setNVariables(1);
    setUseSubgroups(false);
    setResult(null);
    setError(null);
    setNotice(null);
  }, []);

  // -------------------------------------------------- event value mapping

  const [eventValueCounts, setEventValueCounts] = useState({});

  useEffect(() => {
    let cancelled = false;
    async function loadCounts() {
      if (!clinical || !eventColumn) {
        setEventValueCounts({});
        return;
      }
      try {
        const res = await api.run({
          command: "column",
          path: clinical.path,
          column: eventColumn,
        });
        if (!cancelled && res.ok) {
          setEventValueCounts({ column: res.column, values: res.values || [], histogram: res.histogram });
        }
      } catch {
        if (!cancelled) setEventValueCounts({});
      }
    }
    loadCounts();
    return () => {
      cancelled = true;
    };
  }, [clinical, eventColumn]);

  const toggleEventValue = useCallback((value, kind) => {
    const asStr = String(value);
    setError(null);
    if (kind === "no") {
      setNoEventValues((prev) =>
        prev.includes(asStr) ? prev.filter((v) => v !== asStr) : [...prev, asStr]
      );
      // A value cannot be both "no event" and "event".
      setEventValues((prev) => prev.filter((v) => v !== asStr));
    } else {
      setEventValues((prev) =>
        prev.includes(asStr) ? prev.filter((v) => v !== asStr) : [...prev, asStr]
      );
      setNoEventValues((prev) => prev.filter((v) => v !== asStr));
    }
  }, []);

  // ------------------------------------------------------------ subgroups

  const setVariable = useCallback((index, patch) => {
    setVariables((prev) => {
      const next = [...prev];
      while (next.length < MAX_VARIABLES) {
        next.push({ source: "clinical", column: "", mode: "tags", groups: [] });
      }
      next[index] = { ...next[index], ...patch };
      return next;
    });
  }, []);

  const variableColumns = useMemo(() => {
    if (!clinical) return [];
    return clinical.columns.filter((c) => c !== "PATIENT_ID");
  }, [clinical]);

  const rnaGenes = useMemo(() => (rna ? rna.genes : []), [rna]);

  // ----------------------------------------------------------- analysis

  const canGenerate = useMemo(
    () =>
      !!clinical &&
      !!timeColumn &&
      !!eventColumn &&
      noEventValues.length > 0 &&
      eventValues.length > 0 &&
      !loading,
    [clinical, timeColumn, eventColumn, noEventValues, eventValues, loading]
  );

  const buildVariablesPayload = useCallback(() => {
    if (!useSubgroups) return [];
    return variables.slice(0, nVariables).map((v) => ({
      source: v.source,
      column: v.column,
      mode: v.mode,
      groups: (v.groups || []).map((g) =>
        v.mode === "tags"
          ? { values: g.values || [], name: g.name }
          : { lo: g.lo, hi: g.hi, name: g.name }
      ),
    }));
  }, [useSubgroups, variables, nVariables]);

  const generate = useCallback(async () => {
    if (!canGenerate) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.run({
        command: "analyze",
        clinicalPath: clinical.path,
        rnaPath: rna?.path || null,
        timeColumn,
        eventColumn,
        noEventValues,
        eventValues,
        variables: buildVariablesPayload(),
        alpha,
      });
      if (!res.ok) {
        setError(res.error || "The analysis failed.");
        setResult(null);
        return;
      }
      setResult(res.result);
      setNotice(
        `${res.result.nCurves} curve${res.result.nCurves === 1 ? "" : "s"} from ${
          res.result.nPatients
        } patients.`
      );
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [canGenerate, clinical, rna, timeColumn, eventColumn, noEventValues, eventValues, buildVariablesPayload, alpha]);

  // ------------------------------------------------------------- export

  const exportPng = useCallback(async () => {
    if (!result) return;
    const svg = document.getElementById("km-plot-svg");
    if (!svg) {
      setError("The plot is not ready yet.");
      return;
    }
    setExporting(true);
    try {
      const png = await svgToPng(svg);
      const path = await api.pickSavePath({
        title: "Save the KM plot as PNG",
        defaultName: "KM_plot.png",
        filters: [{ name: "PNG image", extensions: ["png"] }],
      });
      if (!path) return;
      const ok = await api.writeBytes(path, png);
      if (!ok) {
        setError("Could not write the PNG file.");
        return;
      }
      setNotice(`Plot saved to ${fileName(path)}`);
      api.showItem(path);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setExporting(false);
    }
  }, [result]);

  const exportSvg = useCallback(async () => {
    if (!result) return;
    const svg = document.getElementById("km-plot-svg");
    if (!svg) return;
    const text = new XMLSerializer().serializeToString(svg);
    const bytes = new TextEncoder().encode(text);
    const path = await api.pickSavePath({
      title: "Save the KM plot as SVG",
      defaultName: "KM_plot.svg",
      filters: [{ name: "SVG image", extensions: ["svg"] }],
    });
    if (!path) return;
    const ok = await api.writeBytes(path, btoa(String.fromCharCode(...bytes)));
    if (!ok) {
      setError("Could not write the SVG file.");
      return;
    }
    setNotice(`Plot saved to ${fileName(path)}`);
    api.showItem(path);
  }, [result]);

  const exportExcel = useCallback(async () => {
    if (!result) return;
    setExporting(true);
    setError(null);
    try {
      const res = await api.run({
        command: "export",
        clinicalPath: clinical.path,
        rnaPath: rna?.path || null,
        timeColumn,
        eventColumn,
        noEventValues,
        eventValues,
        variables: buildVariablesPayload(),
        alpha,
        filename: "KM_results.xlsx",
      });
      if (!res.ok) {
        setError(res.error || "The export failed.");
        return;
      }
      const path = await api.pickSavePath({
        title: "Save the KM results as Excel",
        defaultName: res.filename,
        filters: [{ name: "Excel workbook", extensions: ["xlsx"] }],
      });
      if (!path) return;
      const ok = await api.writeBytes(path, res.base64);
      if (!ok) {
        setError("Could not write the Excel file.");
        return;
      }
      setNotice(`Results saved to ${fileName(path)}`);
      api.showItem(path);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setExporting(false);
    }
  }, [result, clinical, rna, timeColumn, eventColumn, noEventValues, eventValues, buildVariablesPayload, alpha]);

  // --------------------------------------------------------------- render

  return (
    <div className="flex h-full flex-col bg-[#0F1115] text-[#E6EAF0]">
      {/* ---------------------------------------------------------- header */}
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-[#232A34] bg-[#12151B] px-5 py-3">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-[#38BDF8]/10 p-2 text-[#38BDF8] ring-1 ring-[#38BDF8]/25">
            <Activity size={18} />
          </div>
          <div>
            <h1 className="text-[15px] font-semibold leading-tight">KM Plotter</h1>
            <p className="text-[11px] leading-tight text-[#6B7480]">
              Interactive Kaplan-Meier plot generator
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {clinical && (
            <Badge tone="info" className="max-w-[280px]">
              <FileUp size={11} />
              <span className="truncate">{fileName(clinical.path)}</span>
              <span className="text-[#6B7480]">· {clinical.nRows} rows</span>
            </Badge>
          )}
          {rna && (
            <Badge tone="good" className="max-w-[240px]">
              <Layers size={11} />
              <span className="truncate">{fileName(rna.path)}</span>
              <span className="text-[#6B7480]">· {rna.nRows} rows</span>
            </Badge>
          )}
          {clinical && (
            <Button variant="ghost" size="sm" icon={RefreshCw} onClick={resetAll}>
              Start over
            </Button>
          )}
        </div>
      </header>

      {/* ------------------------------------------------------------ body */}
      <div className="flex min-h-0 flex-1">
        {/* ------------------------------------------------------ sidebar */}
        <aside className="w-[330px] shrink-0 overflow-y-auto border-r border-[#232A34] bg-[#12151B] p-4">
          <div className="space-y-4">
            {/* --- files */}
            <Panel title="1 · Data files">
              <div className="space-y-2.5">
                <Button
                  variant={clinical ? "default" : "primary"}
                  icon={FileUp}
                  className="w-full"
                  onClick={pickClinical}
                  busy={loading}
                >
                  {clinical ? "Change clinical file" : "Choose clinical file…"}
                </Button>
                <Button
                  variant="default"
                  icon={Layers}
                  className="w-full"
                  onClick={pickRna}
                  disabled={!clinical}
                >
                  {rna ? "Change RNA file" : "Add RNA file (optional)"}
                </Button>
                {clinical && (
                  <p className="pt-1 text-[11px] leading-relaxed text-[#6B7480]">
                    The clinical file is tab-separated and may include <code className="text-[#8B95A5]">#</code>{" "}
                    comment lines with a data dictionary. It needs a{" "}
                    <code className="text-[#8B95A5]">PATIENT_ID</code> column.
                  </p>
                )}
              </div>
            </Panel>

            {/* --- endpoints */}
            {clinical && (
              <Panel title="2 · Survival endpoint">
                <div className="space-y-3">
                  <Select
                    label="Time-to-event column"
                    value={timeColumn}
                    onChange={setTimeColumn}
                    placeholder="Select a column…"
                    options={clinical.columns}
                  />
                  <Select
                    label="Event observation column"
                    value={eventColumn}
                    onChange={(v) => {
                      setEventColumn(v);
                      setNoEventValues([]);
                      setEventValues([]);
                    }}
                    placeholder="Select a column…"
                    options={clinical.options.eventObservationOptions}
                  />
                  {clinical.options.timeToEventOptions.length === 0 && (
                    <Alert tone="warn" title="No endpoint pair found">
                      This app looks for columns named{" "}
                      <code className="text-[#F5D98A]">OS_MONTHS</code> /{" "}
                      <code className="text-[#F5D98A]">OS_STATUS</code> (also RFS, PFS, DFS, DSS). You can still pick
                      any column by hand.
                    </Alert>
                  )}
                </div>
              </Panel>
            )}

            {/* --- 0/1 mapping */}
            {clinical && eventColumn && (
              <Panel
                title="3 · Event mapping"
                subtitle="Which values mean 'no event' and which mean 'event'?"
              >
                {eventValueCounts.values ? (
                  <ValueMapper
                    values={eventValueCounts.values}
                    noEventValues={noEventValues}
                    eventValues={eventValues}
                    onToggle={toggleEventValue}
                  />
                ) : (
                  <div className="py-3 text-center text-xs text-[#6B7480]">Loading values…</div>
                )}
                <div className="mt-3 flex items-center justify-between text-[11px] text-[#6B7480]">
                  <span>
                    <span className="text-[#4ADE80]">{noEventValues.length}</span> no-event ·{" "}
                    <span className="text-[#FB7185]">{eventValues.length}</span> event
                  </span>
                  {(noEventValues.length > 0 || eventValues.length > 0) && (
                    <button
                      className="text-[#6B7480] underline hover:text-[#E6EAF0]"
                      onClick={() => {
                        setNoEventValues([]);
                        setEventValues([]);
                      }}
                    >
                      clear
                    </button>
                  )}
                </div>
              </Panel>
            )}

            {/* --- subgroups */}
            {clinical && eventColumn && noEventValues.length > 0 && eventValues.length > 0 && (
              <Panel title="4 · Subgroups">
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => setUseSubgroups(false)}
                      className={`rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                        !useSubgroups
                          ? "border-[#38BDF8] bg-[#38BDF8]/10 text-[#38BDF8]"
                          : "border-[#2F3743] bg-[#1B2029] text-[#8B95A5] hover:border-[#3B4553]"
                      }`}
                    >
                      Single curve
                    </button>
                    <button
                      onClick={() => setUseSubgroups(true)}
                      className={`rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                        useSubgroups
                          ? "border-[#38BDF8] bg-[#38BDF8]/10 text-[#38BDF8]"
                          : "border-[#2F3743] bg-[#1B2029] text-[#8B95A5] hover:border-[#3B4553]"
                      }`}
                    >
                      By variable(s)
                    </button>
                  </div>

                  {useSubgroups && (
                    <>
                      <Slider
                        label="Number of variables"
                        min={1}
                        max={MAX_VARIABLES}
                        value={nVariables}
                        onChange={setNVariables}
                        format={(v) => v}
                        hint="Curves multiply: 2 variables × 3 groups each = up to 9 curves."
                      />
                      <div className="space-y-2.5">
                        {Array.from({ length: nVariables }).map((_, i) => (
                          <VariableEditor
                            key={i}
                            index={i}
                            value={variables[i] || { source: "clinical", column: "", mode: "tags", groups: [] }}
                            clinicalColumns={variableColumns}
                            rnaGenes={rnaGenes}
                            hasRna={!!rna}
                            clinicalPath={clinical.path}
                            onChange={(patch) => setVariable(i, patch)}
                          />
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </Panel>
            )}

            {/* --- plot options */}
            {clinical && (
              <Panel title="5 · Plot options">
                <div className="space-y-2">
                  <Checkbox label="Show confidence intervals" checked={showCI} onChange={setShowCI} />
                  <Checkbox label="Show at-risk table" checked={showAtRisk} onChange={setShowAtRisk} />
                  <Checkbox label="Mark censored observations" checked={showCensors} onChange={setShowCensors} />
                  <Checkbox label="Move legend to the side" checked={legendOnSide} onChange={setLegendOnSide} />
                  <div className="pt-2">
                    <Slider
                      label="Datapoints to plot"
                      min={50}
                      max={100}
                      value={detail}
                      onChange={setDetail}
                      format={(v) => `${v}%`}
                    />
                  </div>
                  <div className="pt-1">
                    <Select
                      label="Confidence level"
                      value={String(alpha)}
                      onChange={(v) => setAlpha(Number(v))}
                      options={[
                        { value: "0.05", label: "95%" },
                        { value: "0.1", label: "90%" },
                        { value: "0.01", label: "99%" },
                      ]}
                    />
                  </div>
                </div>
              </Panel>
            )}

            {/* --- generate */}
            {clinical && (
              <div className="sticky bottom-0 -mx-4 border-t border-[#232A34] bg-[#12151B] px-4 py-3">
                <Button
                  variant="primary"
                  size="lg"
                  icon={Sparkles}
                  className="w-full"
                  onClick={generate}
                  disabled={!canGenerate}
                  busy={busy}
                >
                  {result ? "Regenerate plot" : "Generate plot"}
                </Button>
                {!canGenerate && (
                  <p className="mt-2 text-center text-[11px] text-[#6B7480]">
                    {noEventValues.length === 0 || eventValues.length === 0
                      ? "Map the event values to 0 and 1 first."
                      : "Pick the time and event columns."}
                  </p>
                )}
              </div>
            )}
          </div>
        </aside>

        {/* --------------------------------------------------------- main */}
        <main className="min-w-0 flex-1 overflow-y-auto p-5">
          {error && (
            <div className="mb-4">
              <Alert tone="bad" title="Something went wrong" onClose={() => setError(null)}>
                {error}
              </Alert>
            </div>
          )}
          {notice && !error && (
            <div className="mb-4">
              <Alert tone="good" onClose={() => setNotice(null)}>
                {notice}
              </Alert>
            </div>
          )}

          {!clinical ? (
            <Panel>
              <EmptyState icon={FileUp} title="Start by loading your clinical data">
                <p>
                  This app reads a tab-separated clinical file (the same format the Streamlit KM plotter expects)
                  and, optionally, an RNA expression file to build subgroups from gene expression.
                </p>
                <p className="mt-2">
                  The clinical file must contain a <strong className="text-[#8B95A5]">PATIENT_ID</strong> column and a
                  time/event pair such as <strong className="text-[#8B95A5]">OS_MONTHS</strong> /{" "}
                  <strong className="text-[#8B95A5]">OS_STATUS</strong>.
                </p>
              </EmptyState>
            </Panel>
          ) : !result ? (
            <Panel>
              <EmptyState icon={BarChart3} title="No plot yet">
                <p>
                  Pick the time-to-event column and the event column, map the event values to 0 and 1, then press
                  <strong className="text-[#8B95A5]"> Generate plot</strong>.
                </p>
                {clinical.nColumns > 0 && (
                  <p className="mt-3 text-[11px]">
                    Loaded {clinical.nRows} patients × {clinical.nColumns} columns
                    {rna ? `, plus RNA data (${rna.nRows} patients × ${rna.nColumns} genes)` : ""}.
                  </p>
                )}
              </EmptyState>
            </Panel>
          ) : (
            <div className="space-y-4">
              {/* summary strip */}
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <StatCard label="Patients" value={result.nPatients} sub={`${result.nPatientsAfterSubgrouping} after subgrouping`} />
                <StatCard label="Curves" value={result.nCurves} sub={result.variables.length ? result.variables.join(" × ") : "Whole dataset"} />
                <StatCard
                  label="Median survival"
                  value={medianSummary(result)}
                  sub={result.timeColumn}
                />
                <StatCard label="Endpoint" value={result.eventColumn} sub={result.timeColumn} />
              </div>

              {/* plot */}
              <Panel
                title="Kaplan-Meier estimates"
                subtitle={
                  result.variables.length
                    ? `Subgrouped by ${result.variables.join(", ")}`
                    : "Whole dataset — no subgroups"
                }
                right={
                  <div className="flex items-center gap-2">
                    <Button size="sm" icon={ImageIcon} onClick={exportPng} busy={exporting}>
                      PNG
                    </Button>
                    <Button size="sm" icon={FileSpreadsheet} onClick={exportExcel} busy={exporting}>
                      Excel
                    </Button>
                  </div>
                }
                bodyClass="p-0"
              >
                <KmPlot
                  curves={result.curves}
                  detail={detail / 100}
                  showCI={showCI}
                  showAtRisk={showAtRisk}
                  showCensors={showCensors}
                  legendOnSide={legendOnSide}
                  width={1100}
                  height={520}
                />
              </Panel>

              {/* per-curve table */}
              <Panel title="Curves" subtitle="Median survival and cohort size per curve">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-[#2A313C] text-[11px] uppercase tracking-wider text-[#6B7480]">
                        <th className="py-2 pr-4 font-semibold">Curve</th>
                        <th className="py-2 pr-4 font-semibold">n</th>
                        <th className="py-2 pr-4 font-semibold">Events</th>
                        <th className="py-2 pr-4 font-semibold">Censored</th>
                        <th className="py-2 font-semibold">Median survival (months)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.curves.map((c, i) => (
                        <tr key={c.label} className="border-b border-[#1E242D] last:border-0">
                          <td className="py-2 pr-4">
                            <span className="flex items-center gap-2">
                              <span
                                className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                                style={{ background: ["#38BDF8", "#F472B6", "#A3E635", "#FBBF24", "#C084FC"][i % 5] }}
                              />
                              <span className="text-[#D4DAE4]">{c.label}</span>
                            </span>
                          </td>
                          <td className="py-2 pr-4 font-mono-tabular text-[#8B95A5]">{c.n}</td>
                          <td className="py-2 pr-4 font-mono-tabular text-[#8B95A5]">{c.nEvents}</td>
                          <td className="py-2 pr-4 font-mono-tabular text-[#8B95A5]">{c.nCensored}</td>
                          <td className="py-2 font-mono-tabular text-[#E6EAF0]">
                            {Number.isFinite(c.median) ? c.median.toFixed(2) : "not reached"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- helpers

function StatCard({ label, value, sub }) {
  return (
    <div className="rounded-xl border border-[#2A313C] bg-[#161A21] px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-[#6B7480]">{label}</p>
      <p className="mt-1 truncate font-mono-tabular text-lg text-[#E6EAF0]" title={String(value)}>
        {value}
      </p>
      {sub && <p className="mt-0.5 truncate text-[11px] text-[#6B7480]">{sub}</p>}
    </div>
  );
}

function medianSummary(result) {
  if (!result.curves.length) return "—";
  if (result.curves.length === 1) {
    const m = result.curves[0].median;
    return Number.isFinite(m) ? m.toFixed(1) : "not reached";
  }
  const finite = result.curves.filter((c) => Number.isFinite(c.median)).map((c) => c.median);
  if (!finite.length) return "not reached";
  return `${Math.min(...finite).toFixed(1)} – ${Math.max(...finite).toFixed(1)}`;
}

/** The 0/1 mapping table: one row per distinct value of the event column. */
function ValueMapper({ values, noEventValues, eventValues, onToggle }) {
  if (!values || !values.length) {
    return (
      <div className="py-2 text-center text-xs text-[#6B7480]">
        This column has no values to map.
      </div>
    );
  }
  return (
    <div className="max-h-64 overflow-y-auto rounded-lg border border-[#252C36]">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-[#1B2029]">
          <tr className="text-[10px] uppercase tracking-wider text-[#6B7480]">
            <th className="px-2 py-1.5 font-semibold">Value</th>
            <th className="px-1 py-1.5 text-center font-semibold">0</th>
            <th className="px-1 py-1.5 text-center font-semibold">1</th>
            <th className="px-2 py-1.5 text-right font-semibold">n</th>
          </tr>
        </thead>
        <tbody>
          {values.map((v) => {
            const s = String(v.value);
            const isNo = noEventValues.includes(s);
            const isEv = eventValues.includes(s);
            return (
              <tr key={v.id} className="border-t border-[#1E242D]">
                <td className="max-w-[140px] truncate px-2 py-1.5 text-[#D4DAE4]" title={v.label}>
                  {v.label}
                </td>
                <td className="px-1 py-1 text-center">
                  <button
                    onClick={() => onToggle(v.value, "no")}
                    className={`h-5 w-5 rounded text-[11px] font-bold transition-colors ${
                      isNo
                        ? "bg-[#4ADE80] text-[#0B1220]"
                        : "bg-[#232A34] text-[#5F6875] hover:bg-[#2B333F]"
                    }`}
                    title="Label as no event (0)"
                  >
                    0
                  </button>
                </td>
                <td className="px-1 py-1 text-center">
                  <button
                    onClick={() => onToggle(v.value, "ev")}
                    className={`h-5 w-5 rounded text-[11px] font-bold transition-colors ${
                      isEv
                        ? "bg-[#FB7185] text-[#0B1220]"
                        : "bg-[#232A34] text-[#5F6875] hover:bg-[#2B333F]"
                    }`}
                    title="Label as event (1)"
                  >
                    1
                  </button>
                </td>
                <td className="px-2 py-1.5 text-right font-mono-tabular text-[#6B7480]">{v.count}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** One subgroup variable: dataset, column, and its groups. */
function VariableEditor({ index, value, clinicalColumns, rnaGenes, hasRna, clinicalPath, onChange }) {
  const [open, setOpen] = useState(true);
  const [geneQuery, setGeneQuery] = useState("");
  const [columnValues, setColumnValues] = useState([]);

  const nGroups = Math.max(1, (value.groups || []).length);
  const setGroups = (groups) => onChange({ groups });

  // Load the distinct values of the chosen clinical column so the user can
  // pick tags instead of typing them.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (value.source !== "clinical" || !value.column) {
        setColumnValues([]);
        return;
      }
      try {
        const res = await api.run({ command: "column", path: clinicalPath, column: value.column });
        if (!cancelled && res.ok) setColumnValues(res.values || []);
      } catch {
        if (!cancelled) setColumnValues([]);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [value.source, value.column, clinicalPath]);

  const filteredGenes = useMemo(() => {
    if (!geneQuery) return rnaGenes.slice(0, 60);
    const q = geneQuery.toLowerCase();
    return rnaGenes.filter((g) => g.toLowerCase().includes(q)).slice(0, 60);
  }, [rnaGenes, geneQuery]);

  return (
    <div className="rounded-lg border border-[#252C36] bg-[#14181F]">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
      >
        <span className="flex items-center gap-2 text-xs font-semibold text-[#8B95A5]">
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          Variable {index + 1}
          {value.column && <span className="text-[#38BDF8]">· {value.column}</span>}
        </span>
        <span className="text-[10px] uppercase tracking-wider text-[#5F6875]">
          {nGroups} group{nGroups === 1 ? "" : "s"}
        </span>
      </button>

      {open && (
        <div className="space-y-2.5 border-t border-[#232A34] p-3">
          <div className="grid grid-cols-2 gap-2">
            <Select
              label="Dataset"
              value={value.source}
              onChange={(v) => onChange({ source: v, column: "", groups: [] })}
              options={[
                { value: "clinical", label: "Clinical" },
                ...(hasRna ? [{ value: "RNA", label: "RNA" }] : []),
              ]}
            />
            {value.source === "RNA" ? (
              <div>
                <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-[#6B7480]">
                  Gene
                </span>
                <input
                  value={geneQuery}
                  onChange={(e) => setGeneQuery(e.target.value)}
                  placeholder="Type to search genes…"
                  className="w-full rounded-lg border border-[#2F3743] bg-[#1B2029] px-3 py-2 text-sm text-[#E6EAF0] outline-none placeholder:text-[#4A5563] focus:border-[#38BDF8]"
                />
                <select
                  value={value.column}
                  onChange={(e) => onChange({ column: e.target.value, groups: [] })}
                  className="mt-1.5 w-full rounded-lg border border-[#2F3743] bg-[#1B2029] px-3 py-2 text-sm text-[#E6EAF0] outline-none focus:border-[#38BDF8]"
                >
                  <option value="">Select a gene…</option>
                  {filteredGenes.map((g) => (
                    <option key={g} value={g}>
                      {g}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <Select
                label="Column"
                value={value.column}
                onChange={(v) => onChange({ column: v, groups: [] })}
                placeholder="Select a column…"
                options={clinicalColumns}
              />
            )}
          </div>

          {value.source === "RNA" && (
            <div className="rounded-md border border-[#1B4A5E] bg-[#0E2A38] px-2.5 py-2 text-[11px] text-[#9BDCF5]">
              RNA variables are split by expression <strong>range</strong> — the patient is assigned to the group whose
              range contains the value.
            </div>
          )}

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[#6B7480]">
                Groups
              </span>
              <div className="flex gap-1">
                <button
                  disabled={nGroups >= MAX_GROUPS}
                  onClick={() => setGroups([...(value.groups || []), newGroup(value.mode)])}
                  className="rounded border border-[#2F3743] px-1.5 py-0.5 text-[10px] text-[#8B95A5] hover:bg-[#232A34] disabled:opacity-40"
                >
                  + group
                </button>
                <button
                  disabled={nGroups <= 1}
                  onClick={() => setGroups((value.groups || []).slice(0, -1))}
                  className="rounded border border-[#2F3743] px-1.5 py-0.5 text-[10px] text-[#8B95A5] hover:bg-[#232A34] disabled:opacity-40"
                >
                  − group
                </button>
              </div>
            </div>

            <div className="space-y-1.5">
              {(value.groups || []).map((g, gi) => (
                <GroupEditor
                  key={gi}
                  index={gi}
                  group={g}
                  mode={value.source === "RNA" ? "ranges" : value.mode}
                  availableValues={columnValues}
                  onChange={(patch) => {
                    const next = [...(value.groups || [])];
                    next[gi] = { ...next[gi], ...patch };
                    setGroups(next);
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function newGroup(mode) {
  return mode === "ranges" ? { lo: 0, hi: 1, name: "" } : { values: [], name: "" };
}

/** A single group: either a set of tags or a numeric range. */
function GroupEditor({ index, group, mode, availableValues, onChange }) {
  const [tagInput, setTagInput] = useState("");

  if (mode === "ranges") {
    return (
      <div className="rounded-md border border-[#232A34] bg-[#10141A] px-2.5 py-2">
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-[11px] text-[#6B7480]">Group {index + 1}</span>
          <input
            type="number"
            value={group.lo ?? 0}
            step="any"
            onChange={(e) => onChange({ lo: e.target.value === "" ? null : Number(e.target.value) })}
            className="w-full min-w-0 rounded border border-[#2F3743] bg-[#1B2029] px-2 py-1 font-mono-tabular text-xs text-[#E6EAF0] outline-none focus:border-[#38BDF8]"
          />
          <span className="text-[#5F6875]">→</span>
          <input
            type="number"
            value={group.hi ?? 1}
            step="any"
            onChange={(e) => onChange({ hi: e.target.value === "" ? null : Number(e.target.value) })}
            className="w-full min-w-0 rounded border border-[#2F3743] bg-[#1B2029] px-2 py-1 font-mono-tabular text-xs text-[#E6EAF0] outline-none focus:border-[#38BDF8]"
          />
        </div>
        <p className="mt-1 pl-[4.5rem] text-[10px] text-[#5F6875]">Half-open range [lo, hi)</p>
      </div>
    );
  }

  const values = group.values || [];

  const addValue = (v) => {
    const s = String(v);
    if (values.includes(s)) return;
    onChange({ values: [...values, s], name: group.name || defaultGroupName([...values, s]) });
  };

  // Values of the chosen column that are not yet assigned to any group.
  const unassigned = (availableValues || []).filter((v) => !values.includes(String(v.label ?? v.value)));
  const showPicker = unassigned.length > 0;

  return (
    <div className="rounded-md border border-[#232A34] bg-[#10141A] px-2.5 py-2">
      <div className="flex items-center gap-2">
        <span className="w-16 shrink-0 text-[11px] text-[#6B7480]">Group {index + 1}</span>
        <input
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && tagInput.trim()) {
              e.preventDefault();
              addValue(tagInput.trim());
              setTagInput("");
            }
          }}
          placeholder="Type a value, press Enter"
          className="w-full min-w-0 rounded border border-[#2F3743] bg-[#1B2029] px-2 py-1 text-xs text-[#E6EAF0] outline-none placeholder:text-[#4A5563] focus:border-[#38BDF8]"
        />
        <button
          disabled={!tagInput.trim()}
          onClick={() => {
            addValue(tagInput.trim());
            setTagInput("");
          }}
          className="shrink-0 rounded border border-[#2F3743] px-1.5 py-0.5 text-[10px] text-[#8B95A5] hover:bg-[#232A34] disabled:opacity-40"
        >
          add
        </button>
      </div>

      {showPicker && (
        <div className="mt-1.5 flex flex-wrap gap-1 pl-[4.5rem]">
          {unassigned.slice(0, 14).map((v) => {
            const label = String(v.label ?? v.value);
            return (
              <button
                key={v.id ?? label}
                onClick={() => addValue(label)}
                className="rounded border border-[#333C49] bg-[#1B2029] px-1.5 py-0.5 text-[10px] text-[#8B95A5] transition-colors hover:border-[#38BDF8] hover:text-[#38BDF8]"
                title={`Add "${label}" to this group`}
              >
                + {label.length > 18 ? label.slice(0, 17) + "…" : label}
              </button>
            );
          })}
        </div>
      )}

      {values.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1 pl-[4.5rem]">
          {values.map((v) => (
            <span
              key={v}
              className="inline-flex items-center gap-1 rounded border border-[#333C49] bg-[#1B2029] px-1.5 py-0.5 text-[10px] text-[#D4DAE4]"
            >
              {v}
              <button
                onClick={() =>
                  onChange({
                    values: values.filter((x) => x !== v),
                    name: defaultGroupName(values.filter((x) => x !== v)),
                  })
                }
                className="text-[#5F6875] hover:text-[#FB7185]"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Rasterise the on-screen SVG to PNG bytes (base64). */
async function svgToPng(svgEl) {
  const clone = svgEl.cloneNode(true);
  const width = svgEl.viewBox.baseVal.width || 1100;
  const height = svgEl.viewBox.baseVal.height || 600;
  const scale = 2; // retina
  clone.setAttribute("width", width * scale);
  clone.setAttribute("height", height * scale);

  const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
  style.textContent = "text { font-family: 'IBM Plex Sans', sans-serif; }";
  clone.insertBefore(style, clone.firstChild);

  const xml = new XMLSerializer().serializeToString(clone);
  const svgBlob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);

  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("Could not rasterise the plot."));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#161A21";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/png");
    return dataUrl.split(",")[1];
  } finally {
    URL.revokeObjectURL(url);
  }
}
