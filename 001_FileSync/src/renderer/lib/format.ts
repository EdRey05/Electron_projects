export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n < 1024 ** 4) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  return `${(n / 1024 ** 4).toFixed(2)} TB`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

/** Compact timestamp for the sync table: "2026-04-26 14:30". */
export function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    ` ${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** Human-friendly relative age: "3 min ago", "2 days ago". */
export function formatAge(ms: number, now = Date.now()): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const delta = now - ms;
  if (delta < 0) return "in the future";
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 365) return `${d}d ago`;
  return `${Math.floor(d / 365)}y ago`;
}
