export function cleanSeq(raw = "") {
  return String(raw).toUpperCase().replace(/U/g, "T").replace(/[^ACGTN]/g, "");
}

export function inspectSequence(raw = "", { file = false } = {}) {
  const original = String(raw);
  const headers = original.match(/^\s*>/gm) || [];
  if (headers.length && (!file || headers.length > 1)) {
    return { seq: "", error: "Looks like FASTA format — paste only the sequence, no header line.", notices: [] };
  }
  const text = file && headers.length ? original.replace(/^\s*>[^\r\n]*(?:\r?\n|$)/, "") : original;
  const seq = cleanSeq(text);
  const stripped = text.length ? (text.length - seq.length) / text.length * 100 : 0;
  const nPercent = seq.length ? (seq.match(/N/g) || []).length / seq.length * 100 : 0;
  const notices = [];
  if (stripped > 10) notices.push(`Stripped ${stripped.toFixed(1)}% of the pasted text (non-ACGT characters).`);
  if (nPercent > 5) notices.push(`${nPercent.toFixed(1)}% N bases · masked from identity.`);
  if (seq.length > 100000) notices.push("Over 100 kb · analysis may take longer.");
  return { seq, notices, stripped, nPercent, error: text && !seq ? "No valid sequence bases." : "" };
}

export function detectHeader(rows) {
  const first = rows[0] || [];
  const cell = i => String(first[i] || "").trim().toLowerCase();
  return ["name", "id"].includes(cell(0)) || ["name", "id"].includes(cell(1)) || ["sequence", "seq"].includes(cell(2));
}

export function parseRows(rows, header = detectHeader(rows)) {
  const entries = [], skipped = [];
  for (let i = header ? 1 : 0; i < rows.length; i++) {
    const row = rows[i] || [];
    const label = String(row[0] ?? "").trim(), provenance = String(row[1] ?? "").trim();
    const name = [label, provenance].filter(Boolean).join(" - ");
    const raw = String(row[2] ?? "").trim(), seq = cleanSeq(raw);
    if (!name && !raw) continue;
    if (seq.length < 4) { skipped.push(name || `row ${i + 1}`); continue; }
    entries.push({ name: name || `Sequence ${i + 1}`, label: label || `Sequence ${i + 1}`, provenance, seq, inputOrder: i });
  }
  return { entries, skipped };
}

export function parseFasta(text) {
  const entries = []; let header = null, parts = [];
  const add = () => { if (header !== null) { const seq = cleanSeq(parts.join("")); if (!seq) throw Error("Empty FASTA record."); entries.push({ name: header, label: header.split(/\s+/)[0], provenance: header, seq, inputOrder: entries.length }); } };
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith(">")) { add(); header = line.slice(1).trim(); parts = []; }
    else if (line.trim()) { if (header === null) throw Error("Expected an NCBI FASTA header."); parts.push(line.trim()); }
  }
  add(); if (!entries.length) throw Error("No FASTA entries found."); return entries;
}
