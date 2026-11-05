import React, { useEffect, useState } from "react";
import Distribution from "./Distribution";
import { autoName } from "../lib/group-names";

const fmt = n => Number(Number(n).toFixed(4));
export function equalRanges(info, count = 2) {
  if (info.min === info.max) return [{ name: "All measurements", lo: info.min, hi: info.max, includeHi: true }];
  return Array.from({ length: count }, (_, i) => ({ name: `Group ${i + 1}`, lo: i === 0 ? info.min : info.min + (info.max - info.min) * i / count, hi: i === count - 1 ? info.max : info.min + (info.max - info.min) * (i + 1) / count, includeHi: i === count - 1 }));
}

export default function SubgroupEditor({ index, value, onChange, onRemove, clinical, rna, context, useProfile }) {
  const [search, setSearch] = useState("");
  const [categorySearch, setCategorySearch] = useState("");
  const key = `${value.source}:${value.column}`;
  const { data: profile, loading, error } = useProfile(value.column ? { ...context, command: "column", source: value.source, column: value.column } : null);
  useEffect(() => {
    if (!profile || profile.column.name !== value.column || profile.column.source !== value.source || value.profileKey === key) return;
    const mode = profile.column.mode;
    onChange({ profileKey: key, mode, groups: mode === "ranges" ? equalRanges(profile.column, 1) : Array.from({ length: profile.values.length === 1 ? 1 : 2 }, (_, i) => ({ name: `Group ${i + 1}`, values: [] })) });
  }, [profile, key, value.profileKey]);
  const groups = value.groups || [];
  const namedGroups = next => onChange({ groups: next.map(g => autoName(value.column, value.mode, g)) });
  useEffect(() => {
    if (groups.some(g => !g.customName && g.name !== autoName(value.column, value.mode, g).name)) namedGroups(groups);
  }, [value.column, value.mode, JSON.stringify(groups)]);
  const update = (i, patch) => onChange({ groups: groups.map((g, j) => i === j ? autoName(value.column, value.mode, { ...g, ...patch }) : g) });
  const info = profile?.column;
  const options = value.source === "RNA" ? (rna?.genes || []).filter(g => g.toLowerCase().includes(search.toLowerCase())).slice(0, 100) : clinical.options.subgroupOptions.filter(c => c !== context.timeColumn && c !== context.eventColumn);
  const changeCount = count => onChange({ groups: value.mode === "ranges" ? equalRanges(info, count) : Array.from({ length: count }, (_, i) => groups[i] || { name: `Group ${i + 1}`, values: [] }) });
  const split = cutoff => onChange({ groups: [{ name: "Low", lo: info.min, hi: cutoff, includeHi: false }, { name: "High", lo: cutoff, hi: info.max, includeHi: true }] });
  return <section className="km-panel km-variable" aria-label={`Subgroup variable ${index + 1}`}>
    <div className="km-section-heading"><h3>Variable {index + 1}{value.column ? ` · ${value.column}` : ""}</h3><button className="km-link" onClick={onRemove} aria-label={`Remove variable ${index + 1}`}>Remove</button></div>
    <div className="km-variable-selectors">
      <label>Dataset<select aria-label={`Dataset for variable ${index + 1}`} value={value.source} onChange={e => { setSearch(""); onChange({ source: e.target.value, column: "", profileKey: null, groups: [] }); }}><option value="clinical">Clinical</option>{rna && <option value="RNA">RNA expression</option>}</select></label>
      {value.source === "RNA" && <label>Find a gene<input aria-label={`Find gene for variable ${index + 1}`} placeholder="Type a gene symbol" value={search} onChange={e => setSearch(e.target.value)}/></label>}
      <label>{value.source === "RNA" ? "Gene" : "Clinical variable"}<select aria-label={`Column for variable ${index + 1}`} value={value.column} onChange={e => onChange({ column: e.target.value, profileKey: null, groups: [] })}><option value="">Select…</option>{value.column && !options.includes(value.column) && <option>{value.column}</option>}{options.map(c => <option key={c} value={c} disabled={value.source === "RNA" && rna?.ambiguousGenes?.includes(c)}>{c}{value.source === "RNA" && rna?.ambiguousGenes?.includes(c) ? " · multiple rows" : ""}</option>)}</select></label>
      {!!info?.nFinite && <label>Groups<select aria-label={`Group count for variable ${index + 1}`} value={groups.length || 1} onChange={e => changeCount(Number(e.target.value))}>{Array.from({ length: info.constant ? 1 : 5 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select></label>}
    </div>
    {loading ? <p role="status" className="km-hint">Reading the selected distribution…</p> : error ? <p role="alert" className="km-error">{error}</p> : profile && <div className="km-variable-body">
      <Distribution profile={profile} groups={groups}/>
      <div className="km-group-controls">
        {!info.nFinite ? <p className="km-hint">This variable has no usable values for the selected cohort.</p> : value.mode === "ranges" ? <>
          <div className="km-toolbar"><span className="km-hint">Observed range: {fmt(info.min)} to {fmt(info.max)}</span>{info.min < info.median && info.median < info.max && <button onClick={() => split(info.median)}>Split at median</button>}{info.min < 0 && info.max > 0 && <button onClick={() => split(0)}>Split at zero</button>}</div>
          {groups.map((g, i) => <div className="km-range-group" key={i}>
            <label className="km-group-name">Group {i + 1}<input aria-label={`Label for variable ${index + 1} group ${i + 1}`} value={g.name} onChange={e => update(i, { name: e.target.value, customName: true })}/></label>
            <div className="km-range-inputs"><label>From<input type="number" step="any" aria-label={`Lower bound for variable ${index + 1} group ${i + 1}`} value={g.lo ?? ""} onChange={e => update(i, { lo: e.target.value === "" ? "" : Number(e.target.value) })}/></label><label>To<input type="number" step="any" aria-label={`Upper bound for variable ${index + 1} group ${i + 1}`} value={g.hi ?? ""} onChange={e => update(i, { hi: e.target.value === "" ? "" : Number(e.target.value) })}/></label></div>
            {!info.constant && <div className="km-range-sliders"><label>Lower cutoff<input type="range" aria-label={`Lower cutoff slider for variable ${index + 1} group ${i + 1}`} min={info.min} max={info.max} step={Math.min(info.step, (info.max - info.min) / 100)} value={g.lo} onChange={e => update(i, { lo: Math.min(Number(e.target.value), Number(g.hi)) })}/></label><label>Upper cutoff<input type="range" aria-label={`Upper cutoff slider for variable ${index + 1} group ${i + 1}`} min={info.min} max={info.max} step={Math.min(info.step, (info.max - info.min) / 100)} value={g.hi} onChange={e => update(i, { hi: Math.max(Number(e.target.value), Number(g.lo)) })}/></label></div>}
            <label className="km-check"><input type="checkbox" aria-label={`Include upper boundary for variable ${index + 1} group ${i + 1}`} checked={!!g.includeHi} onChange={e => update(i, { includeHi: e.target.checked })}/>Include upper boundary</label>
          </div>)}
          <p className="km-hint">Ranges must not overlap. Unselected and missing measurements are excluded.</p>
        </> : <>
          <div className="km-group-labels">{groups.map((g, i) => <label key={i}>Group {i + 1}<input aria-label={`Label for variable ${index + 1} group ${i + 1}`} value={g.name} onChange={e => update(i, { name: e.target.value, customName: true })}/></label>)}</div>
          <div className="km-toolbar"><input aria-label={`Search categories for variable ${index + 1}`} placeholder="Find a category…" value={categorySearch} onChange={e => setCategorySearch(e.target.value)}/>{profile.values.length <= 5 && <button onClick={() => onChange({ groups: profile.values.map(v => ({ name: v.label, values: [String(v.value)] })) })}>One group per category</button>}</div>
          <div className="km-category-assignments">{profile.values.filter(v => v.label.toLowerCase().includes(categorySearch.toLowerCase())).map(v => {
            const raw = String(v.value), assigned = groups.findIndex(g => g.values?.includes(raw));
            return <label key={raw}><span>{v.label}<small>{v.count.toLocaleString()} patients</small></span><select aria-label={`Assign ${v.label} for variable ${index + 1}`} value={assigned} onChange={e => { const target = Number(e.target.value); onChange({ groups: groups.map((g, i) => ({ ...g, values: [...(g.values || []).filter(x => x !== raw), ...(i === target ? [raw] : [])] })) }); }}><option value={-1}>Exclude</option>{groups.map((g, i) => <option key={i} value={i}>{g.name || `Group ${i + 1}`}</option>)}</select></label>;
          })}</div>
        </>}
      </div>
    </div>}
  </section>;
}
