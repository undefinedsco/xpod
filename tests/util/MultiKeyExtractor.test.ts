import { describe, it, expect } from 'vitest';
import { MultiKeyExtractor } from '../../src/util/variables/MultiKeyExtractor';

describe('MultiKeyExtractor', () => {
  it('returns the first defined key', async () => {
    const extractor = new MultiKeyExtractor({ keys: [ 'lower', 'UPPER' ], defaultValue: 'false' });
    await expect(extractor.handle({ lower: 'true' })).resolves.toBe('true');
  });

  it('falls back to secondary key', async () => {
    const extractor = new MultiKeyExtractor({ keys: [ 'lower', 'UPPER' ], defaultValue: 'false' });
    await expect(extractor.handle({ UPPER: '1' })).resolves.toBe('1');
  });

  it('returns default when none set', async () => {
    const extractor = new MultiKeyExtractor({ keys: [ 'lower', 'UPPER' ], defaultValue: 'false' });
    await expect(extractor.handle({})).resolves.toBe('false');
  });
});
