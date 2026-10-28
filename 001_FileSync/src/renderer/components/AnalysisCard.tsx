export function AnalysisCard({ label, value, detail, validated = false }: { label: string; value: string; detail?: string; validated?: boolean }) {
  return (
    <dl className={`min-w-0 rounded-lg border px-3 py-3 shadow-sm ${validated ? "border-emerald-500 bg-emerald-100 text-emerald-950" : "border-analysis-border bg-analysis text-sky-950"}`}>
      <dt className="text-xs font-semibold uppercase tracking-wide">{validated && <span aria-label="Checked">✓ </span>}{label}</dt>
      <dd className="mt-1 break-words text-lg font-semibold tabular-nums">{value}</dd>
      {detail && <dd className="mt-2 text-sm leading-snug">{detail}</dd>}
    </dl>
  );
}
