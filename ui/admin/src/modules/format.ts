export function formatBytes(value?: number | null): string {
  if (value == null) {
    return '—';
  }
  if (value === 0) {
    return '0 B';
  }
  const units = [ 'B', 'KB', 'MB', 'GB', 'TB', 'PB' ];
  const magnitude = Math.floor(Math.log(value) / Math.log(1024));
  const unit = units[Math.min(magnitude, units.length - 1)];
  const size = value / 1024 ** Math.min(magnitude, units.length - 1);
  return `${size >= 100 ? size.toFixed(0) : size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${unit}`;
}

export function formatQuota(value?: number | null): string {
  if (value == null) {
    return '∞';
  }
  return formatBytes(value);
}

export function formatDateTime(value?: string | null): string {
  if (!value) {
    return '—';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return date.toLocaleString();
}
