import React, { useEffect, useMemo, useState, useCallback } from "react";
import {
  Search,
  RefreshCw,
  FolderOpen,
  Save,
  ExternalLink,
  AlertTriangle,
  CheckCircle2,
  Info,
  AlertCircle,
  Rocket,
  HardDrive,
  Cog,
  TerminalSquare,
  FlaskConical,
  ChevronDown,
  ChevronRight,
  X,
} from "lucide-react";
import PrimerFinder from "./subapps/PrimerFinder/PrimerFinder.jsx";
import QCVectorMap from "./subapps/QCVectorMap/QCVectorMap.jsx";
import SequencingReferenceFiles from "./subapps/SequencingReferenceFiles/SequencingReferenceFiles.jsx";
import SequencingOrderForm from "./subapps/SequencingOrderForm/SequencingOrderForm.jsx";
import SequencingFileOrganizer from "./subapps/SequencingFileOrganizer/SequencingFileOrganizer.jsx";
import ColonyPCRLayout from "./subapps/ColonyPCRLayout/ColonyPCRLayout.jsx";
import LigationLayout from "./subapps/LigationLayout/LigationLayout.jsx";

// Registry of React-side subapps. When `app_information.txt` marks a section
// with `category = react_route` and `entry = <Name>.jsx`, the hub
// swaps to the matching React component instead of spawning a subprocess.
// Add new entries here as you port more subapps.
const REACT_SUBAPPS = {
  "PrimerFinder.jsx": PrimerFinder,
  "QCVectorMap.jsx": QCVectorMap,
  "SequencingReferenceFiles.jsx": SequencingReferenceFiles,
  "SequencingOrderForm.jsx": SequencingOrderForm,
  "SequencingFileOrganizer.jsx": SequencingFileOrganizer,
  "ColonyPCRLayout.jsx": ColonyPCRLayout,
  "LigationLayout.jsx": LigationLayout,
};

// ===========================================================================
// Helpers
// ===========================================================================

function displayKey(key) {
  return key.replace(/_/g, " ");
}

function statusColor(status) {
  switch (status) {
    case "success": return "text-good";
    case "warning": return "text-warn";
    case "error":   return "text-bad";
    default:        return "text-slate-400";
  }
}

