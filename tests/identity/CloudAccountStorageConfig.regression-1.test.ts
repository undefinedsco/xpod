import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

// Regression: ISSUE-001 — Cloud login stopped reading persisted account records
// Found by /qa on 2026-09-05
// Report: .gstack/qa-reports/qa-report-undefineds-gz-sealosgzg-site-2026-09-05.md
describe('Cloud account storage configuration', () => {
  it('keeps CSS account identity records in the clustered identity database', async () => {
    const cloud = JSON.parse(await readFile('config/cloud.json', 'utf8')) as {
      '@graph': Array<Record<string, any>>;
    };
    const override = cloud['@graph'].find((entry) =>
      entry['@type'] === 'Override' &&
      entry.overrideInstance?.['@id'] === 'urn:solid-server:default:AccountStorage');

    expect(override?.overrideParameters).toEqual({
      '@type': 'DrizzleIndexedStorage',
      connectionString: {
        '@id': 'urn:solid-server:default:variable:identityDbUrl',
        '@type': 'Variable',
      },
    });
  });
});
