export function time(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const rest = (total % 60).toString().padStart(2, '0');
  return hours ? `${hours}:${minutes.toString().padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}
export function views(count: number | null | undefined): string {
  if (count == null || !Number.isFinite(count) || count < 0) return '';
  return `${new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(count)} views`;
}
export function bytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${Math.floor(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)) - 1, units.length - 1);
  return `${(value / 1024 ** (index + 1)).toFixed(index ? 1 : 0)} ${units[index]}`;
}
export function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return 'Something went wrong. Please try again.';
}
export function uniqueItems<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter(item => !seen.has(item.id) && Boolean(seen.add(item.id)));
}
export function progressPercent(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
}
export function relativeDate(timestamp: number): string {
  if (!timestamp || !Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp > 1e12 ? timestamp : timestamp * 1000);
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(date);
}
