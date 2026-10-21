import React, { useEffect, useMemo, useState, useCallback } from "react";
import {
  RefreshCw,
  FolderOpen,
  Save,
  ExternalLink,
  AlertTriangle,
  CheckCircle2,
  Info,
  AlertCircle,
  HardDrive,
  Cog,
  TerminalSquare,
  FlaskConical,
  Search,
  Rocket,
  LayoutGrid,
  Boxes,
  Wrench,
  ChevronDown,
  ChevronRight,
  X,
  Check,
} from "lucide-react";
import {
  C,
  AppHeader,
  Button,
  Panel,
  Pill,
  Toast,
  EmptyState,
  Tabs,
  Modal,
  FONT_DISPLAY,
  FONT_MONO,
} from "./ui/kit.jsx";
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

/** Which lifecycle stage a hub app belongs to — used to group the app grid. */
const GROUPS = [
  { id: "prep", label: "Pre-Cloning", hint: "Primers, vector maps and layouts", icon: <Wrench size={14} /> },
  { id: "cloning", label: "Cloning", hint: "Ligation, colony PCR and sequencing files", icon: <Boxes size={14} /> },
  { id: "qc", label: "QC & Reporting", hint: "QC packages, digestion design and batch reports", icon: <LayoutGrid size={14} /> },
  { id: "utility", label: "Utilities", hint: "Worklists, labels and vector logging", icon: <TerminalSquare size={14} /> },
];

const GROUP_OF = {
  "Primer Finder": "prep",
  "QC Vector Map Prep": "prep",
  "Ligation Layout": "prep",
  "Colony PCR Layout": "cloning",
  "Sequencing Reference Files": "cloning",
  "Sequencing Order Form": "cloning",
  "Sequencing File Organizer": "cloning",
  "QC File Prep": "qc",
  "QC Digestion Design": "qc",
  "BATCH QC Report": "qc",
  "Integra Worklist": "utility",
  "Label Generator": "utility",
  "Backup Vector Logger": "utility",
};

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

function DriveStrip({ driveMappings }) {
  const entries = Object.entries(driveMappings);
  return (
    <div
      className="flex items-center gap-3 flex-wrap px-6 py-2"
      style={{ borderBottom: "1px solid " + C.border, background: C.subtle2 }}
    >
      <span
        className="text-[10px] uppercase tracking-wider font-semibold"
        style={{ color: C.inkFaint }}
      >
        Drives
      </span>
      {entries.length === 0 ? (
        <span className="text-xs flex items-center gap-1" style={{ color: C.coral }}>
          <AlertTriangle size={12} /> No drives with labels B8. / B6. / Public detected.
        </span>
      ) : (
        entries.map(([label, drive]) => (
          <span
            key={label}
            className="inline-flex items-center gap-1.5 text-xs"
            style={{ fontFamily: FONT_MONO }}
          >
            <HardDrive size={12} style={{ color: C.teal }} />
            <span style={{ color: C.tealDeep }}>{label}</span>
            <span style={{ color: C.inkFaint }}>→</span>
            <span style={{ color: C.inkMuted }}>{drive}</span>
          </span>
        ))
      )}
    </div>
  );
}

