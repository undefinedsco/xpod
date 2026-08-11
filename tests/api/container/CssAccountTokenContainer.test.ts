import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createApiContainer, type ApiContainerConfig } from '../../../src/api/container';
import { executeStatement } from '../../../src/identity/drizzle/db';

function baseConfig(databaseUrl: string): ApiContainerConfig {
  return {
    edition: 'local',
    port: 3001,
    host: '127.0.0.1',
    authMode: 'acp',
    databaseUrl,
    corsOrigins: ['*'],
    cssTokenEndpoint: 'https://issuer.example/.oidc/token',
    gatewayLocatorSecret: 'locator-secret',
  };
}

describe('CSS account token API container wiring', () => {
  it('resolves local internal_kv account cookies through the API authenticator', async () => {
    const container = createApiContainer(baseConfig(`sqlite::memory:css-account-container-${randomUUID()}`));
    const db = container.resolve('db');
    await executeStatement(db, sql`
      CREATE TABLE internal_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await executeStatement(db, sql`
      CREATE TABLE identity_store (
        container TEXT NOT NULL,
        id TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (container, id)
      )
    `);
    await executeStatement(db, sql`
      INSERT INTO identity_store (container, id, payload)
      VALUES ('account', 'account-container', '{}')
    `);
    await executeStatement(db, sql`
      INSERT INTO internal_kv (key, value)
      VALUES ('accounts/cookies/container-token', ${JSON.stringify({
        expires: new Date(Date.now() + 60_000).toISOString(),
        payload: 'account-container',
      })})
    `);

    const result = await container.resolve('authenticator').authenticate({
      headers: { authorization: 'CSS-Account-Token container-token' },
    } as any);

    expect(result).toEqual({
      success: true,
      context: {
        type: 'account',
        accountId: 'account-container',
        tokenType: 'CSS-Account-Token',
      },
    });
  });
});
