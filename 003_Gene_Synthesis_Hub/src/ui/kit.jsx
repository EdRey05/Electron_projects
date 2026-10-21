/**
 * Shared UI kit for the Gene Synthesis Hub.
 *
 * Design language mirrors the Sequence Binding Finder (002) and Peak Tracer
 * (004) Electron apps so all four apps in the repo read as one family:
 *
 *   - paper background, white surfaces, hairline borders
 *   - navy (#1F3A5F) as the structural / primary-action colour
 *   - teal (#0E7C7B) as the accent / positive colour
 *   - amber + coral for warnings and failures
 *   - Space Grotesk for display, IBM Plex Sans for body, IBM Plex Mono for
 *     paths, IDs and log output
 *
 * Everything is plain React + inline styles driven by the palette below, so
 * the hub does not depend on a Tailwind colour scale to look right.
 */
import React, { useEffect, useRef } from "react";
import { ChevronDown, ChevronRight, X, CheckCircle2, AlertCircle } from "lucide-react";

export const C = {
  paper: "#F5F7F6",
  surface: "#FFFFFF",
  subtle: "#EEF3F1",
  subtle2: "#FAFBFA",
  border: "#D8DFDC",
  ink: "#12211D",
  inkMuted: "#5B706A",
  inkFaint: "#8FA39D",
  navy: "#1F3A5F",
  navyHover: "#2A4E7C",
  navySoft: "#E7EDF5",
  teal: "#0E7C7B",
  tealDeep: "#0A5F5E",
  tealSoft: "#E4F1EF",
  amber: "#B37C10",
  amberMark: "#E0A52A",
  amberSoft: "#FBF1DC",
  coral: "#C1553D",
  coralSoft: "#F6E7E3",
  dark: "#0B1F1C",
  darkInk: "#EAF3F1",
};

export const TONE = {
  good: { fg: C.tealDeep, bg: C.tealSoft, border: "rgba(14,124,123,0.35)" },
  warn: { fg: C.amber, bg: C.amberSoft, border: "rgba(224,165,42,0.45)" },
  bad: { fg: C.coral, bg: C.coralSoft, border: "rgba(193,85,61,0.40)" },
  info: { fg: C.navy, bg: C.navySoft, border: "rgba(31,58,95,0.30)" },
  neutral: { fg: C.inkMuted, bg: C.subtle, border: C.border },
};

