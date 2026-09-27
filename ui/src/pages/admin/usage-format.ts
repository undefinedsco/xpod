import type { PodStorageStatus } from '../../api/pod-settings';

/** 用量文案的唯一实现：概览与用量页共用，避免两处格式化出不同结论。 */
export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '未知';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? size : size.toFixed(1)} ${units[unit]}`;
}

export function formatSeconds(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '未知';
  if (value < 60) return `${value} 秒`;
  if (value < 3600) return `${(value / 60).toFixed(1)} 分钟`;
  return `${(value / 3600).toFixed(1)} 小时`;
}

export function formatLimit(value: number | null, render: (limit: number) => string): string {
  return value === null ? '不限' : render(value);
}

/** 概览里的一行用量摘要；未知与不支持都不回落成 0（AC-09）。 */
export function describeStorageUsage(storage: PodStorageStatus | null): string {
  if (storage === null) return '用量正在读取';
  if (storage.status !== 'available') {
    return storage.status === 'unsupported' ? '此部署不提供用量' : '用量未知';
  }
  return `已用 ${formatBytes(storage.usage.storageBytes)}`;
}
