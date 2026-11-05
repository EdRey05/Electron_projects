import React from "react";

const colors = ["#6548A3", "#287F82", "#C3772C", "#507C43", "#A84E58"];
export default function Distribution({ profile, label, groups = [] }) {
  if (!profile) return <div className="km-chart-empty">Select a column to explore its distribution.</div>;
  const { column: info, distribution: dist } = profile;
  if (!dist || !info.nFinite) return <div className="km-chart-empty">No usable measurements in this cohort.</div>;
  const categorical = dist.kind === "categories";
  const data = categorical ? dist.values.slice(0, 20).map(v => ({ label: v.label, count: v.count, value: String(v.value) })) : dist.bins;
  const width = 600, height = 220, left = 44, top = 14, bottom = categorical ? 64 : 36;
  const w = width - left - 14, h = height - top - bottom;
  const peak = Math.max(1, ...data.map(d => d.count));
  const min = info.min ?? 0, max = info.max ?? 1;
  const x = v => left + (v - min) / (max - min || 1) * w;
  return <div className="km-distribution">
    <svg role="img" aria-label={`${label || info.name} ${categorical ? "category counts" : "histogram"}`} viewBox={`0 0 ${width} ${height}`}>
      {[0, .5, 1].map(f => <g key={f}><line x1={left} x2={width - 14} y1={top + h * (1 - f)} y2={top + h * (1 - f)} stroke="#DCD8E6"/><text x={left - 7} y={top + h * (1 - f) + 4} textAnchor="end">{Math.round(peak * f)}</text></g>)}
      {!categorical && groups.map((g, i) => <rect key={i} x={x(Number(g.lo))} y={top} width={Math.max(0, x(Number(g.hi)) - x(Number(g.lo)))} height={h} fill={colors[i % colors.length]} opacity=".08"/>)}
      {data.map((d, i) => {
        const xx = categorical ? left + i * w / data.length : x(d.x0);
        const bw = categorical ? w / data.length : x(d.x1) - x(d.x0);
        const group = categorical ? groups.findIndex(g => (g.values || []).includes(d.value)) : groups.findIndex(g => (d.x0 + d.x1) / 2 >= Number(g.lo) && (d.x0 + d.x1) / 2 <= Number(g.hi));
        return <g key={i}><rect x={xx + 1} y={top + h - d.count / peak * h} width={Math.max(1, bw - 2)} height={d.count / peak * h} rx="2" fill={colors[Math.max(0, group) % colors.length]} opacity=".86"><title>{categorical ? d.label : `${d.x0.toFixed(2)} to ${d.x1.toFixed(2)}`}: {d.count} patients</title></rect>
          {categorical && <text x={xx + bw / 2} y={top + h + 17} textAnchor="end" transform={`rotate(-28 ${xx + bw / 2} ${top + h + 17})`}>{String(d.label).slice(0, 17)}<title>{d.label}</title></text>}</g>;
      })}
      {!categorical && [min, (min + max) / 2, max].map((v, i) => <text key={i} x={x(v)} y={top + h + 21} textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}>{Number(v.toFixed(3))}</text>)}
      <text x="12" y={top + h / 2} textAnchor="middle" transform={`rotate(-90 12 ${top + h / 2})`}>Patients</text>
    </svg>
    <div className="km-chart-caption"><span>{info.nFinite.toLocaleString()} measurements</span><span>{info.nMissing.toLocaleString()} missing{info.nInvalid ? ` · ${info.nInvalid} invalid` : ""}</span>{info.source === "RNA" && <span>{info.nMatched} / {info.nEligible} patient IDs matched</span>}</div>
    {categorical && dist.values.length > 20 && <p className="km-hint">Top 20 categories shown; all values are available in the assignments.</p>}
  </div>;
}
