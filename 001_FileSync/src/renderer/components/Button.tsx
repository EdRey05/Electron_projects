import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "danger" | "ghost";

const VARIANT_CLASSES: Record<Variant, string> = {
  primary:
    "bg-emerald-700 hover:bg-emerald-800 text-white border border-emerald-700",
  secondary:
    "bg-slate-200 hover:bg-slate-300 text-slate-900 border border-slate-400",
  danger:
    "bg-red-700 hover:bg-red-800 text-white border border-red-700",
  ghost:
    "bg-transparent hover:bg-panel-muted text-slate-700 border border-transparent",
};

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  children: ReactNode;
}

export function Button({ variant = "secondary", className = "", children, ...rest }: Props) {
  return (
    <button
      {...rest}
      className={`px-3 py-1.5 rounded-md text-sm transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${VARIANT_CLASSES[variant]} ${className}`}
    >
      {children}
    </button>
  );
}