export const FONT_BODY = "'IBM Plex Sans', system-ui, sans-serif";
export const FONT_DISPLAY = "'Space Grotesk', 'IBM Plex Sans', system-ui, sans-serif";
export const FONT_MONO = "'IBM Plex Mono', Menlo, Consolas, monospace";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  children,
  style,
  className = "",
  ...rest
}) {
  const sizes = {
    sm: { padding: "0.3rem 0.6rem", fontSize: 12, gap: 6, radius: 6 },
    md: { padding: "0.45rem 0.85rem", fontSize: 13, gap: 7, radius: 6 },
    lg: { padding: "0.62rem 1.1rem", fontSize: 14, gap: 8, radius: 7 },
  };
  const variants = {
    primary: { bg: C.navy, fg: "#fff", border: "1px solid " + C.navy, hover: C.navyHover },
    accent: { bg: C.teal, fg: "#fff", border: "1px solid " + C.teal, hover: C.tealDeep },
    secondary: { bg: C.surface, fg: C.ink, border: "1px solid " + C.border, hover: C.subtle },
    ghost: { bg: "transparent", fg: C.inkMuted, border: "1px solid transparent", hover: C.subtle },
    danger: { bg: C.coral, fg: "#fff", border: "1px solid " + C.coral, hover: "#A94732" },
  };
  const v = variants[variant] || variants.secondary;
  const s = sizes[size] || sizes.md;
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${className}`}
      style={{
        background: v.bg,
        color: v.fg,
        border: v.border,
        padding: s.padding,
        fontSize: s.fontSize,
        gap: s.gap,
        borderRadius: s.radius,
        fontFamily: FONT_BODY,
        ...style,
      }}
    >
      {icon}
      {children}
    </button>
  );
}

export function Panel({ title, subtitle, icon, actions, children, style, bodyStyle, className = "" }) {
  return (
    <section
      className={`rounded-lg border ${className}`}
      style={{ background: C.surface, borderColor: C.border, overflow: "hidden", ...style }}
    >
      {(title || actions) && (
        <header
          className="flex items-center justify-between gap-3 px-4 py-3"
          style={{ borderBottom: "1px solid " + C.border, background: C.subtle2 }}
        >
          <div className="flex items-center gap-2 min-w-0">
            {icon}
            <div className="min-w-0">
              {title && (
                <h2
                  className="font-semibold leading-tight truncate"
                  style={{ fontFamily: FONT_DISPLAY, fontSize: 14, color: C.ink }}
                >
                  {title}
                </h2>
              )}
              {subtitle && (
                <p className="text-[11px] leading-tight truncate" style={{ color: C.inkFaint }}>
                  {subtitle}
                </p>
              )}
            </div>
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </header>
      )}
      <div style={bodyStyle}>{children}</div>
    </section>
  );
}

export function Field({ label, hint, children, style }) {
  return (
    <label className="block" style={style}>
      {label && (
        <span
          className="block text-[11px] font-semibold uppercase tracking-wide mb-1.5"
          style={{ color: C.inkMuted, fontFamily: FONT_BODY }}
        >
          {label}
        </span>
      )}
      {children}
      {hint && (
        <span className="block text-[11px] mt-1" style={{ color: C.inkFaint }}>
          {hint}
        </span>
      )}
    </label>
  );
}

/**
 * A single-line text field.
 *
 * `onChange` receives the STRING VALUE, not the raw change event — that
 * is what every consumer expects (`onChange={(v) => setPath(v)}`).
 * Handing the event through meant a consumer that did `setPath(e)` stored
 * the event object, and the field displayed "[object Object]".
 */
export function TextInput({ value, onChange, readOnly, placeholder, mono, invalid, ...rest }) {
  return (
    <input
      {...rest}
      value={value}
      readOnly={readOnly}
      placeholder={placeholder}
      onChange={(e) => onChange?.(e?.target?.value ?? "")}
      className="w-full px-3 py-2 text-sm outline-none"
      style={{
        background: readOnly ? C.subtle2 : C.surface,
        border: `1px solid ${invalid ? C.coral : C.border}`,
        borderRadius: 6,
        color: value ? C.ink : C.inkFaint,
        fontFamily: mono ? FONT_MONO : FONT_BODY,
        fontSize: mono ? 12 : 13,
        userSelect: "text",
      }}
    />
  );
}

export function TextArea({ value, onChange, rows = 6, placeholder, mono, ...rest }) {
  return (
    <textarea
      {...rest}
      value={value}
      rows={rows}
      placeholder={placeholder}
      onChange={onChange}
      className="w-full px-3 py-2 text-sm outline-none resize-y"
      style={{
        background: C.surface,
        border: "1px solid " + C.border,
        borderRadius: 6,
        color: C.ink,
        fontFamily: mono ? FONT_MONO : FONT_BODY,
        fontSize: mono ? 12 : 13,
        userSelect: "text",
      }}
    />
  );
}

export function PathInput({ value, onChange, readOnly = true, placeholder = "No file selected", invalid, ...rest }) {
  return (
    <TextInput
      {...rest}
      value={value}
      onChange={onChange}
      readOnly={readOnly}
      placeholder={placeholder}
      mono
      invalid={invalid}
    />
  );
}

/** File / folder row: read-only path + browse button. */
export function PathField({ value, onBrowse, browseLabel = "Browse", invalid, onReveal, revealTitle = "Open in Explorer" }) {
  return (
    <div className="flex items-center gap-2">
      <PathInput value={value} invalid={invalid} />
      {onReveal && (
        <Button variant="secondary" size="sm" onClick={onReveal} title={revealTitle}>
          ↗
        </Button>
      )}
      <Button variant="secondary" onClick={onBrowse} style={{ whiteSpace: "nowrap" }}>
        {browseLabel}
      </Button>
    </div>
  );
}

export function Pill({ tone = "neutral", icon, children }) {
  const t = TONE[tone] || TONE.neutral;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium"
      style={{ color: t.fg, background: t.bg, borderColor: t.border, whiteSpace: "nowrap" }}
    >
      {icon}
      {children}
    </span>
  );
}

export function StatusLine({ status, running }) {
  const tone = status?.color === "good" ? "good" : status?.color === "warn" ? "warn" : status?.color === "bad" ? "bad" : "info";
  const t = TONE[tone];
  return (
    <div
      className="flex items-center gap-2 text-sm font-medium"
      style={{ color: t.fg }}
    >
      {running && <Spinner size={14} />}
      <span>{status?.text || ""}</span>
    </div>
  );
}

export function Spinner({ size = 14, color = "currentColor" }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className="animate-spin shrink-0"
      style={{ color }}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.22" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function StepHeading({ index, title, hint, right }) {
  return (
    <div className="flex items-center gap-2 mb-2.5">
      {index != null && (
        <span
          className="px-1.5 py-0.5 rounded text-[11px] font-semibold"
          style={{ background: C.navy, color: "#fff", fontFamily: FONT_MONO }}
        >
          {String(index).padStart(2, "0")}
        </span>
      )}
      <h3 className="text-sm font-semibold" style={{ fontFamily: FONT_DISPLAY, color: C.ink }}>
        {title}
      </h3>
      {hint && (
        <span className="text-[11px]" style={{ color: C.inkFaint }}>
          {hint}
        </span>
      )}
      {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
    </div>
  );
}

export function LogPanel({ logs, onClear, endRef, title = "Log", maxHeight = 260, empty = "Log output will appear here." }) {
  return (
    <Panel
      title={title}
      actions={
        onClear ? (
          <Button variant="ghost" size="sm" onClick={onClear} disabled={!logs || logs.length === 0}>
            Clear
          </Button>
        ) : null
      }
    >
      <div
        className="gsh-log font-mono text-xs p-3 overflow-y-auto whitespace-pre-wrap"
        style={{ background: C.dark, color: C.darkInk, maxHeight }}
      >
        {!logs || logs.length === 0 ? (
          <span style={{ color: "#6E8A84" }}>{empty}</span>
        ) : (
          logs.map((l, i) => <div key={i}>{typeof l === "string" ? l : l.msg}</div>)
        )}
        <div ref={endRef} />
      </div>
    </Panel>
  );
}

export function Tabs({ tabs, active, onChange }) {
  return (
    <nav className="flex items-center gap-1" style={{ borderBottom: "1px solid " + C.border }}>
      {tabs.map((t) => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className="inline-flex items-center gap-2 px-3.5 py-2.5 text-sm font-medium transition-colors"
            style={{
              color: on ? C.ink : C.inkMuted,
              borderBottom: `2px solid ${on ? C.teal : "transparent"}`,
              marginBottom: -1,
              fontFamily: FONT_BODY,
            }}
          >
            {t.icon}
            {t.label}
            {t.count != null && (
              <span
                className="ml-0.5 px-1.5 py-0.5 rounded-full text-[10px]"
                style={{ background: C.subtle, color: C.inkMuted }}
              >
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

export function EmptyState({ icon, title, hint, action }) {
  return (
    <div
      className="rounded-lg border-2 border-dashed flex flex-col items-center justify-center text-center px-6 py-12"
      style={{ borderColor: C.border, background: C.subtle2, color: C.inkFaint }}
    >
      {icon && <div style={{ color: C.inkFaint, marginBottom: 10 }}>{icon}</div>}
      <p className="text-sm font-medium" style={{ color: C.inkMuted }}>
        {title}
      </p>
      {hint && (
        <p className="text-xs mt-1 max-w-sm" style={{ color: C.inkFaint }}>
          {hint}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function DataTable({ columns, rows, empty = "No rows", maxHeight }) {
  return (
    <div className="gsh-scroll overflow-auto" style={{ maxHeight }}>
      <table className="w-full border-collapse" style={{ fontSize: 12 }}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className="text-left font-semibold uppercase tracking-wide px-3 py-2 sticky top-0"
                style={{ background: C.subtle, color: C.inkMuted, borderBottom: "1px solid " + C.border }}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                className="px-3 py-6 text-center"
                style={{ color: C.inkFaint }}
              >
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((r, i) => (
              <tr key={r.key ?? i} style={{ borderBottom: "1px solid " + C.subtle }}>
                {columns.map((c) => (
                  <td key={c.key} className="px-3 py-2 align-top" style={{ color: C.ink }}>
                    {c.render ? c.render(r, i) : r[c.key]}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Modal({ open, title, subtitle, onCancel, children, footer, width = 720 }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") onCancel?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: "rgba(11,20,38,0.55)" }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel?.();
      }}
    >
      <div
        className="rounded-lg flex flex-col"
        style={{
          background: C.surface,
          border: "1px solid " + C.border,
          maxWidth: width,
          width: "100%",
          maxHeight: "85vh",
          boxShadow: "0 24px 60px rgba(11,20,38,0.28)",
        }}
      >
        <header
          className="flex items-center justify-between gap-3 px-5 py-3.5"
          style={{ borderBottom: "1px solid " + C.border }}
        >
          <div>
            <h2 className="text-base font-semibold" style={{ fontFamily: FONT_DISPLAY, color: C.ink }}>
              {title}
            </h2>
            {subtitle && (
              <p className="text-xs mt-0.5" style={{ color: C.inkFaint }}>
                {subtitle}
              </p>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={onCancel} title="Close">
            <X size={15} />
          </Button>
        </header>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
        {footer && (
          <footer
            className="flex items-center justify-end gap-2 px-5 py-3.5"
            style={{ borderTop: "1px solid " + C.border, background: C.subtle2 }}
          >
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

export function Toast({ toast, onClose }) {
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(onClose, 5000);
    return () => clearTimeout(t);
  }, [toast, onClose]);

  if (!toast) return null;
  const tone = toast.kind === "success" ? "good" : toast.kind === "error" ? "bad" : "info";
  const t = TONE[tone];
  return (
    <div
      className="fixed bottom-5 right-5 max-w-md rounded-lg border px-4 py-3 flex items-start gap-3"
      style={{
        background: C.surface,
        borderColor: t.border,
        color: t.fg,
        boxShadow: "0 12px 32px rgba(11,20,38,0.18)",
        zIndex: 60,
      }}
    >
      <div className="flex-1 text-sm whitespace-pre-wrap">{toast.message}</div>
      <button onClick={onClose} style={{ color: "inherit", opacity: 0.55 }} className="hover:opacity-100">
        <X size={14} />
      </button>
    </div>
  );
}

/** App shell header used by every hub screen and subapp. */
export function AppHeader({ icon, title, subtitle, onBack, backLabel = "Hub", actions, meta }) {
  return (
    <header
      className="flex items-center justify-between gap-4 px-6 py-3.5"
      style={{ borderBottom: "1px solid " + C.border, background: C.surface }}
    >
      <div className="flex items-center gap-3 min-w-0">
        {onBack && (
          <Button variant="secondary" size="sm" onClick={onBack}>
            ← {backLabel}
          </Button>
        )}
        {icon && (
          <div
            className="w-9 h-9 rounded-md flex items-center justify-center shrink-0"
            style={{ background: C.navy }}
          >
            {icon}
          </div>
        )}
        <div className="min-w-0">
          <h1
            className="font-semibold leading-tight truncate"
            style={{ fontFamily: FONT_DISPLAY, fontSize: 17, color: C.ink }}
          >
            {title}
          </h1>
          {(subtitle || meta) && (
            <p className="text-[11px] leading-tight truncate" style={{ color: C.inkFaint }}>
              {subtitle}
              {subtitle && meta ? " · " : ""}
              {meta}
            </p>
          )}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </header>
  );
}

/**
 * File picker row with a live validation badge.
 * `onPick` receives the File object; the parent owns the validation state.
 */
export function FilePickerRow({
  inputRef,
  value,
  onPick,
  valid,
  error,
  accept = ".xlsx",
  placeholder = "No file selected",
  hint,
  onClear,
  onReveal,
  disabled,
}) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <TextInput value={value} readOnly mono placeholder={placeholder} style={{ flex: 1 }} />
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onPick(f);
            e.target.value = "";
          }}
        />
        {onReveal && value && (
          <Button variant="secondary" size="sm" onClick={onReveal} title="Open in Explorer">
            ↗
          </Button>
        )}
        <Button
          variant="primary"
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
        >
          Select…
        </Button>
        {onClear && value && (
          <Button variant="ghost" size="sm" onClick={onClear} title="Clear">
            <X size={14} />
          </Button>
        )}
      </div>
      {(valid || error) && (
        <div className="mt-2">
          {valid ? (
            <Pill tone="good" icon={<CheckCircle2 size={11} />}>
              {hint || "Validated"}
            </Pill>
          ) : (
            <Pill tone="bad" icon={<AlertCircle size={11} />}>
              {error || "Invalid file"}
            </Pill>
          )}
        </div>
      )}
    </div>
  );
}

/** Scroll-to-bottom helper for log panels. */
export function useLogAutoScroll(logs) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [logs]);
  return ref;
}

export function Chevron({ open, size = 14 }) {
  return open ? <ChevronDown size={size} /> : <ChevronRight size={size} />;
}