function DirRow({ entryKey, info, driveMappings, onBrowse, onReveal, onChange }) {
  const { raw, resolved, exists } = info;
  const { label } = parseRawValue(raw);
  const mappedDrive = label ? driveMappings[label] : null;

  return (
    <div
      className="rounded-md border px-3 py-2.5 mb-2"
      style={{
        background: exists ? "#FBFDFC" : C.coralSoft,
        borderColor: exists ? C.border : "rgba(193,85,61,0.40)",
      }}
    >
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-2 min-w-0">
          {exists ? (
            <CheckCircle2 size={14} style={{ color: C.teal }} className="shrink-0" />
          ) : (
            <AlertCircle size={14} style={{ color: C.coral }} className="shrink-0" />
          )}
          <span className="font-medium text-sm truncate" style={{ color: C.ink }}>
            {displayKey(entryKey)}
          </span>
          {label && (
            <span className="text-[11px] truncate" style={{ fontFamily: FONT_MONO, color: C.inkFaint }}>
              via <span style={{ color: C.tealDeep }}>{label}</span>
              {mappedDrive ? (
                <span> → {mappedDrive}</span>
              ) : (
                <span style={{ color: C.coral }}> (drive not found)</span>
              )}
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <input
          value={raw}
          onChange={(e) => onChange(entryKey, e.target.value)}
          spellCheck={false}
          className="flex-1 px-2 py-1 text-xs outline-none rounded"
          style={{
            background: C.surface,
            border: "1px solid " + C.border,
            borderRadius: 6,
            color: C.ink,
            fontFamily: FONT_MONO,
            userSelect: "text",
          }}
          placeholder='Format: Label, "Sub\\Path"'
        />
        <Button variant="secondary" size="sm" onClick={() => onBrowse(entryKey, raw)}>
          Browse…
        </Button>
        {resolved && exists && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onReveal(resolved)}
            title="Reveal in Explorer"
          >
            <ExternalLink size={12} />
          </Button>
        )}
      </div>
      {resolved && (
        <div
          className="mt-1 text-[11px] truncate"
          style={{ fontFamily: FONT_MONO, color: C.inkFaint }}
          title={resolved}
        >
          → {resolved}
        </div>
      )}
    </div>
  );
}

