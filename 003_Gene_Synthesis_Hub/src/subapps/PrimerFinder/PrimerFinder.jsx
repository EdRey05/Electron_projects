import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Beaker,
  CheckCircle2,
  AlertCircle,
  Loader2,
  FileSpreadsheet,
  Search,
  Download,
} from "lucide-react";
import {
  cleanSequence,
  reverseComplement,
  findBinding,
  isValidPrimer,
} from "./sequenceUtils.js";
import { loadPrimerCandidatesFromFile } from "./excelReader.js";

/**
 * Primer Finder — React port of `primer_finder_app.py`.
 *
 * Functional parity with the Tkinter version:
 *   - Paste a target DNA sequence (ACGT/N).
 *   - Pick a Primer Log .xlsx.
 *   - Click "Find Binding Primers" → scans S/T/U/V sheets, columns A:B,
 *     rows 35-100 of each sheet, finds forward + reverse-complement matches.
 *   - Results table with sheet, primer name, orientation, position, sequence.
 *   - Export results to .csv via Electron save dialog.
 *
 * Differences from the Tkinter version:
 *   - No thread/threading complexity: we use async/await + a small chunked
 *     loop (yield to the event loop between candidate batches) so the UI
 *     stays responsive.
 *   - Validation is synchronous and inline (no background thread needed for
 *     a single file pick).
 *   - The Analyze button is disabled until both the sequence and the
 *     primer file are present + the file parses as a valid Excel.
 */
