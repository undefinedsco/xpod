import { describe, expect, it } from 'vitest';
import { nextCronOccurrence } from '../../src/api/tasks/cron';
const seconds = (day: number, hour = 0, minute = 0) => +new Date(2026, 9, day, hour, minute) / 1000;
describe('task schedule next occurrence', () => {
  it('respects daily time instead of adding one minute', () => {
    expect(nextCronOccurrence('0 9 * * *', seconds(2, 10))).toBe(seconds(3, 9));
    expect(nextCronOccurrence('0 9 * * *', seconds(2, 8))).toBe(seconds(2, 9));
  });
  it('aligns minute intervals and ranges', () => {
    expect(nextCronOccurrence('*/15 * * * *', seconds(2, 10, 7))).toBe(seconds(2, 10, 15));
    expect(nextCronOccurrence('0 9 * * 1-5', seconds(2, 10))).toBe(seconds(5, 9));
  });
  it('supports day and month constraints and rejects invalid input before persisting', () => {
    expect(nextCronOccurrence('0 9 15 10 *', seconds(2))).toBe(seconds(15, 9));
    expect(() => nextCronOccurrence('60 * * * *', seconds(2))).toThrow();
    expect(() => nextCronOccurrence('*/0 * * * *', seconds(2))).toThrow();
    expect(() => nextCronOccurrence('not cron', seconds(2))).toThrow();
  });
});
