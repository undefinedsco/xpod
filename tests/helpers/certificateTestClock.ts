import { vi } from 'vitest';

/** Fixed date-only clock for the long-lived sample certificate. Timers stay real. */
export function useCertificateTestClock(now = '2026-10-31T00:00:00.000Z'): () => void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now));
  return () => vi.useRealTimers();
}
