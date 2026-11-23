import { describe, expect, it } from 'vitest';
import { parseRetryAfter, retryAfterFromError } from '../../../src/api/service/provider-retry-after';

const NOW = new Date('2026-07-23T00:00:00.000Z');

describe('Retry-After', () => {
  it.each([
    ['600', 600_000], [' 9 ', 9_000], ['0', 0],
    ['Thu, 23 Jul 2026 00:10:00 GMT', 600_000],
    ['Thursday, 23-Jul-26 00:10:00 GMT', 600_000],
    ['Thu Jul 23 00:10:00 2026', 600_000],
    ['Wed, 22 Jul 2026 23:59:00 GMT', 0],
  ])('interprets %s against the supplied clock', (value, offset) => {
    expect(parseRetryAfter(value, NOW)?.getTime()).toBe(NOW.getTime() + offset);
  });

  it.each([undefined, null, '', ' ', '-1', '0.5', '1e3', 'Infinity', 'NaN', 'tomorrow',
    '99999999999999999999999999', 'Thu, 23 Foo 2026 00:10:00 GMT'])('rejects invalid hint %s', (value) => {
    expect(parseRetryAfter(value, NOW)).toBeUndefined();
  });

  it('reads Fetch and dictionary headers without case-sensitive key assumptions', () => {
    expect(retryAfterFromError({ headers: new Headers({ 'retry-after': '600' }) })).toBe('600');
    expect(retryAfterFromError({ headers: { 'rEtRy-AfTeR': '90' } })).toBe('90');
    expect(retryAfterFromError({ headers: { 'Retry-After': {} } })).toBeUndefined();
    expect(retryAfterFromError(null)).toBeUndefined();
  });
});
