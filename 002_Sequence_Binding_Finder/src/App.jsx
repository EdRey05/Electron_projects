import React, { useState, useRef, useCallback } from "react";
import * as XLSX from "xlsx";
import {
  Dna,
  Upload,
  Play,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Download,
  RotateCcw,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

// ---------- Sequence utilities ----------

const VALID = new Set(["A", "C", "G", "T", "U", "N"]);

function cleanSeq(raw) {
  if (!raw) return "";
  return raw
    .toString()
    .toUpperCase()
    .replace(/U/g, "T")
    .split("")
    .filter((c) => VALID.has(c) || c === "T")
    .join("")
    .split("")
    .filter((c) => c === "A" || c === "C" || c === "G" || c === "T" || c === "N")
    .join("");
}

const COMP = { A: "T", T: "A", C: "G", G: "C", N: "N" };

function revcomp(seq) {
  let out = "";
  for (let i = seq.length - 1; i >= 0; i--) out += COMP[seq[i]] || "N";
  return out;
}

// Best-window search (branch & bound on mismatch count)
function bestWindow(ref, query) {
  const rlen = ref.length;
  const qlen = query.length;
  if (qlen === 0 || rlen < qlen) return null;

  let bestMismatch = Infinity;
  let bestPos = -1;
  const lastStart = rlen - qlen;

  for (let i = 0; i <= lastStart; i++) {
    let mismatches = 0;
    for (let j = 0; j < qlen; j++) {
      const rc = ref[i + j];
      const qc = query[j];
      if (rc !== qc && rc !== "N" && qc !== "N") {
        mismatches++;
        if (mismatches >= bestMismatch) break;
      }
    }
    if (mismatches < bestMismatch) {
      bestMismatch = mismatches;
      bestPos = i;
      if (bestMismatch === 0) break;
    }
  }
  if (bestPos === -1) return null;
  const identity = ((qlen - bestMismatch) / qlen) * 100;
  return { pos: bestPos, mismatches: bestMismatch, identity, qlen };
}

function alignTrack(ref, query, pos) {
  const bases = [];
  for (let j = 0; j < query.length; j++) {
    const rc = ref[pos + j];
    const qc = query[j];
    const match = rc === qc || rc === "N" || qc === "N";
    bases.push({ base: qc, match });
  }
  return bases;
}

const THRESHOLDS = [80, 85, 90, 95, 100];

// ---------- UI ----------

export default function SequenceBindingFinder() {
  const [reference, setReference] = useState("");
  const [refName, setRefName] = useState("");
  const [entries, setEntries] = useState([]); // {name, seq}
  const [fileError, setFileError] = useState("");
  const [fileName, setFileName] = useState("");
  const [threshold, setThreshold] = useState(90);
  const [results, setResults] = useState(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [expanded, setExpanded] = useState(null);
  const [onlyMatches, setOnlyMatches] = useState(true);
  const fileInputRef = useRef(null);

  const refClean = cleanSeq(reference);

  const handleFile = useCallback((file) => {
    setFileError("");
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: "array" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });

        let startIdx = 0;
        if (rows.length > 0) {
          const a0 = (rows[0][0] || "").toString().trim().toLowerCase();
          const b0 = (rows[0][1] || "").toString().trim().toLowerCase();
          const c0 = (rows[0][2] || "").toString().trim().toLowerCase();
          if (
            ["name", "id"].includes(a0) ||
            ["name", "id"].includes(b0) ||
            ["sequence", "seq"].includes(c0)
          ) {
            startIdx = 1;
          }
        }

        const parsed = [];
        const skipped = [];
        for (let i = startIdx; i < rows.length; i++) {
          const row = rows[i];
          if (!row || row.length === 0) continue;
          const a = (row[0] ?? "").toString().trim();
          const b = (row[1] ?? "").toString().trim();
          const name = [a, b].filter(Boolean).join(" - ");
          const seqRaw = (row[2] ?? "").toString().trim();
          const seq = cleanSeq(seqRaw);
          if (!name && !seqRaw) continue;
          if (!seq || seq.length < 4) {
            skipped.push(name || `row ${i + 1}`);
            continue;
          }
          parsed.push({ name: name || `Sequence ${i + 1}`, seq });
        }
        setEntries(parsed);
        if (skipped.length > 0) {
          setFileError(
            `${skipped.length} row(s) skipped (missing or invalid sequence): ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? "…" : ""}`
          );
        }
        setResults(null);
      } catch (err) {
        setFileError("Could not read this file. Please check that it is a valid Excel (.xlsx) file.");
        setEntries([]);
      }
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const onDrop = (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  // Build the workbook in the renderer, then ask Electron main to save it
  // at a path the user picks. If main is unavailable (web preview), fall
  // back to the original browser-download behavior so the JSX can also run
  // outside Electron.
  const persistResultsXLSX = useCallback(async (data) => {
    const rows = data.map((r) => ({
      Name: r.name,
      Sequence: r.seq,
      "% Identity with reference": r.identity != null ? Number(r.identity.toFixed(2)) : "N/A",
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [{ wch: 28 }, { wch: 50 }, { wch: 24 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Results");
    const arrayBuf = XLSX.write(wb, { bookType: "xlsx", type: "array" });

    if (window.api && typeof window.api.saveResultsXlsx === "function") {
      const ok = await window.api.saveResultsXlsx("binding_results.xlsx", arrayBuf);
      return !!ok;
    }
    // Browser / web preview fallback.
    XLSX.writeFile(wb, "binding_results.xlsx");
    return true;
  }, []);

  const runAnalysis = async () => {
    if (!refClean || entries.length === 0) return;
    setRunning(true);
    setProgress(0);
    setResults(null);

    const out = [];
    const CHUNK_YIELD = 1;

    for (let idx = 0; idx < entries.length; idx++) {
      const { name, seq } = entries[idx];

      if (seq.length > refClean.length) {
        out.push({
          name,
          seq,
          status: "too-long",
          identity: null,
          strand: null,
          pos: null,
        });
      } else {
        const fwd = bestWindow(refClean, seq);
        const rev = bestWindow(refClean, revcomp(seq));

        let chosen = null;
        let strand = null;
        if (fwd && (!rev || fwd.identity >= rev.identity)) {
          chosen = fwd;
          strand = "forward";
        } else if (rev) {
          chosen = rev;
          strand = "reverse";
        }

        if (chosen) {
          const usedQuery = strand === "forward" ? seq : revcomp(seq);
          out.push({
            name,
            seq,
            status: chosen.identity >= threshold ? "match" : "no-match",
            identity: chosen.identity,
            strand,
            pos: chosen.pos,
            qlen: chosen.qlen,
            track: alignTrack(refClean, usedQuery, chosen.pos),
          });
        } else {
          out.push({ name, seq, status: "error", identity: null, strand: null, pos: null });
        }
      }

      if (idx % CHUNK_YIELD === 0) {
        setProgress(Math.round(((idx + 1) / entries.length) * 100));
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    out.sort((a, b) => (b.identity ?? -1) - (a.identity ?? -1));
    setResults(out);
    setRunning(false);
    setProgress(100);
    await persistResultsXLSX(out);
  };

  const reset = () => {
    setReference("");
    setRefName("");
    setEntries([]);
    setFileError("");
    setFileName("");
    setResults(null);
    setExpanded(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const exportCSV = () => {
    if (!results) return;
    const header = "Name,Status,%Identity,Strand,Start,End,Length\n";
    const rows = results
      .map((r) => {
        const status = r.status === "match" ? "Match" : r.status === "no-match" ? "Below threshold" : r.status === "too-long" ? "Too long" : "Error";
        const strand = r.strand === "forward" ? "Forward" : r.strand === "reverse" ? "Reverse" : "";
        const start = r.pos != null ? r.pos + 1 : "";
        const end = r.pos != null ? r.pos + (r.qlen ?? 0) : "";
        const identity = r.identity != null ? r.identity.toFixed(2) : "";
        return `"${r.name.replace(/"/g, '""')}",${status},${identity},${strand},${start},${end},${r.seq.length}`;
      })
      .join("\n");
    const blob = new Blob([header + rows], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "binding_results.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const matchCount = results ? results.filter((r) => r.status === "match").length : 0;
  const displayedResults = results ? (onlyMatches ? results.filter((r) => r.status === "match") : results) : [];

  const ink = "#12211D";
  const paper = "#F5F7F6";
  const panelDark = "#0B1F1C";
  const teal = "#0E7C7B";
  const tealDeep = "#0A5F5E";
  const amber = "#E2A33D";
  const coral = "#C1553D";
  const border = "#D8DFDC";

  return (
    <div style={{ background: paper, color: ink, minHeight: "100%", fontFamily: "'IBM Plex Sans', sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        .sbf-mono { font-family: 'IBM Plex Mono', monospace; }
        .sbf-display { font-family: 'Space Grotesk', sans-serif; }
        .sbf-textarea::placeholder { color: #8FA39D; }
        .sbf-scroll::-webkit-scrollbar { height: 6px; width: 6px; }
        .sbf-scroll::-webkit-scrollbar-thumb { background: ${teal}; border-radius: 4px; }
        .sbf-row:hover { background: #EEF3F1; }
        .sbf-btn-primary:hover:not(:disabled) { background: ${tealDeep}; }
        .sbf-btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
        .sbf-drop.drag { border-color: ${teal} !important; background: #E9F3F2 !important; }
      `}</style>

      <div className="max-w-5xl mx-auto px-6 py-10">
        {/* Header / signature */}
        <div className="flex items-start justify-between mb-10 border-b pb-6" style={{ borderColor: border }}>
          <div className="flex items-center gap-3">
            <div style={{ background: panelDark }} className="w-11 h-11 rounded-md flex items-center justify-center shrink-0">
              <Dna size={22} color={teal} strokeWidth={1.75} />
            </div>
            <div>
              <h1 className="sbf-display text-2xl font-semibold tracking-tight">Binding Search</h1>
              <p className="text-sm mt-0.5" style={{ color: "#5B706A" }}>
                Forward / reverse-complement local alignment against a reference sequence
              </p>
            </div>
          </div>
          <button
            onClick={reset}
            className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border shrink-0"
            style={{ borderColor: border, color: "#5B706A" }}
          >
            <RotateCcw size={14} /> Reset
          </button>
        </div>

        {/* Step 1 : reference */}
        <section className="mb-8">
          <div className="flex items-center gap-2 mb-3">
            <span className="sbf-mono text-xs px-2 py-0.5 rounded" style={{ background: panelDark, color: teal }}>
              01
            </span>
            <h2 className="sbf-display text-base font-semibold">Reference sequence</h2>
            <span className="text-xs" style={{ color: "#8FA39D" }}>
              up to 15,000 bp
            </span>
          </div>
          <div className="rounded-lg overflow-hidden border" style={{ borderColor: border }}>
            <input
              type="text"
              value={refName}
              onChange={(e) => setRefName(e.target.value)}
              placeholder="Reference name (optional)"
              className="w-full px-4 py-2 text-sm outline-none border-b"
              style={{ borderColor: border }}
            />
            <textarea
              className="sbf-textarea sbf-mono w-full px-4 py-3 text-xs outline-none resize-none"
              style={{ background: panelDark, color: "#EAF3F1", lineHeight: 1.6 }}
              rows={6}
              maxLength={20000}
              placeholder="Paste the reference nucleotide sequence here (ACGT / ACGU)…"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
            <div className="flex items-center justify-between px-4 py-2 text-xs" style={{ background: "#EEF3F1", color: "#5B706A" }}>
              <span>{refClean.length.toLocaleString("en-US")} valid bp</span>
              {refClean.length > 15000 && (
                <span className="flex items-center gap-1" style={{ color: coral }}>
                  <AlertTriangle size={13} /> Exceeds 15 kb — positions beyond that will be ignored
                </span>
              )}
            </div>
          </div>
        </section>

        {/* Step 2 : excel */}
        <section className="mb-8">
          <div className="flex items-center gap-2 mb-3">
            <span className="sbf-mono text-xs px-2 py-0.5 rounded" style={{ background: panelDark, color: teal }}>
              02
            </span>
            <h2 className="sbf-display text-base font-semibold">Sequences to test</h2>
            <span className="text-xs" style={{ color: "#8FA39D" }}>
              columns A + B = name, column C = sequence
            </span>
          </div>

          <div
            className="sbf-drop rounded-lg border-2 border-dashed flex flex-col items-center justify-center py-8 px-4 text-center cursor-pointer transition-colors"
            style={{ borderColor: border }}
            onDragOver={(e) => {
              e.preventDefault();
              e.currentTarget.classList.add("drag");
            }}
            onDragLeave={(e) => e.currentTarget.classList.remove("drag")}
            onDrop={(e) => {
              e.currentTarget.classList.remove("drag");
              onDrop(e);
            }}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={22} color={teal} className="mb-2" />
            <p className="text-sm font-medium">
              {fileName ? fileName : "Drop an .xlsx file here, or click to browse"}
            </p>
            {entries.length > 0 && (
              <p className="sbf-mono text-xs mt-1" style={{ color: teal }}>
                {entries.length} sequence(s) loaded
              </p>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
            />
          </div>
          {fileError && (
            <p className="text-xs mt-2 flex items-center gap-1" style={{ color: coral }}>
              <AlertTriangle size={13} /> {fileError}
            </p>
          )}
        </section>

        {/* Step 3 : threshold + run */}
        <section className="mb-10">
          <div className="flex items-center gap-2 mb-3">
            <span className="sbf-mono text-xs px-2 py-0.5 rounded" style={{ background: panelDark, color: teal }}>
              03
            </span>
            <h2 className="sbf-display text-base font-semibold">Identity threshold</h2>
          </div>

          <div className="flex flex-wrap items-center gap-6">
            <div className="flex rounded-md overflow-hidden border" style={{ borderColor: border }}>
              {THRESHOLDS.map((t) => (
                <button
                  key={t}
                  onClick={() => setThreshold(t)}
                  className="sbf-mono text-sm px-4 py-2 transition-colors"
                  style={{
                    background: threshold === t ? teal : "transparent",
                    color: threshold === t ? "#fff" : ink,
                    borderRight: t !== 100 ? `1px solid ${border}` : "none",
                  }}
                >
                  {t}%
                </button>
              ))}
            </div>

            <button
              onClick={runAnalysis}
              disabled={!refClean || entries.length === 0 || running}
              className="sbf-btn-primary flex items-center gap-2 px-5 py-2.5 rounded-md text-sm font-semibold text-white transition-colors"
              style={{ background: teal }}
            >
              <Play size={15} fill="#fff" /> {running ? `Analyzing… ${progress}%` : "Run analysis"}
            </button>
          </div>

          {running && (
            <div className="mt-3 h-1.5 rounded-full overflow-hidden" style={{ background: border }}>
              <div className="h-full transition-all" style={{ width: `${progress}%`, background: teal }} />
            </div>
          )}
          {!running && results && (
            <p className="text-xs mt-2 flex items-center gap-1" style={{ color: "#5B706A" }}>
              <Download size={12} /> binding_results.xlsx was saved.
            </p>
          )}
        </section>

        {/* Results */}
        {results && (
          <section>
            <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
              <div className="flex items-center gap-2">
                <span className="sbf-mono text-xs px-2 py-0.5 rounded" style={{ background: panelDark, color: teal }}>
                  04
                </span>
                <h2 className="sbf-display text-base font-semibold">Results</h2>
                <span
                  className="sbf-mono text-xs px-2 py-0.5 rounded-full"
                  style={{ background: matchCount > 0 ? "#E4F1EF" : "#F4E6E2", color: matchCount > 0 ? tealDeep : coral }}
                >
                  {matchCount} / {results.length} ≥ {threshold}%
                </span>
              </div>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-xs cursor-pointer select-none" style={{ color: "#5B706A" }}>
                  <input type="checkbox" checked={onlyMatches} onChange={(e) => setOnlyMatches(e.target.checked)} />
                  Show matches only
                </label>
                <button
                  onClick={() => persistResultsXLSX(results)}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border"
                  style={{ borderColor: border, color: "#5B706A" }}
                >
                  <Download size={13} /> Save .xlsx…
                </button>
                <button
                  onClick={exportCSV}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border"
                  style={{ borderColor: border, color: "#5B706A" }}
                >
                  <Download size={13} /> Save .csv…
                </button>
              </div>
            </div>

            <div className="rounded-lg border overflow-hidden" style={{ borderColor: border }}>
              {displayedResults.length === 0 ? (
                <div className="py-10 text-center text-sm" style={{ color: "#8FA39D" }}>
                  No sequence reaches the {threshold}% threshold.
                </div>
              ) : (
                displayedResults.map((r, i) => {
                  const isOpen = expanded === i;
                  const statusColor =
                    r.status === "match" ? teal : r.status === "no-match" ? amber : coral;
                  return (
                    <div key={i} style={{ borderTop: i === 0 ? "none" : `1px solid ${border}` }}>
                      <div
                        className="sbf-row flex items-center gap-3 px-4 py-3 cursor-pointer"
                        onClick={() => setExpanded(isOpen ? null : i)}
                      >
                        {r.status === "match" ? (
                          <CheckCircle2 size={17} color={teal} className="shrink-0" />
                        ) : r.status === "no-match" ? (
                          <XCircle size={17} color={amber} className="shrink-0" />
                        ) : (
                          <AlertTriangle size={17} color={coral} className="shrink-0" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium truncate">{r.name}</div>
                          <div className="sbf-mono text-xs mt-0.5" style={{ color: "#8FA39D" }}>
                            {r.status === "too-long"
                              ? `Sequence (${r.seq.length} bp) longer than the reference`
                              : r.status === "error"
                              ? "Could not align"
                              : `${r.strand === "forward" ? "Forward" : "Reverse"} · pos. ${r.pos + 1}–${r.pos + r.qlen} · ${r.seq.length} bp`}
                          </div>
                        </div>
                        {r.identity != null && (
                          <div
                            className="sbf-mono text-sm font-semibold shrink-0 px-2.5 py-1 rounded"
                            style={{ color: statusColor, background: `${statusColor}18` }}
                          >
                            {r.identity.toFixed(1)}%
                          </div>
                        )}
                        {r.track && (isOpen ? <ChevronUp size={16} color="#8FA39D" /> : <ChevronDown size={16} color="#8FA39D" />)}
                      </div>

                      {isOpen && r.track && (
                        <div className="px-4 pb-4">
                          <div
                            className="sbf-scroll sbf-mono text-[10px] leading-none rounded-md p-3 overflow-x-auto whitespace-nowrap"
                            style={{ background: panelDark }}
                          >
                            {r.track.map((b, bi) => (
                              <span key={bi} style={{ color: b.match ? "#7FD8CB" : amber, opacity: b.match ? 0.9 : 1 }}>
                                {b.base}
                              </span>
                            ))}
                          </div>
                          <p className="text-[11px] mt-1.5" style={{ color: "#8FA39D" }}>
                            Bases aligned on the {r.strand === "forward" ? "forward" : "reverse-complement"} strand of
                            the reference — <span style={{ color: amber }}>amber</span> = mismatch.
                          </p>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
