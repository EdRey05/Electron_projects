import React from "react";
import { bandPath, censorMarks, curvePoints, formatTick, niceTicks, stepPath, xDomain } from "../lib/plot";
import { figureGeometry, riskAt } from "../lib/figure";

// Matplotlib's familiar scientific cycle, independent from the application theme.
const palette = ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd", "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf"];
export default function KmPlot({ curves, detail = 1, showCI = true, showAtRisk = false, showCensors = true, legendOnSide = true, showMedians = true, timeColumn = "OS_MONTHS" }) {
  if (!curves?.length) return null;
  const g = figureGeometry({ curves, showAtRisk, side: legendOnSide, showMedians });
  const rawMax = xDomain(curves, detail)[1];
  const ticks = niceTicks(rawMax, 6);
  const max = ticks[ticks.length - 1] || 1;
  const plotWidth = g.width - g.left - g.right, plotHeight = g.plotBottom - g.plotTop;
  const x = time => g.left + time / max * plotWidth;
  const y = probability => g.plotBottom - probability * plotHeight;
  const series = curves.map((curve, i) => ({ curve, points: curvePoints(curve, detail), color: palette[i % palette.length] }));
  return <svg id="km-plot-svg" role="img" aria-label="Kaplan-Meier survival figure" xmlns="http://www.w3.org/2000/svg" width="100%" height={g.totalHeight} viewBox={`0 0 ${g.width} ${g.totalHeight}`} style={{ display: "block", height: "auto", background: "#FFFFFF" }} fontFamily="Arial, Helvetica, sans-serif" fill="#202020">
    <rect width={g.width} height={g.totalHeight} fill="#FFFFFF"/>
    <text x={g.width / 2} y="28" textAnchor="middle" fontSize="20" fontWeight="500">Kaplan–Meier Estimates</text>
    <defs><clipPath id="km-plot-clip"><rect x={g.left} y={g.plotTop} width={plotWidth} height={plotHeight}/></clipPath></defs>
    <rect x={g.left} y={g.plotTop} width={plotWidth} height={plotHeight} fill="#F0F0F0"/>
    {[0, .2, .4, .6, .8, 1].map(t => <g key={t}><line x1={g.left} x2={g.left + plotWidth} y1={y(t)} y2={y(t)} stroke="#000000" strokeDasharray="4 4" opacity=".25" strokeWidth=".6"/><text x={g.left - 12} y={y(t) + 4} textAnchor="end" fontSize="12">{t.toFixed(1)}</text></g>)}
    {ticks.map(t => <g key={t}><line x1={x(t)} x2={x(t)} y1={g.plotTop} y2={g.plotBottom} stroke="#000000" strokeDasharray="4 4" opacity=".25" strokeWidth=".6"/><text x={x(t)} y={g.plotBottom + 23} textAnchor="middle" fontSize="12" data-figure="x-tick">{formatTick(t)}</text></g>)}
    <rect x={g.left} y={g.plotTop} width={plotWidth} height={plotHeight} fill="none" stroke="#555555" strokeWidth="1"/>
    <text data-figure="x-title" x={g.left + plotWidth / 2} y={g.axisTitleY} textAnchor="middle" fontSize="15">{timeColumn.endsWith("_MONTHS") ? "Time (Months)" : timeColumn}</text>
    <text transform={`translate(${g.left - 55} ${g.plotTop + plotHeight / 2}) rotate(-90)`} textAnchor="middle" fontSize="15">Probability</text>
    <g clipPath="url(#km-plot-clip)">
      {series.map(s => <g key={s.curve.label}>
        {showCI && <path d={bandPath(s.points, x, y)} fill={s.color} opacity=".16"/>}
        <path d={stepPath(s.points, x, y)} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round"/>
        {showCensors && censorMarks(s.curve, detail).map((c, i) => {
          let survival = 1; for (const p of s.points) if (p.t <= c.t + 1e-9) survival = p.s;
          return <path key={i} d={`M${x(c.t) - 3},${y(survival)}h6 M${x(c.t)},${y(survival) - 3}v6`} stroke={s.color} strokeWidth="1" fill="none"/>;
        })}
      </g>)}
    </g>
    <g data-figure="legend">{series.map((s, i) => {
      const lx = legendOnSide ? g.left + plotWidth + 20 : g.left + (i % 2) * plotWidth / 2;
      const entry = g.legendEntries[i];
      const ly = legendOnSide ? g.plotTop + entry.y : entry.y;
      const median = Number.isFinite(s.curve.median) ? `${Number(s.curve.median.toFixed(2))}${timeColumn.endsWith("_MONTHS") ? " months" : ""}` : "Not reached";
      return <g key={i}><line x1={lx} x2={lx + 20} y1={ly - 4} y2={ly - 4} stroke={s.color} strokeWidth="2"/><text x={lx + 26} y={ly} fontSize="11"><title>{s.curve.label}</title>{entry.lines.map((line, j) => <tspan x={lx + 26} dy={j ? 13 : 0} key={j}>{line}</tspan>)}</text>{showMedians && <text data-figure="legend-median" x={lx + 26} y={ly + (entry.lines.length - 1) * 13 + 17} fontSize="11" fill="#555555">Median: {median}</text>}</g>;
    })}</g>
    {showAtRisk && <g data-figure="risk-table">
      <text x={g.left} y={g.riskTitleY} fontSize="14" fontWeight="600">Number at risk</text>
      <text x={g.width - g.right} y={g.riskTitleY} textAnchor="end" fontSize="11" fill="#666666">End-of-period counts</text>
      {ticks.map(t => <text key={t} x={x(t)} y={g.riskTickY} textAnchor="middle" fontSize="12" data-figure="risk-tick">{formatTick(t)}</text>)}
      {series.map((s, i) => <g key={i}>
        <text x="10" y={g.riskRows[i].labelY} fill={s.color} fontSize="12" fontWeight="600">{g.riskRows[i].lines.map((line, j) => <tspan x="10" dy={j ? 14 : 0} key={j}>{line}</tspan>)}</text>
        {[['atRisk', 'At risk'], ['censored', 'Censored'], ['events', 'Events']].map(([key, label], ri) => <g key={key}>
          <text x={g.left - 40} y={g.riskRows[i].dataY + ri * 20} textAnchor="end" fontSize="11" data-risk-label={key}>{label}</text>
          {ticks.map(t => <text key={t} x={x(t)} y={g.riskRows[i].dataY + ri * 20} textAnchor="middle" fontSize="12" data-risk-time={t} data-risk-kind={key}>{riskAt(s.curve, t)[key]}</text>)}
        </g>)}
      </g>)}
    </g>}
  </svg>;
}
