/**
 * The Kaplan-Meier plot, drawn as SVG.
 *
 * Draws the survival step function, the confidence band, censored-observation
 * marks, the axes and (optionally) the "number at risk" table underneath —
 * the same elements the Streamlit app produced with matplotlib + lifelines.
 */
import React, { useMemo, useRef } from "react";
import { COLORS, PALETTE, bandPath, censorMarks, curvePoints, formatTick, makeScales, niceTicks, stepPath } from "../lib/plot.js";

const MARGIN = { top: 18, right: 150, bottom: 46, left: 58 };

export default function KmPlot({
  curves,
  detail = 1,
  showCI = true,
  showAtRisk = true,
  showCensors = true,
  width = 1000,
  height = 560,
  legendOnSide = false,
}) {
  const svgRef = useRef(null);

  const model = useMemo(() => {
    if (!curves || !curves.length) return null;

    const margin = { ...MARGIN, right: legendOnSide ? 170 : 30 };
    const scales = makeScales({ width, height, margin, curves, detail });

    const xTicks = niceTicks(scales.x1, 6);
    const yTicks = [0, 0.2, 0.4, 0.6, 0.8, 1];

    const series = curves.map((curve, i) => {
      const color = PALETTE[i % PALETTE.length];
      const points = curvePoints(curve, detail);
      return {
        curve,
        color,
        points,
        path: stepPath(points, scales.xScale, scales.yScale),
        band: showCI ? bandPath(points, scales.xScale, scales.yScale) : "",
        censors: showCensors ? censorMarks(curve, detail) : [],
      };
    });

    // At-risk table geometry (below the axes).
    const atRisk = showAtRisk
      ? curves.map((curve) => ({
          label: curve.label,
          rows: curve.atRisk || [],
        }))
      : [];

    return { scales, xTicks, yTicks, series, atRisk, margin };
  }, [curves, detail, showCI, showAtRisk, showCensors, width, height, legendOnSide]);

  if (!model) return null;
  const { scales, xTicks, yTicks, series, atRisk, margin } = model;

  const legendRight = legendOnSide;
  const plotBottom = margin.top + scales.innerH;
  const atRiskRowH = 17;
  const atRiskHeaderH = 22;
  // The at-risk table sits *below* the x-axis, so the axis title has to move
  // down to make room for it — otherwise the two overlap.
  const axisTitleY = plotBottom + (atRisk.length ? 38 : 38);
  const atRiskTop = plotBottom + (atRisk.length ? 48 : 0);
  const atRiskHeight = atRisk.length ? atRiskHeaderH + atRisk.length * atRiskRowH + 8 : 0;
  const totalHeight = height + atRiskHeight;

  return (
    <svg
      ref={svgRef}
      id="km-plot-svg"
      xmlns="http://www.w3.org/2000/svg"
      width="100%"
      height={totalHeight}
      viewBox={`0 0 ${width} ${totalHeight}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ display: "block", background: COLORS.panel }}
    >
      <defs>
        <clipPath id="km-plot-clip">
          <rect x={margin.left} y={margin.top} width={scales.innerW} height={scales.innerH} />
        </clipPath>
      </defs>

      {/* plot background */}
      <rect x={margin.left} y={margin.top} width={scales.innerW} height={scales.innerH} fill="#12151B" />

      {/* horizontal grid + y axis */}
      {yTicks.map((t) => (
        <g key={`y${t}`}>
          <line
            x1={margin.left}
            x2={margin.left + scales.innerW}
            y1={scales.yScale(t)}
            y2={scales.yScale(t)}
            stroke={COLORS.grid}
            strokeWidth="1"
          />
          <text
            x={margin.left - 10}
            y={scales.yScale(t) + 4}
            textAnchor="end"
            fill={COLORS.textDim}
            fontSize="11"
            fontFamily="IBM Plex Mono, monospace"
          >
            {t.toFixed(1)}
          </text>
        </g>
      ))}

      {/* vertical grid + x axis */}
      {xTicks.map((t) => (
        <g key={`x${t}`}>
          <line
            x1={scales.xScale(t)}
            x2={scales.xScale(t)}
            y1={margin.top}
            y2={plotBottom}
            stroke={COLORS.grid}
            strokeWidth="1"
          />
          <text
            x={scales.xScale(t)}
            y={plotBottom + 18}
            textAnchor="middle"
            fill={COLORS.textDim}
            fontSize="11"
            fontFamily="IBM Plex Mono, monospace"
          >
            {formatTick(t)}
          </text>
        </g>
      ))}

      {/* axis frame */}
      <rect
        x={margin.left}
        y={margin.top}
        width={scales.innerW}
        height={scales.innerH}
        fill="none"
        stroke={COLORS.axis}
        strokeWidth="1"
      />

      {/* axis titles */}
      <text
        x={margin.left + scales.innerW / 2}
        y={axisTitleY}
        textAnchor="middle"
        fill={COLORS.textDim}
        fontSize="12"
      >
        Time (Months)
      </text>
      <text
        transform={`translate(${margin.left - 40} ${margin.top + scales.innerH / 2}) rotate(-90)`}
        textAnchor="middle"
        fill={COLORS.textDim}
        fontSize="12"
      >
        Probability
      </text>

      {/* curves */}
      <g clipPath="url(#km-plot-clip)">
        {series.map((s) =>
          s.band ? (
            <path key={`band-${s.curve.label}`} d={s.band} fill={s.color} opacity="0.13" stroke="none" />
          ) : null
        )}
        {series.map((s) => (
          <path
            key={`line-${s.curve.label}`}
            d={s.path}
            fill="none"
            stroke={s.color}
            strokeWidth="2"
            strokeLinejoin="round"
          />
        ))}
        {/* censored observation marks */}
        {series.map((s) =>
          s.censors.map((c, i) => {
            // survival value at the censor time
            let sv = 1;
            for (const p of s.points) {
              if (p.t <= c.t + 1e-9) sv = p.s;
            }
            return (
              <g key={`c-${s.curve.label}-${i}`}>
                <line
                  x1={scales.xScale(c.t)}
                  x2={scales.xScale(c.t)}
                  y1={scales.yScale(sv) - 5}
                  y2={scales.yScale(sv) + 5}
                  stroke={s.color}
                  strokeWidth="1.4"
                />
                <line
                  x1={scales.xScale(c.t) - 5}
                  x2={scales.xScale(c.t) + 5}
                  y1={scales.yScale(sv)}
                  y2={scales.yScale(sv)}
                  stroke={s.color}
                  strokeWidth="1.4"
                />
              </g>
            );
          })
        )}
      </g>

      {/* legend */}
      {series.map((s, i) => {
        const lx = legendRight ? margin.left + scales.innerW + 18 : 0;
        const ly = legendRight ? margin.top + 6 + i * 18 : 0;
        if (!legendRight) return null;
        return (
          <g key={`leg-${s.curve.label}`}>
            <rect x={lx} y={ly} width="12" height="3" rx="1.5" fill={s.color} />
            <text
              x={lx + 18}
              y={ly + 5}
              fill={COLORS.text}
              fontSize="11"
              fontFamily="IBM Plex Sans, sans-serif"
            >
              {s.curve.label.length > 22 ? s.curve.label.slice(0, 21) + "…" : s.curve.label}
            </text>
          </g>
        );
      })}

      {/* at-risk table */}
      {atRisk.length > 0 && (
        <g>
          <line
            x1={margin.left}
            x2={margin.left + scales.innerW}
            y1={atRiskTop - 10}
            y2={atRiskTop - 10}
            stroke={COLORS.axis}
            strokeWidth="1"
          />
          {xTicks.map((t) => (
            <text
              key={`ar-x${t}`}
              x={scales.xScale(t)}
              y={atRiskTop + 6}
              textAnchor="middle"
              fill={COLORS.textDim}
              fontSize="10.5"
              fontFamily="IBM Plex Mono, monospace"
            >
              {formatTick(t)}
            </text>
          ))}
          {atRisk.map((row, ri) => (
            <g key={`ar-${row.label}`}>
              <text
                x={margin.left - 10}
                y={atRiskTop + atRiskHeaderH + ri * atRiskRowH + 4}
                textAnchor="end"
                fill={PALETTE[curves.findIndex((c) => c.label === row.label) % PALETTE.length]}
                fontSize="10.5"
                fontFamily="IBM Plex Sans, sans-serif"
              >
                {row.label.length > 16 ? row.label.slice(0, 15) + "…" : row.label}
              </text>
              {row.rows.map((r, ci) => (
                <text
                  key={`ar-${row.label}-${ci}`}
                  x={scales.xScale(r.t)}
                  y={atRiskTop + atRiskHeaderH + ri * atRiskRowH + 4}
                  textAnchor="middle"
                  fill={COLORS.text}
                  fontSize="10.5"
                  fontFamily="IBM Plex Mono, monospace"
                >
                  {r.atRisk}
                </text>
              ))}
            </g>
          ))}
        </g>
      )}
    </svg>
  );
}
