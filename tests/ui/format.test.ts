import { describe, it, expect } from 'vitest';
import { formatBytes, formatQuota, formatDateTime } from '../../ui/admin/src/modules/format';

describe('format helpers', () => {
  it('formatBytes 处理空值与零值', () => {
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formatBytes 根据大小选择单位', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.00 KB');
    expect(formatBytes(10_485_760)).toBe('10.0 MB');
    expect(formatBytes(120_000_000_000)).toBe('112 GB');
  });

  it('formatQuota 返回无限符号或调用 formatBytes', () => {
    expect(formatQuota(undefined)).toBe('∞');
    expect(formatQuota(null)).toBe('∞');
    expect(formatQuota(2048)).toBe('2.00 KB');
  });

  it('formatDateTime 忽略非法日期', () => {
    expect(formatDateTime(undefined)).toBe('—');
    expect(formatDateTime('not-a-date')).toBe('—');
  });

  it('formatDateTime 输出本地化字符串', () => {
    const value = '2024-01-01T00:00:00.000Z';
    const result = formatDateTime(value);
    expect(result).not.toBe('—');
  });
});
