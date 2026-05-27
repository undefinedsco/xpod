/**
 * Cloud PostgreSQL quota/business-token regression test.
 *
 * Covers the xpod bug where PG TIMESTAMPTZ columns were written as Unix seconds,
 * breaking service-token registration and quota writes on cloud runtime.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

const RUN_INTEGRATION_TESTS = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true';
const SERVICE_READY_RETRIES = Number(process.env.XPOD_DOCKER_READY_RETRIES ?? '45');
const SERVICE_READY_DELAY_MS = Number(process.env.XPOD_DOCKER_READY_DELAY_MS ?? '1000');
const CLOUD_PORT = process.env.CLOUD_PORT || '6300';
const CLOUD_BASE_URL = `http://localhost:${CLOUD_PORT}`;
const BUSINESS_TOKEN = 'svc-testservicetokenforintegration';

const suite = RUN_INTEGRATION_TESTS ? describe : describe.skip;

suite('Cloud PG quota regression', () => {
  let pgClient: Client | null = null;

  beforeAll(async () => {
    pgClient = new Client({
      user: 'xpod',
      password: 'xpod',
      host: 'localhost',
      database: 'xpod',
      port: 5432,
    });
    await pgClient.connect();

    const ready = await waitForService(CLOUD_BASE_URL, SERVICE_READY_RETRIES, SERVICE_READY_DELAY_MS);
    expect(ready).toBe(true);
  }, 180000);

  afterAll(async () => {
    await pgClient?.end();
  });

  it('registers the business token in PostgreSQL', async () => {
    const result = await pgClient!.query(`
      SELECT service_type, service_id, scopes
      FROM identity_service_token
      WHERE service_type = 'business'
        AND service_id = 'business-default'
    `);

    expect(result.rows.length).toBeGreaterThan(0);
    const row = result.rows[0];
    expect(row.service_type).toBe('business');
    expect(row.service_id).toBe('business-default');

    const scopes = JSON.parse(row.scopes);
    expect(scopes).toContain('quota:write');
    expect(scopes).toContain('usage:read');
    expect(scopes).toContain('account:manage');
  });

  it('accepts business token for cloud quota write and persists the quota', async () => {
    const accountId = `cloud-quota-${Date.now()}`;
    const quota = {
      storageLimitBytes: 3221225472,
      bandwidthLimitBps: 2097152,
      computeLimitSeconds: 5400,
      tokenLimitMonthly: 750000,
    };

    const setRes = await fetch(`${CLOUD_BASE_URL}/v1/quota/accounts/${accountId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${BUSINESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(quota),
    });
    expect(setRes.status).toBe(200);

    const setData = await setRes.json() as { status: string; accountId: string; quota: typeof quota };
    expect(setData.status).toBe('updated');
    expect(setData.accountId).toBe(accountId);
    expect(setData.quota).toMatchObject(quota);

    const getRes = await fetch(`${CLOUD_BASE_URL}/v1/quota/accounts/${accountId}`, {
      headers: { Authorization: `Bearer ${BUSINESS_TOKEN}` },
    });
    expect(getRes.status).toBe(200);

    const getData = await getRes.json() as { quota: typeof quota; source: string };
    expect(getData.quota).toMatchObject(quota);
    expect(getData.source).toBe('custom');

    const dbRes = await pgClient!.query(`
      SELECT storage_limit_bytes, bandwidth_limit_bps, compute_limit_seconds, token_limit_monthly
      FROM identity_account_usage
      WHERE account_id = $1
    `, [accountId]);
    expect(dbRes.rows.length).toBe(1);
    expect(Number(dbRes.rows[0].storage_limit_bytes)).toBe(quota.storageLimitBytes);
    expect(Number(dbRes.rows[0].bandwidth_limit_bps)).toBe(quota.bandwidthLimitBps);
    expect(Number(dbRes.rows[0].compute_limit_seconds)).toBe(quota.computeLimitSeconds);
    expect(Number(dbRes.rows[0].token_limit_monthly)).toBe(quota.tokenLimitMonthly);
  });
});

async function waitForService(url: string, maxRetries = 30, delayMs = 1000): Promise<boolean> {
  const statusUrl = `${url}/service/status`;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(statusUrl);
      if (response.ok) {
        return true;
      }
    } catch {
      // ignore and retry
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}
