export const RESULT_COLUMNS = ["Name", "Sequence", "% Identity with reference", "Status", "Orientation", "Hit position (probe)", "Hit position (reference)", "Alignment coverage", "Hit length", "Compared bases", "Masked bases", "Mismatches", "Position axis", "Source / provenance"];
export function resultRows(results) {
  return results.map(r => [r.name, r.seq.slice(0, 32000), r.identity === null ? "N/A" : Number(r.identity.toFixed(2)), r.status,
    r.orientation || "", r.probeStart ? `${r.probeStart}–${r.probeEnd}` : "", r.referenceStart ? `${r.referenceStart}–${r.referenceEnd}` : "",
    Number((r.coverage || 0).toFixed(2)), r.hitLength || 0, r.compared ?? 0, r.masked ?? 0, r.mismatches ?? "", r.hitAxis || "", r.provenance || ""]);
}
export function csvText(results) {
  const quote = value => `"${String(value ?? "").replace(/"/g, '""')}"`;
  return [RESULT_COLUMNS, ...resultRows(results)].map(row => row.map(quote).join(",")).join("\r\n");
}
export function filename(label = "sequence", extension = "xlsx", date = new Date()) {
  const safe = label.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "sequence";
  const day = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
  return `binding_results_${day}_${safe}.${extension}`;
}
export function databaseRows(entries) {
  return entries.map(r => [r.label || r.name, `${r.provenance || ""}${r.seq.length >= 32000 ? " (truncated to 32,000 bp)" : ""}`, r.seq.slice(0, 32000)]);
}
