import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Beaker,
  CheckCircle2,
  AlertCircle,
  FileSpreadsheet,
  Search,
  Download,
  Dna,
} from "lucide-react";
import {
  cleanSequence,
  reverseComplement,
  findBinding,
  isValidPrimer,
} from "./sequenceUtils.js";
import { loadPrimerCandidatesFromFile } from "./excelReader.js";
import {
  C,
  AppHeader,
  Button,
  Panel,
  Field,
  TextArea,
  TextInput,
  Pill,
  StatusLine,
  LogPanel,
  Spinner,
  StepHeading,
  EmptyState,
  DataTable,
  FONT_MONO,
} from "../../ui/kit.jsx";

/**
 * Primer Finder — React port of `primer_finder_app.py`.
 *
 * Functional parity with the Tkinter version:
 *   - Paste a target DNA sequence (ACGT/N).
 *   - Pick a Primer Log .xlsx.
 *   - Click "Find Binding Primers" → scans S/T/U/V sheets, resolving the
 *     Name + Sequence columns per sheet (row 34 header, name-first with
 *     an A:B fallback), rows 35-100 of each sheet, finds forward +
 *     reverse-complement matches.
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
  // Per-sheet column-resolution report (which path fired for each sheet).
  const [resolutionLines, setResolutionLines] = useState([]);

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
    setResolutionLines([]);
    // Try to load it as Excel to validate.
    try {
      const { logs } = await loadPrimerCandidatesFromFile(file);
      setPrimerFileValid(true);
      setResolutionLines(logs || []);
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
      const { candidates, sheetsScanned, logs } = await loadPrimerCandidatesFromFile(primerFile);
      if (logs?.length) setResolutionLines(logs);
      if (candidates.length === 0) {
        // The Python distinguishes "no S/T/U/V sheet at all" from
        // "sheets present, but no valid primers inside them":
        //   no sheets      -> "No sheets found starting with S, T, U, or V."
        //   sheets, no hits -> "No valid primers found in S/T/U/V sheets."
        if (sheetsScanned.length === 0) {
          setStatus({
            text: "No sheets found starting with S, T, U, or V.",
            color: "warn",
          });
        } else {
          setStatus({ text: "No valid primers found in S/T/U/V sheets.", color: "warn" });
        }
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
  const columns = useMemo(
    () => [
      {
        key: "sheet",
        label: "Sheet",
        render: (r) => (
          <span style={{ color: C.tealDeep, fontFamily: FONT_MONO }}>{r.sheet}</span>
        ),
      },
      {
        key: "name",
        label: "Primer Name",
        render: (r) => (
          <span style={{ fontFamily: FONT_MONO }}>{r.name}</span>
        ),
      },
      {
        key: "orientation",
        label: "Orientation",
        render: (r) => (
          <Pill tone={r.orientation.startsWith("Forward") ? "good" : "warn"}>
            {r.orientation}
          </Pill>
        ),
      },
      {
        key: "position",
        label: "Position",
        align: "right",
        render: (r) => (
          <span style={{ fontFamily: FONT_MONO, textAlign: "right" }}>{r.position}</span>
        ),
      },
      {
        key: "sequence",
        label: "Sequence",
        render: (r) => (
          <span style={{ fontFamily: FONT_MONO, wordBreak: "break-all" }}>{r.sequence}</span>
        ),
      },
    ],
    []
  );

  return (
    <div className="h-full flex flex-col" style={{ background: C.paper, color: C.ink }}>
      <AppHeader
        onBack={onBack}
        icon={<Dna size={18} color="#fff" />}
        title="Primer Finder"
        subtitle="Forward + reverse-complement binding search across the Primer Log"
      />

      <main className="flex-1 overflow-y-auto p-6">
        <div className="max-w-5xl mx-auto space-y-5">
          {/* Target sequence */}
          <Panel
            icon={<Beaker size={15} style={{ color: C.teal }} />}
            title="Target DNA sequence"
            subtitle="Non-DNA characters are stripped automatically"
            actions={
              <>
                <Pill tone={cleanedLen > 0 ? "good" : "neutral"}>
                  {cleanedLen} bp valid
                </Pill>
                {invalidChars > 0 && (
                  <Pill tone="warn">
                    {invalidChars} stripped
                  </Pill>
                )}
              </>
            }
          >
            <TextArea
              value={targetSeq}
              onChange={(e) => setTargetSeq(e.target.value)}
              rows={5}
              mono
              spellCheck={false}
              placeholder="Paste the target sequence here (A/T/C/G/N)…"
            />
          </Panel>

          {/* Primer log file */}
          <Panel
            icon={<FileSpreadsheet size={15} style={{ color: C.teal }} />}
            title="Primer Log"
            subtitle="Order sheets S/T/U/V are scanned"
          >
            <div className="flex items-center gap-2">
              <TextInput
                value={primerFileName}
                readOnly
                mono
                placeholder="No file selected"
                style={{ flex: 1 }}
              />
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={(e) => handleFile(e.target.files?.[0])}
              />
              <Button variant="primary" onClick={() => fileInputRef.current?.click()}>
                Select…
              </Button>
            </div>
            {primerFile && (
              <div className="mt-2">
                {primerFileValid ? (
                  <Pill tone="good" icon={<CheckCircle2 size={11} />}>
                    Valid Excel file
                  </Pill>
                ) : (
                  <Pill tone="bad" icon={<AlertCircle size={11} />}>
                    {primerFileError || "Invalid file"}
                  </Pill>
                )}
              </div>
            )}
          </Panel>

          {/* Column-resolution log — which path fired for each order sheet. */}
          {resolutionLines.length > 0 && (
            <LogPanel
              logs={resolutionLines}
              title="Column resolution"
              empty=""
              maxHeight={160}
            />
          )}

          {/* Action */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1 min-w-0">
              <StatusLine status={status} running={running} />
              {running && (
                <div
                  className="mt-2 h-1.5 rounded-full overflow-hidden"
                  style={{ background: C.border }}
                >
                  <div
                    className="h-full transition-all"
                    style={{ width: `${Math.round(progress * 100)}%`, background: C.teal }}
                  />
                </div>
              )}
            </div>
            <Button
              variant="primary"
              size="lg"
              disabled={!canAnalyze}
              onClick={runAnalysis}
            >
              <Search size={15} />
              {running ? "Searching…" : "Find Binding Primers"}
            </Button>
          </div>

          {/* Results */}
          <Panel
            title="Matching Primers"
            subtitle={`${results.length} result${results.length === 1 ? "" : "s"}`}
            actions={
              <Button
                variant="secondary"
                size="sm"
                disabled={results.length === 0}
                onClick={exportCsv}
              >
                <Download size={13} /> Export CSV
              </Button>
            }
          >
            {results.length === 0 ? (
              <EmptyState
                icon={<Search size={26} />}
                title="No results yet"
                hint="Enter a target sequence and pick a Primer Log, then click “Find Binding Primers”."
              />
            ) : (
              <DataTable
                columns={columns}
                rows={results}
                maxHeight="50vh"
              />
            )}
          </Panel>
        </div>
      </main>
    </div>
  );
}
