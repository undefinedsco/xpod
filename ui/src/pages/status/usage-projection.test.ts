import { describe, expect, test } from 'bun:test';
import { projectAiUsage, projectIndexStorage } from './usage-projection';

describe('usage projections', () => {
  test('uses measured token consumption and limit instead of provider count', () => {
    expect(projectAiUsage({ usage: { tokensUsed: 3456, computeSeconds: 12 }, limits: { tokenLimitMonthly: 10000, computeLimitSeconds: 120 } })).toEqual([
      ['Tokens', '3,456'], ['Monthly token limit', '10,000'], ['Compute', '12 s'], ['Compute limit', '120 s'],
    ]);
  });
  test('separates authority data from rebuildable derived index bytes', () => {
    expect(projectIndexStorage({ factsBytes: 1024, derivedBytes: 2048, totalBytes: 3072 })).toEqual([
      ['Authority data', '1 KB'], ['Derived indexes', '2 KB'], ['Combined', '3 KB'],
    ]);
  });
});
