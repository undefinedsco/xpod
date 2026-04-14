import { beforeEach, describe, expect, it } from 'vitest';
import { getIdentityDatabase } from '../../src/identity/drizzle/db';
import { DdnsRepository } from '../../src/identity/drizzle/DdnsRepository';

describe('DdnsRepository', () => {
  beforeEach(() => {
    // sqlite::memory: creates a fresh isolated identity db per test process
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
});
