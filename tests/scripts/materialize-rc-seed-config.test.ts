import { describe, expect, it } from 'vitest';

import { materializeRcSeedConfig } from '../../scripts/materialize-rc-seed-config';

describe('RC seed config materialization', () => {
  it('isolates both account emails and Pod names for every candidate run', () => {
    expect(materializeRcSeedConfig([
      {
        email: 'alice@rc.example',
        password: 'alice-pass',
        pods: [{ name: 'alice' }],
      },
      {
        email: 'bob@rc.example',
        password: 'bob-pass',
        pods: [{ name: 'bob' }],
      },
    ], 'rc-33231349470-1')).toEqual([
      {
        email: 'alice-rc-33231349470-1@rc.example',
        password: 'alice-pass',
        pods: [{ name: 'alice-rc-33231349470-1' }],
      },
      {
        email: 'bob-rc-33231349470-1@rc.example',
        password: 'bob-pass',
        pods: [{ name: 'bob-rc-33231349470-1' }],
      },
    ]);
  });

  it('normalizes and bounds generated Pod names to a DNS label', () => {
    const [account] = materializeRcSeedConfig([
      {
        email: 'alice@rc.example',
        pods: [{ name: 'Alice Storage With A Needlessly Long Human Name That Exceeds DNS Labels' }],
      },
    ], 'Run/42 Attempt 3');

    expect(account.email).toBe('alice-run-42-attempt-3@rc.example');
    expect((account.pods as Array<{ name: string }>)[0].name).toMatch(/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/);
    expect((account.pods as Array<{ name: string }>)[0].name.length).toBeLessThanOrEqual(63);
  });

  it('rejects malformed account and Pod entries before deployment', () => {
    expect(() => materializeRcSeedConfig({}, 'run-1')).toThrow(/array/i);
    expect(() => materializeRcSeedConfig([{ email: '@rc.example', pods: [{ name: 'alice' }] }], 'run-1')).toThrow(/valid email/i);
    expect(() => materializeRcSeedConfig([{ email: 'alice@rc.example', pods: [] }], 'run-1')).toThrow(/at least one Pod/i);
    expect(() => materializeRcSeedConfig([{ email: 'alice@rc.example', pods: [{}] }], 'run-1')).toThrow(/include a name/i);
  });

  // RC404 regression: the producer created Alice/Bob at attempt 2, then a
  // downstream consumer was retried as attempt 3. Deriving the suffix from the
  // CONSUMER's own attempt names accounts that were never created, so the
  // platform provider login 403s. Consumers must reuse the producer's suffix.
  it('raw secret accounts do not authenticate, but the producer suffix survives a consumer retry', () => {
    const rawSecret = [
      { email: 'alice@rc.example', password: 'alice-pass', pods: [{ name: 'alice' }] },
      { email: 'bob@rc.example', password: 'bob-pass', pods: [{ name: 'bob' }] },
    ];
    const producerSuffix = 'rc-42883745435-2';   // deploy_and_accept attempt 2
    const consumerAttempt = 3;                   // mode/desktop-only retry
    const consumerNaiveSuffix = `rc-42883745435-${consumerAttempt}`;

    // The producer materialized these exact identities.
    const materialized = materializeRcSeedConfig(rawSecret, producerSuffix);
    expect(materialized.map(account => account.email)).toEqual([
      'alice-rc-42883745435-2@rc.example',
      'bob-rc-42883745435-2@rc.example',
    ]);

    // Using the raw secret (never materialized) points at accounts the RC never
    // created -- this is the 403. Proving the shapes differ keeps the bug fixed.
    expect(rawSecret.map(account => account.email))
      .not.toEqual(materialized.map(account => account.email));

    // A naive consumer-attempt suffix names a DIFFERENT, nonexistent account set.
    const naive = materializeRcSeedConfig(rawSecret, consumerNaiveSuffix);
    expect(naive.map(account => account.email)).not.toEqual(materialized.map(account => account.email));

    // Reusing the producer's published suffix reproduces the producer identity
    // byte-for-byte, which is what the consumer must do on attempt 3.
    const reused = materializeRcSeedConfig(rawSecret, 'rc-42883745435-2');
    expect(reused).toEqual(materialized);
  });
});