export default function PrimerFinder({ onBack, initialPaths }) {
  const [targetSeq, setTargetSeq] = useState("");
  const [cleanedSeq, setCleanedSeq] = useState("");
  const [primerFile, setPrimerFile] = useState(null);       // File object from <input>
  const [primerFileName, setPrimerFileName] = useState("");
  const [primerFileValid, setPrimerFileValid] = useState(false);
  const [primerFileError, setPrimerFileError] = useState("");

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState({ text: "Ready", color: "info" });
  const [results, setResults] = useState([]);

  const fileInputRef = useRef(null);

  // Clean the sequence live so the user sees valid chars highlighted.
  useEffect(() => {
    setCleanedSeq(cleanSequence(targetSeq));
  }, [targetSeq]);

  // When the hub pre-fills a primer log path, attempt to fetch it via the
  // Electron preload's `readHubFile` API (or skip — we still need a File
  // object from the OS file picker). For now: just remember the path so
  // the UI can show it; the user can confirm by clicking "Select file".
  useEffect(() => {
    if (initialPaths?.primer_log_path) {
      setPrimerFileName(initialPaths.primer_log_path);
    }
  }, [initialPaths]);

  const cleanedLen = cleanedSeq.length;
  const rawLen = (targetSeq || "").length;
  const invalidChars = rawLen - cleanedLen;

  const canAnalyze = cleanedLen > 0 && primerFileValid && !running;

  // ------------------------------------------------------------
  // File picker
  // ------------------------------------------------------------
  const handleFile = async (file) => {
    if (!file) return;
    setPrimerFile(file);
    setPrimerFileName(file.name);
    setPrimerFileValid(false);
    setPrimerFileError("");
    // Try to load it as Excel to validate.
    try {
      await loadPrimerCandidatesFromFile(file);
      setPrimerFileValid(true);
    } catch (err) {
      setPrimerFileValid(false);
      setPrimerFileError(err?.message || "Failed to read Excel file");
    }
  };

  // ------------------------------------------------------------
  // Run analysis
  // ------------------------------------------------------------
  const runAnalysis = async () => {
    if (!canAnalyze) return;
    setRunning(true);
    setResults([]);
    setProgress(0);
    setStatus({ text: "Loading primer database...", color: "info" });

    try {
      const { candidates, sheetsScanned } = await loadPrimerCandidatesFromFile(primerFile);
      if (candidates.length === 0) {
        setStatus({ text: "No valid primers found in S/T/U/V sheets.", color: "warn" });
        setRunning(false);
        return;
      }
      setStatus({
        text: `Scanning ${candidates.length} primers across ${sheetsScanned.length} sheets...`,
        color: "info",
      });

      const targetRc = reverseComplement(cleanedSeq);
      const matches = [];
      const chunk = 200;
      for (let i = 0; i < candidates.length; i += chunk) {
        const slice = candidates.slice(i, i + chunk);
        for (const c of slice) {
          const hit = findBinding(c.sequence, cleanedSeq, targetRc);
          if (hit) {
            matches.push({
              sheet: c.sheet,
              name: c.name,
              orientation: hit.orientation,
              position: hit.position,
              sequence: c.sequence,
            });
          }
        }
        setProgress((i + slice.length) / candidates.length);
        // Yield to the event loop so the UI updates between chunks.
        await new Promise((r) => setTimeout(r, 0));
      }

      setResults(matches);
      setProgress(1);
      setStatus({
        text: `Done! Found ${matches.length} matching primer${matches.length === 1 ? "" : "s"}.`,
        color: matches.length > 0 ? "good" : "warn",
      });
    } catch (err) {
      setStatus({ text: `Error: ${err.message}`, color: "bad" });
    } finally {
      setRunning(false);
    }
  };

  // ------------------------------------------------------------
  // Export results as CSV
  // ------------------------------------------------------------
  const exportCsv = async () => {
    if (results.length === 0) return;
    const header = "Sheet,Primer Name,Orientation,Position,Sequence\n";
    const body = results
      .map((r) =>
        [r.sheet, r.name, r.orientation, r.position, r.sequence]
          .map((v) => {
            const s = String(v ?? "");
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
          })
          .join(",")
      )
      .join("\n");
    const csv = header + body + "\n";

    // Try Electron save dialog (preload exposes window.api.saveResultsCsv).
    if (window.api?.saveResultsCsv) {
      const ok = await window.api.saveResultsCsv(
        "primer_finder_results.csv",
        new TextEncoder().encode(csv).buffer
      );
      if (ok) return;
    }
    // Fallback: browser download.
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "primer_finder_results.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // ------------------------------------------------------------
  // Render
  // ------------------------------------------------------------
  const statusColors = {
    info: "text-accent-400",
    good: "text-good",
    warn: "text-warn",
    bad:  "text-bad",
  };

  return (
    <div className="h-full flex flex-col bg-ink-900 text-slate-100">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-ink-700 bg-ink-800/60">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-ink-700 hover:bg-ink-600 text-slate-200 text-sm"
            title="Back to hub"
          >
            <ArrowLeft size={14} /> Hub
          </button>
          <div className="w-9 h-9 rounded-lg bg-accent-500/15 flex items-center justify-center">
            <Search size={18} className="text-accent-400" />
          </div>
          <div>
            <h1 className="font-semibold text-lg leading-tight">Primer Finder</h1>
            <p className="text-[11px] text-slate-400 leading-tight">
              Forward + reverse-complement binding search across the Primer Log
            </p>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-6 space-y-5">
        {/* Target sequence */}
        <section className="bg-ink-800/40 border border-ink-700 rounded-lg p-4">
          <h2 className="font-semibold mb-2 flex items-center gap-2">
            <Beaker size={16} className="text-accent-400" /> Target DNA sequence
          </h2>
          <textarea
            value={targetSeq}
            onChange={(e) => setTargetSeq(e.target.value)}
            spellCheck={false}
            placeholder="Paste the target sequence here (A/T/C/G/N). Non-DNA chars will be stripped automatically."
            className="w-full h-28 px-3 py-2 rounded bg-ink-900/60 border border-ink-700 text-sm font-mono focus:border-accent-500 focus:outline-none resize-y"
          />
          <div className="mt-2 flex items-center gap-4 text-xs text-slate-400">
            <span>
              <span className="text-slate-500">Cleaned:</span>{" "}
              <span className="font-mono text-accent-400">{cleanedLen} bp</span>
            </span>
            {invalidChars > 0 && (
              <span className="text-warn">
                {invalidChars} non-DNA character{invalidChars === 1 ? "" : "s"} stripped
              </span>
            )}
          </div>
        </section>

        {/* Primer log file */}
        <section className="bg-ink-800/40 border border-ink-700 rounded-lg p-4">
          <h2 className="font-semibold mb-2 flex items-center gap-2">
            <FileSpreadsheet size={16} className="text-accent-400" /> Primer Log
          </h2>
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={primerFileName}
              placeholder="No file selected"
              className="flex-1 px-3 py-2 rounded bg-ink-900/60 border border-ink-700 text-sm font-mono text-slate-300"
            />
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              onChange={(e) => handleFile(e.target.files?.[0])}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="px-3 py-2 rounded bg-ink-700 hover:bg-ink-600 text-sm"
            >
              Select...
            </button>
          </div>
          {primerFile && (
            <div className="mt-2 text-xs">
              {primerFileValid ? (
                <span className="text-good flex items-center gap-1">
                  <CheckCircle2 size={12} /> Valid Excel file
                </span>
              ) : (
                <span className="text-bad flex items-center gap-1">
                  <AlertCircle size={12} /> {primerFileError || "Invalid file"}
                </span>
              )}
            </div>
          )}
        </section>

        {/* Action */}
        <section className="flex items-center justify-between gap-4">
          <div className="flex-1">
            <div className={`text-sm font-medium ${statusColors[status.color]}`}>
              {running && <Loader2 size={14} className="inline animate-spin mr-1" />}
              {status.text}
            </div>
            {running && (
              <div className="mt-2 h-1.5 bg-ink-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent-500 transition-all"
                  style={{ width: `${Math.round(progress * 100)}%` }}
                />
              </div>
            )}
          </div>
          <button
            disabled={!canAnalyze}
            onClick={runAnalysis}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded font-medium ${
              canAnalyze
                ? "bg-good hover:bg-good/90 text-white"
                : "bg-ink-700 text-slate-500 cursor-not-allowed"
            }`}
          >
            <Search size={14} />
            {running ? "Searching..." : "Find Binding Primers"}
          </button>
        </section>

        {/* Results */}
        <section className="bg-ink-800/40 border border-ink-700 rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-ink-700">
            <h2 className="font-semibold">
              Matching Primers
              <span className="ml-2 text-xs text-slate-400 font-normal">
                ({results.length} result{results.length === 1 ? "" : "s"})
              </span>
            </h2>
            <button
              disabled={results.length === 0}
              onClick={exportCsv}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs ${
                results.length === 0
                  ? "bg-ink-700 text-slate-500 cursor-not-allowed"
                  : "bg-accent-500 hover:bg-accent-400 text-white"
              }`}
            >
              <Download size={12} /> Export CSV
            </button>
          </div>

          {results.length === 0 ? (
            <div className="p-12 text-center text-sm text-slate-400">
              No results yet — enter a target sequence and pick a Primer Log, then click "Find Binding Primers".
            </div>
          ) : (
            <div className="overflow-x-auto max-h-[50vh] overflow-y-auto">
              <table className="w-full text-xs font-mono">
                <thead className="bg-ink-900/60 sticky top-0">
                  <tr className="text-left text-slate-300">
                    <th className="px-3 py-2 font-medium">Sheet</th>
                    <th className="px-3 py-2 font-medium">Primer Name</th>
                    <th className="px-3 py-2 font-medium">Orientation</th>
                    <th className="px-3 py-2 font-medium text-right">Pos</th>
                    <th className="px-3 py-2 font-medium">Sequence</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r, i) => (
                    <tr
                      key={`${r.sheet}-${r.name}-${i}`}
                      className={`border-t border-ink-700 hover:bg-ink-700/30 ${
                        i % 2 === 0 ? "bg-ink-900/20" : ""
                      }`}
                    >
                      <td className="px-3 py-1.5 text-accent-400">{r.sheet}</td>
                      <td className="px-3 py-1.5 text-slate-200">{r.name}</td>
                      <td className="px-3 py-1.5">
                        <span
                          className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${
                            r.orientation.startsWith("Forward")
                              ? "bg-good/15 text-good"
                              : "bg-warn/15 text-warn"
                          }`}
                        >
                          {r.orientation}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-right text-slate-300">{r.position}</td>
                      <td className="px-3 py-1.5 text-slate-200 break-all">{r.sequence}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
