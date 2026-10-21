/**
 * Small shared UI primitives: buttons, panels, selects, chips, toasts.
 * Kept dependency-free so the app has no component library to maintain.
 */
import React from "react";
import { Loader2 } from "lucide-react";

// ---------------------------------------------------------------- Panel

export function Panel({ title, subtitle, right, children, className = "", bodyClass = "" }) {
  return (
    <section
      className={`rounded-xl border border-[#2A313C] bg-[#161A21] ${className}`}
    >
      {(title || right) && (
        <header className="flex items-start justify-between gap-3 border-b border-[#232A34] px-4 py-3">
          <div className="min-w-0">
            {title && (
              <h2 className="truncate text-[13px] font-semibold uppercase tracking-wider text-[#8B95A5]">
                {title}
              </h2>
            )}
            {subtitle && <p className="mt-0.5 text-xs text-[#6B7480]">{subtitle}</p>}
          </div>
          {right && <div className="shrink-0">{right}</div>}
        </header>
      )}
      <div className={`p-4 ${bodyClass}`}>{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------- Button

export function Button({
  children,
  onClick,
  variant = "default",
  size = "md",
  disabled = false,
  busy = false,
  icon: Icon,
  className = "",
  title,
  type = "button",
}) {
  const variants = {
    default:
      "bg-[#232A34] text-[#E6EAF0] border border-[#333C49] hover:bg-[#2B333F] hover:border-[#414B5A]",
    primary:
      "bg-[#38BDF8] text-[#0B1220] border border-[#38BDF8] hover:bg-[#7DD3FC] font-semibold",
    ghost:
      "bg-transparent text-[#8B95A5] border border-transparent hover:bg-[#1E242D] hover:text-[#E6EAF0]",
    danger:
      "bg-transparent text-[#FB7185] border border-[#4A2A31] hover:bg-[#2A1A1F]",
  };
  const sizes = {
    sm: "px-2.5 py-1.5 text-xs gap-1.5",
    md: "px-3.5 py-2 text-sm gap-2",
    lg: "px-5 py-2.5 text-sm gap-2",
  };
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled || busy}
      className={`inline-flex items-center justify-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${variants[variant]} ${sizes[size]} ${className}`}
    >
      {busy ? <Loader2 size={15} className="animate-spin" /> : Icon ? <Icon size={15} /> : null}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------- Select

export function Select({ label, value, onChange, options, disabled, placeholder, hint }) {
  return (
    <label className="block">
      {label && (
        <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-[#6B7480]">
          {label}
        </span>
      )}
      <div className="relative">
        <select
          value={value ?? ""}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="w-full appearance-none rounded-lg border border-[#2F3743] bg-[#1B2029] px-3 py-2 pr-9 text-sm text-[#E6EAF0] outline-none transition-colors hover:border-[#3B4553] focus:border-[#38BDF8] disabled:opacity-40"
        >
          {placeholder && <option value="">{placeholder}</option>}
          {options.map((opt) => {
            const val = typeof opt === "object" ? opt.value : opt;
            const lbl = typeof opt === "object" ? opt.label : opt;
            return (
              <option key={String(val)} value={String(val)}>
                {lbl}
              </option>
            );
          })}
        </select>
        <svg
          className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#6B7480]"
          viewBox="0 0 16 16"
          fill="none"
        >
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </div>
      {hint && <span className="mt-1 block text-[11px] text-[#6B7480]">{hint}</span>}
    </label>
  );
}

// ---------------------------------------------------------------- Checkbox

export function Checkbox({ label, checked, onChange, hint, disabled }) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-2.5 rounded-lg px-1 py-1 ${
        disabled ? "opacity-40" : "hover:bg-[#1B2029]"
      }`}
    >
      <input
        type="checkbox"
        checked={!!checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-[#3B4553] bg-[#1B2029]"
      />
      <span className="min-w-0">
        <span className="block text-sm text-[#D4DAE4]">{label}</span>
        {hint && <span className="mt-0.5 block text-[11px] text-[#6B7480]">{hint}</span>}
      </span>
    </label>
  );
}

// ---------------------------------------------------------------- Slider

export function Slider({ label, value, min, max, step = 1, onChange, format, hint }) {
  return (
    <label className="block">
      {label && (
        <span className="mb-1.5 flex items-baseline justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[#6B7480]">
            {label}
          </span>
          <span className="font-mono-tabular text-xs text-[#38BDF8]">
            {format ? format(value) : value}
          </span>
        </span>
      )}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full"
      />
      {hint && <span className="mt-1 block text-[11px] text-[#6B7480]">{hint}</span>}
    </label>
  );
}

// ---------------------------------------------------------------- Field

export function Field({ label, children, hint }) {
  return (
    <div>
      {label && (
        <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-[#6B7480]">
          {label}
        </span>
      )}
      {children}
      {hint && <span className="mt-1 block text-[11px] text-[#6B7480]">{hint}</span>}
    </div>
  );
}

// ---------------------------------------------------------------- Badge

export function Badge({ children, tone = "default", className = "" }) {
  const tones = {
    default: "bg-[#232A34] text-[#8B95A5] border-[#333C49]",
    info: "bg-[#0E2A38] text-[#38BDF8] border-[#1B4A5E]",
    good: "bg-[#12301F] text-[#4ADE80] border-[#1D4A2E]",
    warn: "bg-[#33280F] text-[#FBBF24] border-[#4D3C15]",
    bad: "bg-[#331418] text-[#FB7185] border-[#4E2129]",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------- Empty

export function EmptyState({ icon: Icon, title, children }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      {Icon && (
        <div className="mb-1 rounded-xl border border-[#2A313C] bg-[#1B2029] p-3 text-[#4A5563]">
          <Icon size={22} />
        </div>
      )}
      <p className="text-sm font-medium text-[#8B95A5]">{title}</p>
      {children && <div className="max-w-md text-xs leading-relaxed text-[#5F6875]">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- Alert

export function Alert({ tone = "info", title, children, onClose }) {
  const tones = {
    info: "border-[#1B4A5E] bg-[#0E2A38] text-[#9BDCF5]",
    good: "border-[#1D4A2E] bg-[#12301F] text-[#8FE8AE]",
    warn: "border-[#4D3C15] bg-[#33280F] text-[#F5D98A]",
    bad: "border-[#4E2129] bg-[#331418] text-[#F5A3AE]",
  };
  return (
    <div className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-xs ${tones[tone]}`}>
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className="mt-0.5 leading-relaxed opacity-90">{children}</div>}
      </div>
      {onClose && (
        <button onClick={onClose} className="shrink-0 opacity-60 hover:opacity-100">
          ✕
        </button>
      )}
    </div>
  );
}