function AppCard({ app, missingKeys, onLaunch, launching }) {
  const [expanded, setExpanded] = useState(false);
  const requires = (app.requires || "").split(",").map((s) => s.trim()).filter(Boolean);
  const missingReqs = requires.filter((k) => missingKeys.includes(k));
  const canLaunch = missingReqs.length === 0 && !launching;
  const isReact = (app.category || "").toLowerCase() === "react_route";

  return (
    <div
      className="rounded-lg border p-3.5"
      style={{
        background: C.surface,
        borderColor: missingReqs.length ? "rgba(193,85,61,0.40)" : C.border,
      }}
    >
      <div className="flex items-start gap-3">
        <div
          className="w-9 h-9 rounded-md flex items-center justify-center text-base shrink-0"
          style={{ background: isReact ? C.tealSoft : C.navySoft }}
          title={isReact ? "Runs in-process (React)" : "Runs as a Python app"}
        >
          {app.icon || "🔧"}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <h3
              className="font-semibold text-sm truncate"
              style={{ fontFamily: FONT_DISPLAY, color: C.ink }}
            >
              {app.name}
            </h3>
            <span className="text-[11px] shrink-0" style={{ fontFamily: FONT_MONO, color: C.inkFaint }}>
              v{app.version || "?"} · {app.date_released || "—"}
            </span>
          </div>
          {app.message && (
            <p className="mt-1 text-xs leading-snug" style={{ color: C.inkMuted }}>
              {app.message}
            </p>
          )}
          {missingReqs.length > 0 && (
            <p className="mt-1.5 text-xs font-medium" style={{ color: C.coral }}>
              Missing required directories: {missingReqs.map(displayKey).join(", ")}
            </p>
          )}
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <Pill
              tone={isReact ? "good" : "info"}
              icon={isReact ? <Rocket size={11} /> : <TerminalSquare size={11} />}
            >
              {isReact ? "Built-in" : "Python app"}
            </Pill>
            {app.status && (
              <Pill
                tone={app.status === "success" ? "good" : app.status === "warning" ? "warn" : "bad"}
                icon={<Info size={11} />}
              >
                {app.status}
              </Pill>
            )}
            <button
              onClick={() => setExpanded((e) => !e)}
              className="text-[11px] inline-flex items-center gap-1"
              style={{ color: C.inkMuted }}
            >
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              {expanded ? "Hide" : "Show"} wiring
            </button>
          </div>
        </div>
      </div>

      {expanded && (
        <div
          className="mt-3 ml-12 text-[11px] rounded px-3 py-2 space-y-0.5"
          style={{
            fontFamily: FONT_MONO,
            color: C.inkMuted,
            background: C.subtle,
            border: "1px solid " + C.border,
          }}
        >
          <div>
            <span style={{ color: C.inkFaint }}>path:</span> Code/{app.path}/{app.entry}
          </div>
          {app.requires && (
            <div>
              <span style={{ color: C.inkFaint }}>requires:</span> {app.requires}
            </div>
          )}
          {app.pass_dir_as_kwarg && (
            <div>
              <span style={{ color: C.inkFaint }}>dir_args:</span> {app.pass_dir_as_kwarg}
            </div>
          )}
          {app.pass_template_as_kwarg && (
            <div>
              <span style={{ color: C.inkFaint }}>tpl_args:</span> {app.pass_template_as_kwarg}
            </div>
          )}
          {app.pass_db_as_kwarg && (
            <div>
              <span style={{ color: C.inkFaint }}>db_args:</span> {app.pass_db_as_kwarg}
            </div>
          )}
        </div>
      )}

      <div className="mt-3 flex justify-end">
        <Button
          variant={canLaunch ? "primary" : "secondary"}
          size="sm"
          disabled={!canLaunch}
          onClick={() => onLaunch(app)}
        >
          <Rocket size={13} />
          {launching ? "Launching…" : "Launch"}
        </Button>
      </div>
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
  const [settingsOpen, setSettingsOpen] = useState(false);

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
    return apps.filter((a) => a.name.toLowerCase().includes(q));
  }, [apps, searchQuery]);

  const groupedApps = useMemo(() => {
    const byGroup = new Map(GROUPS.map((g) => [g.id, []]));
    const other = [];
    for (const app of filteredApps) {
      const gid = GROUP_OF[app.name];
      if (gid && byGroup.has(gid)) byGroup.get(gid).push(app);
      else other.push(app);
    }
    return { byGroup, other };
  }, [filteredApps]);

  const dirty = useMemo(() => {
    return Object.entries(draftValues).some(([k, v]) => paths[k]?.raw !== v);
  }, [draftValues, paths]);

  // ---------- handlers ----------
  const handleBrowse = useCallback(async (key, raw) => {
    const isFile = /\.[A-Za-z0-9]{1,5}$/.test(raw.split(/[\\/]/).pop() || "");
    const picked = await window.api.browsePath(raw, isFile);
    if (picked) {
      setDraftValues((prev) => ({ ...prev, [key]: picked }));
    }
  }, []);

  const handleReveal = useCallback((p) => {
    window.api.revealPath(p);
  }, []);

  const handleChange = useCallback((key, value) => {
    setDraftValues((prev) => ({ ...prev, [key]: value }));
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

  const handleLaunch = useCallback(
    async (app) => {
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
        // Template / database patterns travel as patterns; the subapp asks
        // the main process to resolve the newest match in the bundled tree.
        const patternMap = (spec) =>
          spec
            ? Object.fromEntries(
                spec.split(";").map((pair) => {
                  const [kwarg, pattern] = pair.split(":").map((s) => s.trim());
                  return [kwarg, pattern];
                })
              )
            : {};
        const templatePatterns = patternMap(app.pass_template_as_kwarg);
        const dbPatterns = patternMap(app.pass_db_as_kwarg);

        // Resolve the bundled templates/databases NOW so the subapp gets an
        // absolute path in `initialPaths` and can pre-fill its fields.
        //
        // The Python hub resolves these kwargs before it constructs the
        // app (the Colony PCR app receives `colony_pcr_template_path` and
        // the Sequencing Order Form receives `empty_form_path` +
        // `seq_layout_path`). The React route used to leave them
        // unresolved, so those fields stayed EMPTY and the app could not
        // run without the user hunting for the file by hand.
        // The main process returns { templates: { kwarg: absPath },
        // databases: { kwarg: absPath } }.
        const bundled = await window.api.resolveBundledFiles({
          templates: Object.entries(templatePatterns).map(([kwarg, pattern]) => `${kwarg}:${pattern}`),
          databases: Object.entries(dbPatterns).map(([kwarg, pattern]) => `${kwarg}:${pattern}`),
        });
        for (const bucket of ["templates", "databases"]) {
          const resolved = bundled?.[bucket] || {};
          for (const [kwarg, absPath] of Object.entries(resolved)) {
            if (absPath) initialPaths[kwarg] = absPath;
          }
        }

        setActiveSubapp({
          entry: app.entry,
          name: app.name,
          initialPaths,
          templatePatterns,
          dbPatterns,
        });
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
    },
    [paths, driveMappings, showToast]
  );

  // ---------- render ----------
  // When a React-side subapp is active, mount it as the entire view.
  if (activeSubapp) {
    const Component = REACT_SUBAPPS[activeSubapp.entry];
    if (Component) {
      return (
        <Component
          onBack={() => setActiveSubapp(null)}
          initialPaths={activeSubapp.initialPaths}
          templatePatterns={activeSubapp.templatePatterns}
          dbPatterns={activeSubapp.dbPatterns}
        />
      );
    }
  }

  return (
    <div className="h-full flex flex-col" style={{ background: C.paper, color: C.ink }}>
      {/* Header */}
      <AppHeader
        icon={<FlaskConical size={18} color="#fff" />}
        title="Gene Synthesis Hub"
        subtitle="Bio Basic Inc."
        meta={`${apps.length} apps · ${Object.keys(driveMappings).length} drives mapped`}
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setSettingsOpen(true)}
              title="Default directories"
            >
              <Cog size={14} /> Directories
            </Button>
            {layout && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => window.api.openPythonApp()}
                title="Open bundled python-app folder"
              >
                <FolderOpen size={14} /> python-app
              </Button>
            )}
            <Button variant="primary" size="sm" onClick={refreshAll} disabled={scanning}>
              <RefreshCw size={14} className={scanning ? "animate-spin" : ""} />
              {scanning ? "Scanning…" : "Rescan"}
            </Button>
          </>
        }
      />

      <DriveStrip driveMappings={driveMappings} />

      {/* Main grid */}
      <main className="flex-1 grid grid-cols-1 gap-4 p-4 overflow-hidden min-h-0">
        {/* App grid */}
        <section
          className="flex flex-col rounded-lg overflow-hidden"
          style={{ background: C.surface, border: "1px solid " + C.border }}
        >
          <div
            className="flex items-center justify-between gap-3 px-4 py-3"
            style={{ borderBottom: "1px solid " + C.border, background: C.subtle2 }}
          >
            <h2
              className="font-semibold flex items-center gap-2 shrink-0"
              style={{ fontFamily: FONT_DISPLAY, fontSize: 14, color: C.ink }}
            >
              <Rocket size={15} style={{ color: C.teal }} /> Available tools
            </h2>
            <div className="flex items-center gap-2">
              <div className="relative" style={{ width: 240 }}>
                <Search
                  size={14}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2"
                  style={{ color: C.inkFaint }}
                />
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search apps…"
                  className="w-full pl-8 pr-3 py-1.5 rounded text-sm outline-none"
                  style={{
                    background: C.surface,
                    border: "1px solid " + C.border,
                    borderRadius: 6,
                    color: C.ink,
                    fontFamily: "IBM Plex Sans, sans-serif",
                    fontSize: 13,
                  }}
                />
              </div>
              {missing.length > 0 && (
                <Pill tone="warn" icon={<AlertTriangle size={11} />}>
                  {missing.length} path{missing.length === 1 ? "" : "s"} unresolved
                </Pill>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {filteredApps.length === 0 ? (
              <EmptyState
                icon={<Search size={28} />}
                title={apps.length === 0 ? "Loading apps…" : "No apps match your search."}
                hint={
                  apps.length === 0
                    ? "Reading app_information.txt from the bundled python-app folder."
                    : "Try a different name."
                }
              />
            ) : (
              <div className="space-y-5">
                {GROUPS.map((g) => {
                  const list = groupedApps.byGroup.get(g.id) || [];
                  if (list.length === 0) return null;
                  return (
                    <div key={g.id}>
                      <div className="flex items-center gap-2 mb-2">
                        <span style={{ color: C.teal }}>{g.icon}</span>
                        <h3
                          className="text-xs font-semibold uppercase tracking-wider"
                          style={{ color: C.inkMuted }}
                        >
                          {g.label}
                        </h3>
                        <span
                          className="px-1.5 py-0.5 rounded-full text-[10px]"
                          style={{ background: C.subtle, color: C.inkFaint }}
                        >
                          {list.length}
                        </span>
                        <span className="text-[11px] truncate" style={{ color: C.inkFaint }}>
                          {g.hint}
                        </span>
                      </div>
                      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                        {list.map((app) => (
                          <AppCard
                            key={app.name}
                            app={app}
                            missingKeys={missing}
                            onLaunch={handleLaunch}
                            launching={launchingApp === app.name}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
                {groupedApps.other.length > 0 && (
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <h3
                        className="text-xs font-semibold uppercase tracking-wider"
                        style={{ color: C.inkMuted }}
                      >
                        Other
                      </h3>
                      <span
                        className="px-1.5 py-0.5 rounded-full text-[10px]"
                        style={{ background: C.subtle, color: C.inkFaint }}
                      >
                        {groupedApps.other.length}
                      </span>
                    </div>
                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                      {groupedApps.other.map((app) => (
                        <AppCard
                          key={app.name}
                          app={app}
                          missingKeys={missing}
                          onLaunch={handleLaunch}
                          launching={launchingApp === app.name}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      </main>

      {/* Footer */}
      {layout && (
        <footer
          className="px-6 py-1.5 text-[10px] flex items-center gap-3 overflow-hidden"
          style={{
            borderTop: "1px solid " + C.border,
            background: C.subtle2,
            color: C.inkFaint,
            fontFamily: FONT_MONO,
          }}
        >
          <span className="shrink-0">{layout.isPackaged ? "packaged" : "dev"}</span>
          <span className="truncate" title={layout.venvPythonExe}>
            {layout.venvPythonExe}
          </span>
        </footer>
      )}

      {/* Directories modal */}
      <Modal
        open={settingsOpen}
        title="Default directories"
        subtitle="Paths resolve against the drive labels detected on this machine."
        onCancel={() => setSettingsOpen(false)}
        width={760}
        footer={
          <>
            <span className="mr-auto text-xs" style={{ color: dirty ? C.amber : C.inkFaint }}>
              {dirty ? "Unsaved changes" : "No pending changes"}
            </span>
            <Button variant="secondary" onClick={() => setSettingsOpen(false)}>
              Close
            </Button>
            <Button variant="primary" disabled={!dirty || saving} onClick={handleSave}>
              <Save size={14} />
              {saving ? "Saving…" : "Update directories"}
            </Button>
          </>
        }
      >
        <Tabs
          tabs={[
            { id: "needs", label: "Needs attention", count: needsAttentionEntries.length },
            { id: "found", label: "Found", count: foundEntries.length },
          ]}
          active={activeTab}
          onChange={setActiveTab}
        />
        <div className="pt-3">
          {activeTab === "needs" &&
            (needsAttentionEntries.length === 0 ? (
              <EmptyState
                icon={<Check size={24} style={{ color: C.teal }} />}
                title="All directories resolved ✓"
                hint="Every configured path was found on this machine."
              />
            ) : (
              needsAttentionEntries.map(([k, info]) => (
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
            ))}
          {activeTab === "found" &&
            (foundEntries.length === 0 ? (
              <EmptyState icon={<FolderOpen size={24} />} title="No directories found." />
            ) : (
              foundEntries.map(([k, info]) => (
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
            ))}
        </div>
      </Modal>

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
