import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { executeQuery, getIdentityDatabase } from '../../../src/identity/drizzle/db';
import { UsageRepository } from '../../../src/storage/quota/UsageRepository';

describe('UsageRepository', () => {
  it('stores account and pod metrics as scoped rows in identity_usage', async () => {
    const db = getIdentityDatabase(`sqlite::memory:usage-repository-${Date.now()}`);
    const repo = new UsageRepository(db);

    await repo.incrementUsage('acc-1', 'pod-1', 10, 3, 7);
    await repo.setPodStorageLimit('pod-1', 'acc-1', 1024);
    await repo.setAccountBandwidthLimit('acc-1', 2048);

    const result = await executeQuery<{
      scope_type: string;
      scope_id: string;
      account_id: string;
      storage_bytes: number;
      ingress_bytes: number;
      egress_bytes: number;
      storage_limit_bytes: number | null;
      bandwidth_limit_bps: number | null;
    }>(db, sql`
      SELECT scope_type, scope_id, account_id, storage_bytes, ingress_bytes, egress_bytes, storage_limit_bytes, bandwidth_limit_bps
      FROM identity_usage
      ORDER BY scope_type, scope_id
    `);

    expect(result.rows).toEqual([
      {
        scope_type: 'account',
        scope_id: 'acc-1',
        account_id: 'acc-1',
        storage_bytes: 10,
        ingress_bytes: 3,
        egress_bytes: 7,
        storage_limit_bytes: null,
        bandwidth_limit_bps: 2048,
      },
      {
        scope_type: 'pod',
        scope_id: 'pod-1',
        account_id: 'acc-1',
        storage_bytes: 10,
        ingress_bytes: 3,
        egress_bytes: 7,
        storage_limit_bytes: 1024,
        bandwidth_limit_bps: null,
      },
    ]);

    expect(await repo.getAccountUsage('acc-1')).toMatchObject({
      accountId: 'acc-1',
      storageBytes: 10,
      ingressBytes: 3,
      egressBytes: 7,
      bandwidthLimitBps: 2048,
    });
    expect(await repo.getPodUsage('pod-1')).toMatchObject({
      podId: 'pod-1',
      accountId: 'acc-1',
      storageBytes: 10,
      ingressBytes: 3,
      egressBytes: 7,
      storageLimitBytes: 1024,
    });
  });
});
