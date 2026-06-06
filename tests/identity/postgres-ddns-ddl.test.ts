import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { ensureCloudClusterTables, executeQuery, getIdentityDatabase } from '../../src/identity/drizzle/db';

describe('postgres identity ddl', () => {
  const legacyUsageTables = [ 'identity_' + 'account_usage', 'identity_' + 'pod_usage' ];
  const legacyRoleTable = 'identity_' + 'account_role';
  const legacyWebIdProfileTable = 'identity_' + 'webid_profile';
  const legacyEdgeNodeTable = 'identity_' + 'edge_node';
  const legacyEdgeNodePodTable = 'identity_' + 'edge_node_pod';
  const legacyOwnerColumn = 'owner_' + 'account_id';
  const legacyIpv4Column = 'public_' + 'ip';

  it('keeps Cloud cluster table names out of the identity table namespace', () => {
    const source = readFileSync(new URL('../../src/identity/drizzle/db.ts', import.meta.url), 'utf8');
    expect(source).toContain('CREATE TABLE IF NOT EXISTS identity_usage');
    expect(source).not.toContain('storage_url TEXT');
    expect(source).not.toContain('CREATE TABLE IF NOT EXISTS identity_ddns_domain');
    expect(source).not.toContain('CREATE TABLE IF NOT EXISTS identity_ddns_record');
    expect(source).not.toContain('CREATE TABLE IF NOT EXISTS identity_service_token');
    expect(source).toContain('CREATE TABLE IF NOT EXISTS cluster_ddns_record');
    expect(source).toContain('CREATE TABLE IF NOT EXISTS cluster_service_token');
    expect(source).toContain('CREATE TABLE IF NOT EXISTS cluster_node');
    expect(source).not.toContain('CREATE TABLE IF NOT EXISTS cluster_ddns_domain');
    expect(source).not.toContain('CREATE TABLE IF NOT EXISTS cluster_edge_node');
    expect(source).not.toContain('CREATE TABLE IF NOT EXISTS cluster_edge_node_pod');
    expect(source).not.toContain(`CREATE TABLE IF NOT EXISTS ${legacyEdgeNodeTable}`);
    expect(source).not.toContain(`CREATE TABLE IF NOT EXISTS ${legacyEdgeNodePodTable}`);
    expect(source).not.toContain('CREATE TABLE IF NOT EXISTS identity_api_client_credentials');
    expect(source).not.toContain('CREATE TABLE IF NOT EXISTS api_client_credentials');
    expect(source).not.toContain('client_secret_encrypted');
    expect(source).not.toContain(`CREATE TABLE IF NOT EXISTS ${legacyRoleTable}`);
    expect(source).not.toContain(`CREATE TABLE IF NOT EXISTS ${legacyWebIdProfileTable}`);
    expect(source).not.toContain(legacyOwnerColumn);
    expect(source).not.toContain(legacyIpv4Column);
  });

  it('keeps setup scripts aligned with the canonical identity schema', () => {
    const initPostgres = readFileSync(new URL('../../scripts/init-postgres.sql', import.meta.url), 'utf8');
    const edgeTables = readFileSync(new URL('../../create-edge-tables.sql', import.meta.url), 'utf8');

    expect(initPostgres).toContain('CREATE TABLE IF NOT EXISTS identity_usage');
    expect(initPostgres).toContain('CREATE TABLE IF NOT EXISTS cluster_ddns_record');
    expect(initPostgres).toContain('CREATE TABLE IF NOT EXISTS cluster_service_token');
    expect(initPostgres).toContain('CREATE TABLE IF NOT EXISTS cluster_node');
    expect(initPostgres).not.toContain('CREATE TABLE IF NOT EXISTS cluster_ddns_domain');
    expect(initPostgres).not.toContain('CREATE TABLE IF NOT EXISTS cluster_edge_node');
    expect(initPostgres).not.toContain('CREATE TABLE IF NOT EXISTS cluster_edge_node_pod');
    expect(initPostgres).not.toContain('CREATE TABLE IF NOT EXISTS identity_ddns_domain');
    expect(initPostgres).not.toContain('CREATE TABLE IF NOT EXISTS identity_ddns_record');
    expect(initPostgres).not.toContain('CREATE TABLE IF NOT EXISTS identity_service_token');
    expect(initPostgres).not.toContain(`CREATE TABLE IF NOT EXISTS ${legacyEdgeNodeTable}`);
    expect(initPostgres).not.toContain(`CREATE TABLE IF NOT EXISTS ${legacyEdgeNodePodTable}`);
    for (const table of legacyUsageTables) {
      expect(initPostgres).not.toContain(table);
    }
    expect(initPostgres).not.toContain('CREATE TABLE IF NOT EXISTS identity_api_client_credentials');
    expect(initPostgres).not.toContain('client_secret_encrypted');
    expect(initPostgres).not.toContain(legacyRoleTable);
    expect(initPostgres).not.toContain(`CREATE TABLE IF NOT EXISTS ${legacyWebIdProfileTable}`);
    expect(initPostgres).not.toContain('idx_edge_node_account');

    expect(edgeTables).not.toContain('account_id TEXT');
    expect(edgeTables).toContain('ipv4 TEXT');
    expect(edgeTables).toContain('CREATE TABLE IF NOT EXISTS cluster_node');
    expect(edgeTables).not.toContain('CREATE TABLE IF NOT EXISTS cluster_edge_node');
    expect(edgeTables).not.toContain('CREATE TABLE IF NOT EXISTS cluster_edge_node_pod');
    expect(edgeTables).not.toContain(`CREATE TABLE IF NOT EXISTS ${legacyEdgeNodeTable}`);
    expect(edgeTables).not.toContain(`CREATE TABLE IF NOT EXISTS ${legacyEdgeNodePodTable}`);
    expect(edgeTables).not.toContain(legacyOwnerColumn);
    expect(edgeTables).not.toContain(legacyIpv4Column);
  });

  it('keeps default sqlite bootstrap limited to local identity tables', async () => {
    const db = getIdentityDatabase('sqlite::memory:client-credentials-bootstrap');
    const result = await executeQuery<{ name: string }>(
      db,
      sql`SELECT name FROM sqlite_master WHERE type = 'table'`,
    );
    const tableNames = result.rows.map((row) => row.name);

    expect(tableNames).not.toContain('identity_api_client_credentials');
    expect(tableNames).not.toContain('api_client_credentials');
    expect(tableNames).not.toContain('cluster_ddns_domain');
    expect(tableNames).not.toContain('cluster_ddns_record');
    expect(tableNames).not.toContain('cluster_service_token');
    expect(tableNames).not.toContain('cluster_node');
    expect(tableNames).not.toContain('cluster_edge_node');
    expect(tableNames).not.toContain('cluster_edge_node_pod');
    expect(tableNames).not.toContain(legacyEdgeNodeTable);
    expect(tableNames).not.toContain(legacyEdgeNodePodTable);
    expect(tableNames).not.toContain(legacyRoleTable);
    expect(tableNames.filter((name) => name.includes('usage'))).toEqual([ 'identity_usage' ]);
  });

  it('creates Cloud cluster tables only when the Cloud cluster bootstrap is requested', async () => {
    const db = getIdentityDatabase('sqlite::memory:cluster-bootstrap');
    await ensureCloudClusterTables(db);

    const result = await executeQuery<{ name: string }>(
      db,
      sql`SELECT name FROM sqlite_master WHERE type = 'table'`,
    );
    const tableNames = result.rows.map((row) => row.name);

    expect(tableNames).toContain('cluster_ddns_record');
    expect(tableNames).toContain('cluster_service_token');
    expect(tableNames).toContain('cluster_node');
    expect(tableNames).not.toContain('cluster_ddns_domain');
    expect(tableNames).not.toContain('cluster_edge_node');
    expect(tableNames).not.toContain('cluster_edge_node_pod');
  });

  it('deduplicates concurrent Cloud cluster bootstrap calls for one database connection', async () => {
    const executeCalls: unknown[] = [];
    const db = {
      execute: async (query: unknown) => {
        executeCalls.push(query);
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { rows: [] };
      },
    };

    await Promise.all([
      ensureCloudClusterTables(db),
      ensureCloudClusterTables(db),
      ensureCloudClusterTables(db),
    ]);

    expect(executeCalls).toHaveLength(8);
  });
});
