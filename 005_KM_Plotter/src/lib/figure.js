// Figure coordinates are explicit so screen, SVG and PNG share one layout.
export function riskAt(curve, time) {
  let atRisk = curve.n, events = 0, censored = 0;
  for (const row of curve.eventTable || []) {
    if (row.time <= time + 1e-9) {
      atRisk = row.atRisk - row.removed;
      events += row.observed; censored += row.censored;
    }
  }
  return { atRisk, events, censored };
}

export function wrapLabel(text, length = 32) {
  const lines = [];
  let rest = String(text);
  while (rest.length > length) {
    let cut = rest.lastIndexOf(" ", length);
    if (cut < length / 2) cut = length;
    lines.push(rest.slice(0, cut)); rest = rest.slice(cut).trimStart();
  }
  lines.push(rest); return lines;
}

export function figureGeometry({ curves, showAtRisk, side, showMedians = true, width = 1100 }) {
  const legendEntries = curves.map(c => {
    const lines = wrapLabel(c.label, side ? 31 : 55);
    return { lines, height: lines.length * 13 + (showMedians ? 17 : 0) + 14 };
  });
  let legendHeight = 0;
  if (side) for (const entry of legendEntries) { entry.y = 12 + legendHeight; legendHeight += entry.height; }
  else for (let i = 0; i < legendEntries.length; i += 2) {
    legendEntries[i].y = 52 + legendHeight;
    if (legendEntries[i + 1]) legendEntries[i + 1].y = 52 + legendHeight;
    legendHeight += Math.max(legendEntries[i].height, legendEntries[i + 1]?.height || 0);
  }
  const plotTop = side ? 66 : 66 + legendHeight;
  const plotBottom = plotTop + Math.max(380, side ? legendHeight : 380);
  const left = showAtRisk ? 190 : 80, right = side ? 285 : 32;
  const axisTitleY = plotBottom + 48;
  const riskTitleY = axisTitleY + 40, riskTickY = riskTitleY + 25;
  const riskFirstRowY = riskTickY + 28;
  let nextY = riskFirstRowY;
  const riskRows = curves.map(c => {
    const lines = wrapLabel(c.label, 115), labelY = nextY;
    const dataY = labelY + lines.length * 14 + 3;
    nextY = dataY + 71;
    return { lines, labelY, dataY };
  });
  const totalHeight = showAtRisk ? nextY + 16 : axisTitleY + 28;
  return { width, left, right, plotTop, plotBottom, axisTitleY, riskTitleY, riskTickY, riskFirstRowY, riskRows, legendEntries, totalHeight };
}
