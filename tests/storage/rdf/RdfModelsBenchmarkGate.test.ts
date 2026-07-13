import { describe, expect, it } from 'vitest';
import { postgresServingRegressionFailures } from '../../../src/storage/rdf/models-benchmark';

describe('postgresServingRegressionFailures', () => {
  it('does not fail serving gates for bounded checkpoint outliers when plan, scan, and p50 stay healthy', () => {
    const failures = postgresServingRegressionFailures(baseResult({
      durationsMs: [
        241,
        241,
        242,
        243,
        245,
        246,
        249,
        249,
        249,
        250,
        250,
        251,
        251,
        251,
        251,
        251,
        251,
        252,
        255,
        255,
        255,
        256,
        256,
        256,
        256,
        256,
        257,
        258,
        258,
        259,
        260,
        260,
        263,
        263,
        265,
        265,
        318,
        1330,
        1331,
        1459,
      ],
      p50DurationMs: 255,
      p95DurationMs: 1330,
    }), {
      cases: {
        'message score by thread numeric aggregate': {
          maxScannedRows: 80,
          maxP95DurationMs: 334,
          maxDurationMs: 1562,
        },
      },
    });

    expect(failures).not.toContain('p95-duration-threshold');
  });

  it('still fails serving gates when central latency regresses beyond the p95 threshold', () => {
    const failures = postgresServingRegressionFailures(baseResult({
      p50DurationMs: 900,
      p95DurationMs: 1330,
      durationsMs: [900, 910, 920, 1330],
    }), {
      cases: {
        'message score by thread numeric aggregate': {
          maxScannedRows: 80,
          maxP95DurationMs: 334,
          maxDurationMs: 1562,
        },
      },
    });

    expect(failures).toContain('p95-duration-threshold');
  });
});

function baseResult(overrides: Partial<Parameters<typeof postgresServingRegressionFailures>[0]> = {}): Parameters<typeof postgresServingRegressionFailures>[0] {
  return {
    name: 'message score by thread numeric aggregate',
    resource: 'message',
    purpose: 'aggregate numeric scores by thread',
    minScale: 'large',
    query: {},
    expectedPlan: ['numeric-aggregate'],
    planMatched: true,
    missingPlan: [],
    physicalPlan: [
      'Rdf3xJoinBGP(2)',
      'PostgresRdf3xGroupAggregate',
      'Aggregate(group-count(?message),sum(?score),avg(?score))',
    ],
    scannedRows: 64,
    indexChoices: ['rdf3x'],
    fallbackReason: null,
    returnedRows: 1,
    checksum: 'checksum',
    orderedChecksum: 'ordered',
    durationsMs: [250, 255, 260],
    p50DurationMs: 255,
    p95DurationMs: 260,
    metrics: {} as never,
    indexStats: {} as never,
    ...overrides,
  };
}
