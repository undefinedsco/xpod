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
});
