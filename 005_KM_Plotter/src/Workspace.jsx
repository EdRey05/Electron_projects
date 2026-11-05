import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, Download, FileUp, Layers, Play, RefreshCw, X } from "lucide-react";
import Distribution from "./components/Distribution";
import SubgroupEditor from "./components/SubgroupEditor";
import KmPlot from "./components/KmPlot";
import "./workspace.css";

const api = new Proxy({}, { get: (_, key) => window.api?.[key] });
const basename = path => path?.split(/[\\/]/).pop() || "";
const emptyVariable = () => ({ source: "clinical", column: "", mode: "tags", groups: [] });
const number = n => Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 1 }) : "Not reached";
export function useProfile(job) {
  const key = job ? JSON.stringify(job) : "";
  const [state, setState] = useState({ key: "", data: null, loading: false, error: "" });
  useEffect(() => {
    let active = true;
    if (!key) { setState({ key, data: null, loading: false, error: "" }); return; }
    setState({ key, data: null, loading: true, error: "" });
    api.run(JSON.parse(key)).then(result => {
      if (active) setState({ key, data: result.ok ? result : null, loading: false, error: result.ok ? "" : result.error });
    }).catch(error => { if (active) setState({ key, data: null, loading: false, error: error.message }); });
    return () => { active = false; };
  }, [key]);
  return state.key === key ? state : { data: null, loading: !!key, error: "" };
}

function Field({ label, children }) { return <label className="km-field"><span>{label}</span>{children}</label>; }
function Check({ label, checked, onChange }) { return <label className="km-check"><input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)}/>{label}</label>; }

