/**
 * Geometry for the Kaplan-Meier plot.
 *
 * Pure functions: the same code draws the on-screen SVG and the exported
 * PNG/SVG, so what you see is exactly what you get in the file.
 *
 * The curve follows lifelines' conventions:
 *   - step function ("steps-post"): the survival probability is held flat
 *     from one event time to the next;
 *   - the curve starts at (0, 1);
 *   - censored observations are marked with a "+".
 */

export const PALETTE = [
  "#38BDF8", // sky
  "#F472B6", // pink
  "#A3E635", // lime
  "#FBBF24", // amber
  "#C084FC", // purple
  "#2DD4BF", // teal
  "#FB7185", // rose
  "#4ADE80", // green
  "#60A5FA", // blue
  "#FDBA74", // orange
];

export const COLORS = {
  bg: "#0F1115",
  panel: "#161A21",
  panelAlt: "#1B2029",
  border: "#2A313C",
  text: "#E6EAF0",
  textDim: "#8B95A5",
  grid: "#242A34",
  axis: "#39414E",
  band: "currentColor",
};

/** Nice-ish tick values across [0, max] with ~`count` steps. */
export function niceTicks(max, count = 6) {
  if (!isFinite(max) || max <= 0) return [0, 1];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  let step;
  if (norm <= 1) step = 1;
  else if (norm <= 2) step = 2;
  else if (norm <= 2.5) step = 2.5;
  else if (norm <= 5) step = 5;
  else step = 10;
  step *= mag;

  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) {
    ticks.push(Number(v.toFixed(10)));
  }
  if (ticks[ticks.length - 1] < max) ticks.push(Number((Math.ceil(max / step) * step).toFixed(10)));
  return ticks;
}

/** Format a tick label, trimming trailing zeros. */
export function formatTick(v) {
  if (Number.isInteger(v)) return String(v);
  const abs = Math.abs(v);
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 10) return v.toFixed(1);
  if (abs >= 1) return v.toFixed(1);
  return v.toFixed(2);
}

/**
 * Build the vertices of a step ("steps-post") polyline.
 *
 * A Kaplan-Meier curve holds its level flat from one event time to the next,
 * so each point contributes two vertices: the previous level at the new x,
 * then the new level at the same x.
 */
function stepVertices(points, valueOf, xScale, yScale) {
  const verts = [];
  let prevY = null;
  for (let i = 0; i < points.length; i++) {
    const x = xScale(points[i].t);
    const y = yScale(valueOf(points[i]));
    if (i === 0) {
      verts.push([x, y]);
    } else {
      verts.push([x, prevY]);
      verts.push([x, y]);
    }
    prevY = y;
  }
  return verts;
}

/**
 * Build the step path for one curve.
 * @returns {string} SVG path data
 */
export function stepPath(points, xScale, yScale) {
  if (!points.length) return "";
  const verts = stepVertices(points, (p) => p.s, xScale, yScale);
  let d = `M ${verts[0][0]} ${verts[0][1]}`;
  for (let i = 1; i < verts.length; i++) {
    d += ` L ${verts[i][0]} ${verts[i][1]}`;
  }
  return d;
}

/**
 * Build the closed path of the confidence band.
 *
 * The band is the upper step polyline followed by the lower step polyline
 * walked back to the start.
 */
export function bandPath(points, xScale, yScale) {
  if (!points.length) return "";
  const upper = stepVertices(points, (p) => p.upper, xScale, yScale);
  const lower = stepVertices(points, (p) => p.lower, xScale, yScale);

  let d = `M ${upper[0][0]} ${upper[0][1]}`;
  for (let i = 1; i < upper.length; i++) {
    d += ` L ${upper[i][0]} ${upper[i][1]}`;
  }
  // Walk the lower boundary back to the start.
  for (let i = lower.length - 1; i >= 0; i--) {
    d += ` L ${lower[i][0]} ${lower[i][1]}`;
  }
  d += " Z";
  return d;
}

/**
 * Turn a fitted curve into the points the plot needs.
 *
 * `detail` (0..1) truncates the curve to the first N% of its event times,
 * which is the Streamlit app's "Datapoints to plot (%)" slider.
 */
export function curvePoints(curve, detail = 1) {
  const n = curve.timeline.length;
  if (!n) return [];
  const keep = Math.max(2, Math.floor(n * detail));
  const out = [];
  for (let i = 0; i < keep; i++) {
    out.push({
      t: curve.timeline[i],
      s: curve.survival[i],
      lower: curve.lower[i],
      upper: curve.upper[i],
    });
  }
  return out;
}

/** Censor marks: where patients were censored (at-risk table has the counts). */
export function censorMarks(curve, detail = 1) {
  const marks = [];
  for (const row of curve.eventTable || []) {
    if (row.censored > 0) {
      marks.push({ t: row.time, n: row.censored });
    }
  }
  // Truncate consistently with the visible curve.
  if (marks.length) {
    const lastT = curve.timeline[Math.max(0, Math.floor(curve.timeline.length * detail) - 1)];
    return marks.filter((m) => m.t <= lastT + 1e-9);
  }
  return marks;
}

/** The x domain for the plot: 0 to the largest time across all curves. */
export function xDomain(curves, detail = 1) {
  let max = 0;
  for (const c of curves) {
    const pts = curvePoints(c, detail);
    if (pts.length) max = Math.max(max, pts[pts.length - 1].t);
  }
  return [0, max || 1];
}

/** Build the scales for a given plot box. */
export function makeScales({ width, height, margin, curves, detail = 1, yMax = 1 }) {
  const [x0, x1] = xDomain(curves, detail);
  const innerW = Math.max(1, width - margin.left - margin.right);
  const innerH = Math.max(1, height - margin.top - margin.bottom);

  const xScale = (t) => margin.left + ((t - x0) / (x1 - x0 || 1)) * innerW;
  const yScale = (s) => margin.top + (1 - s / yMax) * innerH;

  return { xScale, yScale, x0, x1, innerW, innerH };
}