// Parse the "Label, \"Sub\Path\"" format into [label, subpath] pairs.
// (Same logic as Electron's resolvePath but used for *display* of pending edits.)
function parseRawValue(raw) {
  if (!raw) return { label: null, subpath: raw || "" };
  const idx = raw.indexOf(",");
  if (idx < 0) return { label: null, subpath: raw };
  const label = raw.slice(0, idx).trim();
  let subpath = raw.slice(idx + 1).trim();
  subpath = subpath.replace(/^["']|["']$/g, "");
  return { label, subpath };
}

// ===========================================================================
// Subcomponents
// ===========================================================================

function StatusPill({ icon: Icon, label, color = "slate" }) {
  const colors = {
    slate: "bg-slate-700/40 text-slate-300 border-slate-600",
    good:  "bg-good/15 text-good border-good/40",
    warn:  "bg-warn/15 text-warn border-warn/40",
    bad:   "bg-bad/15 text-bad border-bad/40",
    info:  "bg-accent-500/15 text-accent-400 border-accent-500/40",
  };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${colors[color]}`}>
      <Icon size={12} /> {label}
    </span>
  );
}

function DirRow({ entryKey, info, driveMappings, onBrowse, onReveal, onChange }) {
  const { raw, resolved, exists } = info;
  const { label } = parseRawValue(raw);
  const mappedDrive = label ? driveMappings[label] : null;

  return (
    <div
      className={`rounded-md border px-3 py-2.5 mb-2 ${
        exists
          ? "bg-good/5 border-good/30"
          : "bg-bad/5 border-bad/40"
      }`}
    >
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-2 min-w-0">
          {exists
            ? <CheckCircle2 size={14} className="text-good shrink-0" />
            : <AlertCircle size={14} className="text-bad shrink-0" />}
          <span className="font-medium text-slate-100 truncate">{displayKey(entryKey)}</span>
          {label && (
            <span className="text-[11px] font-mono text-slate-400 shrink-0">
              via <span className="text-accent-400">{label}</span>
              {mappedDrive ? <span className="text-slate-500"> → {mappedDrive}</span> : <span className="text-bad"> (drive not found)</span>}
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <input
          value={raw}
          onChange={(e) => onChange(entryKey, e.target.value)}
          spellCheck={false}
          className="flex-1 bg-ink-900/60 border border-ink-700 rounded px-2 py-1 text-xs font-mono text-slate-200 placeholder-slate-500 focus:border-accent-500 focus:outline-none"
          placeholder='Format: Label, "Sub\\Path"'
        />
        <button
          onClick={() => onBrowse(entryKey, raw)}
          title="Browse..."
          className="px-2 py-1 rounded bg-ink-700 hover:bg-ink-600 text-slate-200 text-xs"
        >
          ...
        </button>
        {resolved && exists && (
          <button
            onClick={() => onReveal(resolved)}
            title="Reveal in Explorer"
            className="px-2 py-1 rounded bg-ink-700 hover:bg-ink-600 text-slate-200 text-xs"
          >
            <ExternalLink size={12} />
          </button>
        )}
      </div>
      {resolved && (
        <div className="mt-1 text-[11px] font-mono text-slate-500 truncate" title={resolved}>
          → {resolved}
        </div>
      )}
    </div>
  );
}

function AppCard({ app, missingKeys, onLaunch, launching }) {
  const [expanded, setExpanded] = useState(false);
  const requires = (app.requires || "").split(",").map(s => s.trim()).filter(Boolean);
  const missingReqs = requires.filter(k => missingKeys.includes(k));
  const canLaunch = missingReqs.length === 0 && !launching;

  const iconBg = app.category === "streamlit" ? "bg-warn/15 text-warn" : "bg-accent-500/15 text-accent-400";

  return (
    <div className={`rounded-lg border bg-ink-800/60 ${missingReqs.length ? "border-bad/40" : "border-ink-700"} p-3.5 mb-3`}>
      <div className="flex items-start gap-3">
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center text-lg shrink-0 ${iconBg}`}>
          {app.icon || "🔧"}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-semibold text-slate-100 truncate">{app.name}</h3>
            <span className="text-[11px] font-mono text-slate-400 shrink-0">
              v{app.version || "?"} · {app.date_released || "—"}
            </span>
          </div>
          {app.message && (
            <p className={`mt-1 text-xs ${statusColor(app.status)}`}>
              {app.message}
            </p>
          )}
          {missingReqs.length > 0 && (
            <p className="mt-1.5 text-xs text-bad font-medium">
              ⚠ Missing required directories: {missingReqs.map(displayKey).join(", ")}
            </p>
          )}
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <StatusPill
              icon={app.category === "streamlit" ? TerminalSquare : FlaskConical}
              label={app.category === "streamlit" ? "Streamlit" : "Tkinter"}
              color={app.category === "streamlit" ? "warn" : "info"}
            />
            {app.status && <StatusPill icon={Info} label={app.status} color={
              app.status === "success" ? "good" : app.status === "warning" ? "warn" : "bad"
            } />}
            <button
              onClick={() => setExpanded(e => !e)}
              className="text-[11px] text-slate-400 hover:text-slate-200 flex items-center gap-1"
            >
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              {expanded ? "Hide" : "Show"} wiring
            </button>
          </div>
        </div>
      </div>

      {expanded && (
        <div className="mt-3 ml-13 text-[11px] font-mono text-slate-400 bg-ink-900/50 rounded px-3 py-2 border border-ink-700 space-y-0.5">
          <div><span className="text-slate-500">path:</span> Code/{app.path}/{app.entry}</div>
          {app.requires && <div><span className="text-slate-500">requires:</span> {app.requires}</div>}
          {app.pass_dir_as_kwarg && <div><span className="text-slate-500">dir_args:</span> {app.pass_dir_as_kwarg}</div>}
          {app.pass_template_as_kwarg && <div><span className="text-slate-500">tpl_args:</span> {app.pass_template_as_kwarg}</div>}
          {app.pass_db_as_kwarg && <div><span className="text-slate-500">db_args:</span> {app.pass_db_as_kwarg}</div>}
        </div>
      )}

      <div className="mt-3 flex justify-end">
        <button
          disabled={!canLaunch}
          onClick={() => onLaunch(app)}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium transition-colors ${
            canLaunch
              ? "bg-accent-500 hover:bg-accent-400 text-white"
              : "bg-ink-700 text-slate-500 cursor-not-allowed"
          }`}
        >
          <Rocket size={14} />
          {launching ? "Launching..." : "Launch"}
        </button>
      </div>
    </div>
  );
}

function Toast({ toast, onClose }) {
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(onClose, 5000);
    return () => clearTimeout(t);
  }, [toast, onClose]);

  if (!toast) return null;

  const styles = {
    success: "bg-good/15 border-good/40 text-good",
    error:   "bg-bad/15 border-bad/40 text-bad",
    info:    "bg-accent-500/15 border-accent-500/40 text-accent-400",
  };

  return (
    <div className={`fixed bottom-5 right-5 max-w-md border rounded-lg px-4 py-3 shadow-lg backdrop-blur ${styles[toast.kind] || styles.info} flex items-start gap-2 z-50`}>
      <div className="flex-1 text-sm whitespace-pre-wrap">{toast.message}</div>
      <button onClick={onClose} className="text-current opacity-60 hover:opacity-100">
        <X size={14} />
      </button>
    </div>
  );
}

// ===========================================================================
// Main App
// ===========================================================================

export default function App() {
  const [driveMappings, setDriveMappings] = useState({});
  const [paths, setPaths] = useState({});             // {Key: {raw, resolved, exists}}
  const [apps, setApps] = useState([]);               // [{name, ...appInfo}]
  const [missing, setMissing] = useState([]);
  const [draftValues, setDraftValues] = useState({}); // user-edited raw values, not yet saved
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [launchingApp, setLaunchingApp] = useState(null);
  const [activeSubapp, setActiveSubapp] = useState(null); // {entry, name, initialPaths} when a React subapp is mounted
  const [layout, setLayout] = useState(null);
  const [activeTab, setActiveTab] = useState("needs"); // "needs" | "found"
  const [toast, setToast] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");

  const showToast = useCallback((message, kind = "info") => {
    setToast({ message, kind });
  }, []);

  // ---------- bootstrap ----------
  const refreshAll = useCallback(async () => {
    setScanning(true);
    try {
      const dm = await window.api.scanDrives();
      setDriveMappings(dm);
      const cfg = await window.api.loadConfig(dm);
      setPaths(cfg.paths);
      setApps(cfg.apps);
      setMissing(cfg.missing);
      setDraftValues(Object.fromEntries(Object.entries(cfg.paths).map(([k, v]) => [k, v.raw])));
      if (cfg.missing.length) setActiveTab("needs");
      else setActiveTab("found");
    } catch (err) {
      showToast(`Failed to load hub config: ${err.message}`, "error");
    } finally {
      setScanning(false);
    }
  }, [showToast]);

  useEffect(() => {
    refreshAll();
    window.api.getLayout().then(setLayout);
  }, [refreshAll]);

  // ---------- derived ----------
  const needsAttentionEntries = useMemo(() => {
    return Object.entries(paths).filter(([, info]) => !info.exists);
  }, [paths]);

  const foundEntries = useMemo(() => {
    return Object.entries(paths).filter(([, info]) => info.exists);
  }, [paths]);

  const filteredApps = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return apps;
    return apps.filter(a => a.name.toLowerCase().includes(q));
  }, [apps, searchQuery]);

  const dirty = useMemo(() => {
    return Object.entries(draftValues).some(([k, v]) => paths[k]?.raw !== v);
  }, [draftValues, paths]);

  // ---------- handlers ----------
  const handleBrowse = useCallback(async (key, raw) => {
    const isFile = /\.[A-Za-z0-9]{1,5}$/.test(raw.split(/[\\/]/).pop() || "");
    const picked = await window.api.browsePath(raw, isFile);
    if (picked) {
      setDraftValues(prev => ({ ...prev, [key]: picked }));
    }
  }, []);

  const handleReveal = useCallback((p) => {
    window.api.revealPath(p);
  }, []);

  const handleChange = useCallback((key, value) => {
    setDraftValues(prev => ({ ...prev, [key]: value }));
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      // Convert each draft to the "Label, \"sub\"" form if it's under a known drive.
      const newValues = {};
      for (const [key, rawDraft] of Object.entries(draftValues)) {
        let formatted = rawDraft;
        const norm = rawDraft.replace(/\//g, "\\");
        for (const [label, drive] of Object.entries(driveMappings)) {
          if (norm.toLowerCase().startsWith(drive.toLowerCase())) {
            let rel = norm.slice(drive.length).replace(/^\\/, "");
            formatted = `${label}, "${rel}"`;
            break;
          }
        }
        newValues[key] = formatted;
      }
      await window.api.saveConfig(newValues, driveMappings);
      showToast("Configuration updated successfully.", "success");
      await refreshAll();
    } catch (err) {
      showToast(`Save failed: ${err.message}`, "error");
    } finally {
      setSaving(false);
    }
  }, [draftValues, driveMappings, refreshAll, showToast]);

  const handleLaunch = useCallback(async (app) => {
    // React-side subapps are mounted in-process; no subprocess spawn.
    if ((app.category || "").toLowerCase() === "react_route") {
      const Component = REACT_SUBAPPS[app.entry];
      if (!Component) {
        showToast(`React subapp "${app.entry}" is not registered in REACT_SUBAPPS.`, "error");
        return;
      }
      // Resolve the kwarg paths the same way the Python hub would, so the
      // React subapp can pre-fill its UI. For Primer Finder this is just
      // Primer_Log → primer_log_path.
      const initialPaths = {};
      if (app.pass_dir_as_kwarg) {
        for (const pair of app.pass_dir_as_kwarg.split(";")) {
          const [dirKey, kwarg] = pair.split(":").map((s) => s.trim());
          const info = paths[dirKey];
          if (info?.resolved) initialPaths[kwarg] = info.resolved;
        }
      }
      setActiveSubapp({ entry: app.entry, name: app.name, initialPaths });
      return;
    }

    setLaunchingApp(app.name);
    try {
      const r = await window.api.launchApp(app, paths, driveMappings);
      if (!r.ok) {
        showToast(`Launch failed: ${r.error}`, "error");
      } else {
        showToast(`Launched ${app.name} (pid ${r.pid})`, "success");
      }
    } catch (err) {
      showToast(`Launch error: ${err.message}`, "error");
    } finally {
      setLaunchingApp(null);
    }
  }, [paths, driveMappings, showToast]);

  // ---------- render ----------
  // When a React-side subapp is active, mount it as the entire view.
  if (activeSubapp) {
    const Component = REACT_SUBAPPS[activeSubapp.entry];
    if (Component) {
      return (
        <Component
          onBack={() => setActiveSubapp(null)}
          initialPaths={activeSubapp.initialPaths}
        />
      );
    }
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-ink-700 bg-ink-900/40 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-accent-500/15 flex items-center justify-center">
            <FlaskConical size={18} className="text-accent-400" />
          </div>
          <div>
            <h1 className="font-semibold text-lg leading-tight">Gene Synthesis Hub</h1>
            <p className="text-[11px] text-slate-400 leading-tight">
              Bio Basic Inc. · {apps.length} apps · {Object.keys(driveMappings).length} drives mapped
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={refreshAll}
            disabled={scanning}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-ink-700 hover:bg-ink-600 text-slate-200 text-sm disabled:opacity-50"
          >
            <RefreshCw size={14} className={scanning ? "animate-spin" : ""} />
            {scanning ? "Scanning..." : "Rescan"}
          </button>
          {layout && (
            <button
              onClick={() => window.api.openPythonApp()}
              title="Open bundled python-app folder"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-ink-700 hover:bg-ink-600 text-slate-200 text-sm"
            >
              <FolderOpen size={14} />
              python-app
            </button>
          )}
        </div>
      </header>

      {/* Drive strip */}
      <div className="px-6 py-2 border-b border-ink-700 bg-ink-900/20 text-xs flex items-center gap-3 flex-wrap">
        <span className="text-slate-500 uppercase tracking-wider font-medium">Drives:</span>
        {Object.keys(driveMappings).length === 0 && (
          <span className="text-bad flex items-center gap-1">
            <AlertTriangle size={12} /> No drives with labels B8./B6./Public detected.
          </span>
        )}
        {Object.entries(driveMappings).map(([label, drive]) => (
          <span key={label} className="inline-flex items-center gap-1.5 font-mono text-slate-300">
            <HardDrive size={12} className="text-accent-400" />
            <span className="text-accent-400">{label}</span>
            <span className="text-slate-500">→</span>
            <span>{drive}</span>
          </span>
        ))}
      </div>

      {/* Main grid */}
      <main className="flex-1 grid grid-cols-[420px_1fr] gap-4 p-4 overflow-hidden min-h-0">
        {/* LEFT: directory editor */}
        <section className="flex flex-col bg-ink-800/40 border border-ink-700 rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-ink-700">
            <h2 className="font-semibold flex items-center gap-2">
              <Cog size={16} /> Default directories
            </h2>
            <span className="text-xs text-slate-400">
              {needsAttentionEntries.length} need attention
            </span>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-ink-700 bg-ink-900/40">
            <button
              onClick={() => setActiveTab("needs")}
              className={`flex-1 px-4 py-2 text-sm font-medium flex items-center justify-center gap-2 ${
                activeTab === "needs"
                  ? "border-b-2 border-bad text-bad"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <AlertCircle size={14} />
              Needs attention ({needsAttentionEntries.length})
            </button>
            <button
              onClick={() => setActiveTab("found")}
              className={`flex-1 px-4 py-2 text-sm font-medium flex items-center justify-center gap-2 ${
                activeTab === "found"
                  ? "border-b-2 border-good text-good"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <CheckCircle2 size={14} />
              Found ({foundEntries.length})
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-3">
            {activeTab === "needs" && (
              needsAttentionEntries.length === 0
                ? <p className="text-sm text-slate-400 text-center py-8">All directories resolved ✓</p>
                : needsAttentionEntries.map(([k, info]) => (
                    <DirRow
                      key={k}
                      entryKey={k}
                      info={{ ...info, raw: draftValues[k] ?? info.raw }}
                      driveMappings={driveMappings}
                      onBrowse={handleBrowse}
                      onReveal={handleReveal}
                      onChange={handleChange}
                    />
                  ))
            )}
            {activeTab === "found" && (
              foundEntries.length === 0
                ? <p className="text-sm text-slate-400 text-center py-8">No directories found.</p>
                : foundEntries.map(([k, info]) => (
                    <DirRow
                      key={k}
                      entryKey={k}
                      info={{ ...info, raw: draftValues[k] ?? info.raw }}
                      driveMappings={driveMappings}
                      onBrowse={handleBrowse}
                      onReveal={handleReveal}
                      onChange={handleChange}
                    />
                  ))
            )}
          </div>

          <div className="border-t border-ink-700 px-4 py-3 bg-ink-900/40 flex items-center justify-between gap-2">
            <span className="text-xs text-slate-500 truncate">
              {dirty ? "Unsaved changes" : "No pending changes"}
            </span>
            <button
              disabled={!dirty || saving}
              onClick={handleSave}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium ${
                dirty && !saving
                  ? "bg-accent-500 hover:bg-accent-400 text-white"
                  : "bg-ink-700 text-slate-500 cursor-not-allowed"
              }`}
            >
              <Save size={14} />
              {saving ? "Saving..." : "Update directories"}
            </button>
          </div>
        </section>

        {/* RIGHT: app grid */}
        <section className="flex flex-col bg-ink-800/40 border border-ink-700 rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-ink-700 gap-3">
            <h2 className="font-semibold flex items-center gap-2 shrink-0">
              <Rocket size={16} /> Available tools
            </h2>
            <div className="flex-1 max-w-xs relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search apps..."
                className="w-full pl-8 pr-3 py-1.5 rounded bg-ink-900/60 border border-ink-700 text-sm focus:border-accent-500 focus:outline-none"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            {filteredApps.length === 0 && (
              <p className="text-sm text-slate-400 text-center py-12">
                {apps.length === 0 ? "Loading apps..." : "No apps match your search."}
              </p>
            )}
            {filteredApps.map(app => (
              <AppCard
                key={app.name}
                app={app}
                missingKeys={missing}
                onLaunch={handleLaunch}
                launching={launchingApp === app.name}
              />
            ))}
          </div>
        </section>
      </main>

      {/* Footer */}
      {layout && (
        <footer className="px-6 py-1.5 border-t border-ink-700 bg-ink-900/40 text-[10px] text-slate-500 font-mono flex items-center gap-3 overflow-hidden">
          <span className="shrink-0">{layout.isPackaged ? "📦 packaged" : "🛠 dev"}</span>
          <span className="truncate" title={layout.venvPythonExe}>{layout.venvPythonExe}</span>
        </footer>
      )}

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
