export function formatClockUTC(iso: string | null | undefined): string {
  if (!iso) return '—';
  return iso.slice(11, 19);
}

export function formatDateTimeUTC(iso: string | null | undefined): string {
  if (!iso) return '—';
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diffMs = Date.now() - Date.parse(iso);
  const past = diffMs >= 0;
  const abs = Math.abs(diffMs);
  const s = Math.round(abs / 1000);
  if (s < 60) return past ? `${s}s ago` : `in ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return past ? `${m}m ago` : `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return past ? `${h}h ago` : `in ${h}h`;
  const d = Math.round(h / 24);
  return past ? `${d}d ago` : `in ${d}d`;
}

export function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}
