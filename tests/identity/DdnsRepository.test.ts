import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { getIdentityDatabase } from '../../src/identity/drizzle/db';
import { DdnsRepository } from '../../src/identity/drizzle/DdnsRepository';

const tempDbPaths: string[] = [];

describe('DdnsRepository', () => {
  beforeEach(() => {
    // sqlite::memory: creates a fresh isolated identity db per test process
  });

  afterEach(async () => {
    await Promise.all(tempDbPaths.splice(0).flatMap((path) => [
      rm(path, { force: true }),
      rm(`${path}-wal`, { force: true }),
      rm(`${path}-shm`, { force: true }),
    ]));
  });

  it('supports sqlite identity databases for domain pool and records', async () => {
    const db = getIdentityDatabase('sqlite::memory:');
    const repo = new DdnsRepository(db);

    await repo.addDomain('nodes.undefineds.co', 'cloudflare', 'zone-1');
    const domains = await repo.getActiveDomains();
    expect(domains).toHaveLength(1);
    expect(domains[0].domain).toBe('nodes.undefineds.co');

    const created = await repo.allocateSubdomain({
      subdomain: 'node-1',
      domain: 'nodes.undefineds.co',
      nodeId: 'node-1',
    });

    expect(created.subdomain).toBe('node-1');

    const loaded = await repo.getRecord('node-1');
    expect(loaded).not.toBeNull();
    expect(loaded?.domain).toBe('nodes.undefineds.co');
    expect(loaded?.nodeId).toBe('node-1');
  });

  it('supports storing Cloudflare tunnel cname targets in ddns records', async () => {
    const dbPath = `.test-data/ddns-repo-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`;
    tempDbPaths.push(dbPath);

    const db = getIdentityDatabase(`sqlite:${dbPath}`);
    const repo = new DdnsRepository(db);

    await repo.addDomain('nodes.undefineds.co', 'cloudflare', 'zone-1');
    await repo.allocateSubdomain({
      subdomain: 'node-1',
      domain: 'nodes.undefineds.co',
      nodeId: 'node-1',
      ipAddress: '11111111-2222-4333-8444-555555555555.cfargotunnel.com',
      recordType: 'CNAME',
    });

    const loaded = await repo.getRecord('node-1');
    expect(loaded).not.toBeNull();
    expect(loaded?.recordType).toBe('CNAME');
    expect(loaded?.ipAddress).toBe('11111111-2222-4333-8444-555555555555.cfargotunnel.com');
  });
});
