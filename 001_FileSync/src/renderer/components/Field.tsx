import type { ReactNode } from "react";

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs uppercase tracking-wide text-slate-700 mb-1">
        {label}
      </span>
      {children}
      {hint && <span className="block text-xs text-slate-600 mt-1">{hint}</span>}
    </label>
  );
}

const inputBase =
  "w-full bg-panel border border-slate-400 rounded-md px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:border-emerald-500";

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input type="text" {...props} className={`${inputBase} ${props.className ?? ""}`} />;
}

export function NumberInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input type="number" {...props} className={`${inputBase} ${props.className ?? ""}`} />;
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`${inputBase} font-mono text-xs resize-y min-h-[80px] ${props.className ?? ""}`}
    />
  );
}
