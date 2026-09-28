import { describe, expect, it } from 'vitest';
import { eventIdForWrite, generateEventId, isEventId } from '../../../src/api/matrix/eventIdentity';

describe('who decides an event id', () => {
  it('keeps the id the writer supplied, because that is what a retry matches on', () => {
    expect(eventIdForWrite('$client-chosen')).toBe('$client-chosen');
    expect(eventIdForWrite('$client-chosen')).toBe('$client-chosen');
  });

  it('generates one when the deployment initiates the event', () => {
    const first = eventIdForWrite();
    const second = generateEventId();
    expect(isEventId(first)).toBe(true);
    expect(isEventId(second)).toBe(true);
    expect(first).not.toBe(second);
  });

  it('refuses an id that would change where the row lands, instead of substituting one', () => {
    // A silent substitution would break the only thing the caller's id is for.
    for (const bad of [ '', 'has space', 'has/slash', 'has#fragment', 'has?query', 'has\\backslash' ]) {
      expect(isEventId(bad)).toBe(false);
      expect(() => eventIdForWrite(bad)).toThrow(/non-empty fragment/u);
    }
    expect(isEventId('x'.repeat(256))).toBe(false);
    expect(isEventId(undefined)).toBe(false);
  });

  it('proves nothing by itself, which is why it travels with the writer\'s identity', () => {
    // Stated as a test so the property is not forgotten: any string that passes the grammar is a
    // valid id, so authenticity has to come from the hop's identity and the author's own copy.
    expect(isEventId('$anything-at-all')).toBe(true);
  });
});