export default function Workspace() {
  const [clinical, setClinical] = useState(null), [rna, setRna] = useState(null);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const [timeColumn, setTime] = useState(""), [eventColumn, setEvent] = useState("");
  const [assignments, setAssignments] = useState({});
  const [useGroups, setUseGroups] = useState(false), [variables, setVariables] = useState([]);
  const [alpha, setAlpha] = useState(.05), [detail, setDetail] = useState(95);
  const [showCI, setCI] = useState(true), [showAtRisk, setAtRisk] = useState(true), [showCensors, setCensors] = useState(true), [sideLegend, setSideLegend] = useState(true);
  const [showMedians, setMedians] = useState(true);
  const [result, setResult] = useState(null), [snapshot, setSnapshot] = useState(null);
  useEffect(() => {
    setVariables(previous => previous.some(v => v.source === "clinical" && [timeColumn, eventColumn].includes(v.column))
      ? previous.map(v => v.source === "clinical" && [timeColumn, eventColumn].includes(v.column) ? emptyVariable() : v) : previous);
  }, [timeColumn, eventColumn]);
  const [error, setError] = useState(""), [toast, setToast] = useState(null);
  const notify = (message, tone = "success") => setToast({ message, tone, id: Date.now() });
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), 4500); return () => clearTimeout(timer); }, [toast]);
  const noEventValues = Object.keys(assignments).filter(k => assignments[k] === "censored");
  const eventValues = Object.keys(assignments).filter(k => assignments[k] === "event");
  const context = useMemo(() => ({ clinicalPath: clinical?.path, rnaPath: rna?.path || null, timeColumn, eventColumn, noEventValues, eventValues }), [clinical?.path, rna?.path, timeColumn, eventColumn, JSON.stringify(assignments)]);
  const times = useProfile(clinical && timeColumn ? { command: "column", clinicalPath: clinical.path, column: timeColumn, role: "time" } : null);
  const events = useProfile(clinical && eventColumn ? { command: "column", clinicalPath: clinical.path, column: eventColumn, role: "event" } : null);
  const job = { command: "analyze", ...context, variables: useGroups ? variables.map(v => ({ source: v.source, column: v.column, mode: v.mode, groups: v.groups })) : [], alpha };
  const stale = !!snapshot && JSON.stringify(snapshot) !== JSON.stringify(job);
  const canGenerate = !!clinical && !!timeColumn && !!eventColumn && noEventValues.length > 0 && eventValues.length > 0 && !loading && !busy;
  const totals = (events.data?.values || []).reduce((counts, v) => { counts[assignments[String(v.value)] || "ignore"] += v.count; return counts; }, { censored: 0, event: 0, ignore: events.data?.column.nMissing || 0 });

  async function load(kind) {
    setError("");
    const chosen = await api.pickFile({ title: kind === "clinical" ? "Choose clinical data" : "Choose RNA expression data", filters: [{ name: "Tab-separated data", extensions: ["txt", "tsv", "tab"] }] });
    if (!chosen) return;
    setLoading(true);
    try {
      const response = await api.run({ command: "inspect", clinicalPath: kind === "clinical" ? chosen.path : clinical.path, rnaPath: kind === "RNA" ? chosen.path : rna?.path || null });
      if (!response.ok) throw Error(response.error);
      setClinical({ ...response.clinical, options: response.options });
      setRna(response.rna);
      if (kind === "clinical") {
        setTime(response.options.timeToEventOptions[0] || ""); setEvent(response.options.eventObservationOptions[0] || "");
        setAssignments({}); setVariables([]); setUseGroups(false); setResult(null); setSnapshot(null);
      } else { setVariables(v => v.filter(x => x.source !== "RNA")); }
      notify(kind === "clinical" ? `Loaded ${response.clinical.nRows.toLocaleString()} patients.` : `Loaded ${response.rna.genes.length.toLocaleString()} genes; ${response.rna.nSharedPatients.toLocaleString()} matching patient IDs.`);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  }
  async function generate() {
    setBusy(true); setError("");
    try {
      if (useGroups && (!variables.length || variables.some(v => !v.column || !v.groups.length || v.groups.some(g => v.mode === "ranges" && (g.lo === "" || g.hi === ""))))) throw Error("Complete each subgroup variable and its groups before generating the plot.");
      const response = await api.run(job);
      if (!response.ok) throw Error(response.error);
      setResult(response.result); setSnapshot(JSON.parse(JSON.stringify(job)));
      notify(`${response.result.nCurves} curve${response.result.nCurves === 1 ? "" : "s"} from ${response.result.nPatientsAfterSubgrouping.toLocaleString()} patients.`);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function exportFile(kind) {
    setError("");
    try {
      let bytes, name, extension;
      if (kind === "Excel") {
        const response = await api.run({ ...snapshot, expectedInputVersion: result.inputVersion, command: "export" });
        if (!response.ok) throw Error(response.error);
        bytes = response.base64; name = "KM_results.xlsx"; extension = "xlsx";
      } else {
        const svg = document.querySelector("#km-plot-svg").cloneNode(true);
        svg.setAttribute("width", svg.viewBox.baseVal.width); svg.setAttribute("height", svg.viewBox.baseVal.height);
        const xml = new XMLSerializer().serializeToString(svg);
        if (kind === "SVG") { const encoded = new TextEncoder().encode(xml);
          let binary = "";
          for (let offset = 0; offset < encoded.length; offset += 32768) binary += String.fromCharCode(...encoded.subarray(offset, offset + 32768));
          bytes = btoa(binary); name = "KM_plot.svg"; extension = "svg"; }
        else {
          const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }));
          try {
            const image = new Image();
            await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(Error("Could not render the figure.")); image.src = url; });
            const canvas = document.createElement("canvas"); canvas.width = svg.viewBox.baseVal.width * 3; canvas.height = svg.viewBox.baseVal.height * 3;
            const drawing = canvas.getContext("2d"); drawing.fillStyle = "#FFFFFF"; drawing.fillRect(0, 0, canvas.width, canvas.height); drawing.drawImage(image, 0, 0, canvas.width, canvas.height);
            bytes = canvas.toDataURL("image/png").split(",")[1]; name = "KM_plot.png"; extension = "png";
          } finally { URL.revokeObjectURL(url); }
        }
      }
      const path = await api.pickSavePath({ title: `Save ${kind}`, defaultName: name, filters: [{ name: kind, extensions: [extension] }] });
      if (!path) return;
      if (!await api.writeBytes(path, bytes)) throw Error("Could not save the file.");
      notify(`Saved ${basename(path)}`);
    } catch (e) { setError(e.message); }
  }
  const reset = () => { setClinical(null); setRna(null); setTime(""); setEvent(""); setAssignments({}); setVariables([]); setUseGroups(false); setResult(null); setSnapshot(null); setError(""); setToast(null); };
  return <div className="km-app">
    <header className="km-header"><div className="km-brand"><span className="km-brand-icon"><Activity size={23}/></span><div><h1>KM Plotter</h1><p>Explore survival data. Define cohorts. Export clear figures.</p></div></div><button className="km-secondary" onClick={reset}><RefreshCw size={16}/>Start over</button></header>
    <div className="km-shell">
      <aside className="km-sidebar">
        <section><h2>Data files</h2><button className="km-primary km-full" disabled={loading} onClick={() => load("clinical")}><FileUp size={17}/>{clinical ? "Change clinical file" : "Choose clinical file"}</button>{clinical && <p className="km-file" title={clinical.path}>{basename(clinical.path)}<span>{clinical.nRows.toLocaleString()} patients</span></p>}<button className="km-secondary km-full" disabled={!clinical || loading} onClick={() => load("RNA")}><Layers size={16}/>{rna ? "Change RNA file" : "Add RNA file"}</button>{rna && <p className="km-file" title={rna.path}>{basename(rna.path)}<span>{rna.genes.length.toLocaleString()} genes · {rna.nSharedPatients} shared IDs</span></p>}{!!rna?.ambiguousGenes?.length && <p className="km-hint">{rna.ambiguousGenes.length.toLocaleString()} gene symbols have multiple rows and cannot be selected. Resolve these in the source file; values are never averaged automatically.</p>}{loading && <p className="km-hint" role="status">Reading data…</p>}</section>
        <section><h2>Figure options</h2><Check label="Confidence intervals" checked={showCI} onChange={setCI}/><Check label="Number-at-risk table" checked={showAtRisk} onChange={setAtRisk}/><Check label="Censored observations" checked={showCensors} onChange={setCensors}/><Check label="Legend on the side" checked={sideLegend} onChange={setSideLegend}/><Check label="Median survival in legend" checked={showMedians} onChange={setMedians}/><Field label="Confidence level"><select value={alpha} onChange={e => setAlpha(Number(e.target.value))}><option value={.1}>90%</option><option value={.05}>95%</option><option value={.01}>99%</option></select></Field><Field label={`Datapoints shown · ${detail}%`}><input aria-label="Datapoints shown" type="range" min="50" max="100" value={detail} onChange={e => setDetail(Number(e.target.value))}/></Field></section>
        <div className="km-run"><button className="km-primary km-full" disabled={!canGenerate} onClick={generate}><Play size={17}/>{busy ? "Calculating…" : result ? "Update plot" : "Generate plot"}</button><p className="km-hint">{!clinical ? "Choose clinical data to begin." : !noEventValues.length || !eventValues.length ? "Assign the censored and event values." : ""}</p></div>
      </aside>
      <main className="km-main" aria-busy={busy || loading}>
        {!clinical ? <section className="km-panel km-welcome"><Activity size={40}/><h2>Start with your clinical table</h2><p>Choose follow-up time and event status, explore their distributions, then define any subgroups before generating your figure.</p><p className="km-hint">Tab-separated clinical data with unique PATIENT_ID values. RNA expression is optional.</p></section> : <>
          <div className="km-section-heading"><h2>1 · Survival endpoint</h2><span className="km-hint">Explore the data before choosing groups</span></div>
          <div className="km-endpoints">
            <section className="km-panel"><Field label="Time-to-event column"><select aria-label="Time-to-event column" value={timeColumn} onChange={e => setTime(e.target.value)}><option value="">Select…</option>{clinical.options.timeToEventOptions.map(c => <option key={c}>{c}</option>)}</select></Field>{times.loading ? <p className="km-chart-empty" role="status">Reading time distribution…</p> : <Distribution profile={times.data} label={timeColumn}/ >}{times.error && <p className="km-error">{times.error}</p>}</section>
            <section className="km-panel"><Field label="Event observation column"><select aria-label="Event observation column" value={eventColumn} onChange={e => { setEvent(e.target.value); setAssignments({}); }}><option value="">Select…</option>{(clinical.options.eventObservationOptions.length ? clinical.options.eventObservationOptions : clinical.columns.filter(c => c !== "PATIENT_ID")).map(c => <option key={c}>{c}</option>)}</select></Field>{events.loading ? <p className="km-chart-empty" role="status">Reading status distribution…</p> : <Distribution profile={events.data} label={eventColumn}/ >}{events.error && <p className="km-error">{events.error}</p>}</section>
          </div>
          <section className="km-panel km-mapping"><div className="km-section-heading"><h2>2 · Event mapping</h2><span className="km-hint">Assign each status explicitly</span></div><div className="km-event-values">{(events.data?.values || []).map(v => <label key={String(v.value)}><span>{v.label}<small>{v.count.toLocaleString()} patients</small></span><select aria-label={`Meaning of ${v.label}`} value={assignments[String(v.value)] || "ignore"} onChange={e => setAssignments(previous => ({ ...previous, [String(v.value)]: e.target.value }))}><option value="ignore">Ignore</option><option value="censored">Censored / no event</option><option value="event">Observed event</option></select></label>)}</div><div className="km-mapping-totals" aria-label="Event mapping patient totals"><span><b>{totals.censored.toLocaleString()}</b> censored patients</span><span><b>{totals.event.toLocaleString()}</b> event patients</span><span><b>{totals.ignore.toLocaleString()}</b> ignored / missing</span></div></section>
          <div className="km-section-heading"><h2>3 · Cohorts</h2><div className="km-tabs"><button aria-pressed={!useGroups} onClick={() => setUseGroups(false)}>Whole cohort</button><button aria-pressed={useGroups} onClick={() => { setUseGroups(true); if (!variables.length) setVariables([emptyVariable()]); }}>By variables</button></div></div>
          {useGroups && <><p className="km-hint">Each variable contributes groups to the curve combinations. Use category counts or signed numeric distributions to choose boundaries.</p>{variables.map((value, i) => <SubgroupEditor key={i} index={i} value={value} clinical={clinical} rna={rna} context={context} useProfile={useProfile} onChange={patch => setVariables(previous => previous.map((v, j) => i === j ? { ...v, ...patch } : v))} onRemove={() => setVariables(previous => previous.filter((_, j) => i !== j))}/>)}<div className="km-toolbar"><button className="km-secondary" disabled={variables.length >= 5} onClick={() => setVariables(v => [...v, emptyVariable()])}>Add variable</button><span className="km-hint">Up to {variables.reduce((n, v) => n * (v.groups?.length || 1), 1)} curve combinations · {variables.length} / 5 variables</span></div></>}
        </>}
        {error && <div className="km-error km-panel" role="alert">{error}<button aria-label="Dismiss error" onClick={() => setError("")}><X size={15}/></button></div>}
        <section className="km-results" data-state={result ? "ready" : "empty"}><div className="km-section-heading"><h2>Kaplan–Meier estimates</h2>{result && <div className="km-toolbar">{["PNG", "SVG", "Excel"].map(kind => <button className="km-secondary" key={kind} disabled={stale || busy} onClick={() => exportFile(kind)}><Download size={14}/>{kind}</button>)}</div>}</div>
          {!result ? <div className="km-panel km-chart-empty">Your figure will appear here after you generate a plot.</div> : <>
            {stale && <p className="km-stale">Analysis settings changed. Update the plot before exporting.</p>}
            <div className="km-stats"><div><span>Included patients</span><strong>{result.nPatientsAfterSubgrouping.toLocaleString()}</strong><small>of {result.nInputPatients.toLocaleString()} loaded</small></div><div><span>Observed events</span><strong>{result.curves.reduce((n, c) => n + c.nEvents, 0).toLocaleString()}</strong><small>{result.nCurves} curve{result.nCurves === 1 ? "" : "s"}</small></div><div><span>Median survival</span><strong>{result.curves.length === 1 ? number(result.curves[0].median) : "Per curve below"}</strong><small>{result.timeColumn}</small></div><div><span>Excluded patients</span><strong>{(result.nExcludedBeforeSubgroups + result.nExcludedBySubgroups).toLocaleString()}</strong><small>Missing, invalid or outside groups</small></div></div>
            <div className="km-figure"><KmPlot curves={result.curves} detail={detail / 100} showCI={showCI} showAtRisk={showAtRisk} showCensors={showCensors} legendOnSide={sideLegend} showMedians={showMedians} timeColumn={result.timeColumn}/></div>
            <div className="km-panel km-table-wrap"><table className="km-table"><thead><tr><th>Curve</th><th>Patients</th><th>Events</th><th>Censored</th><th>Median survival</th></tr></thead><tbody>{result.curves.map(c => <tr key={c.label}><td>{c.label}</td><td>{c.n}</td><td>{c.nEvents}</td><td>{c.nCensored}</td><td>{number(c.median)}</td></tr>)}</tbody></table></div>
          </>}
        </section>
      </main>
    </div>
    {toast && <div className={`km-toast ${toast.tone}`} role="status" aria-live="polite"><span>{toast.message}</span><button aria-label="Dismiss notification" onClick={() => setToast(null)}><X size={16}/></button></div>}
  </div>;
}
