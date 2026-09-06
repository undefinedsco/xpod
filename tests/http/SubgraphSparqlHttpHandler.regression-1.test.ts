import { describe, expect, it, vi } from 'vitest';
import { IdentifierSetMultiMap, type Credentials } from '@solid/community-server';
import { SubgraphSparqlHttpHandler } from '../../src/http/SubgraphSparqlHttpHandler';

// Regression: authorization scopes must not survive client changes or policy revocation.
// Found during Guangzhou pre-deployment review on 2026-09-07.
describe('SPARQL request authorization isolation', () => {
  const base = 'https://pod.example/alice/';
  const graph = `${base}private.ttl`;
  const owner = { agent: { webId: `${base}profile#me` } };

  function harness() {
    let revoked = false;
    const permissionReader = { handleSafe: vi.fn(async () => new IdentifierSetMultiMap()) };
    const authorizer = {
      handleSafe: vi.fn(async ({ credentials }: { credentials: Credentials }) => {
        if (revoked || credentials.client?.clientId === 'restricted') throw new Error('denied');
      }),
    };
    const handler = new SubgraphSparqlHttpHandler(
      { listGraphs: async () => new Set([graph]) } as any,
      {} as any, permissionReader as any, authorizer as any, {},
    );
    return {
      resolve: (credentials: Credentials) =>
        (handler as any).resolveReadAccessScopeForCredentials(base, credentials),
      revoke: () => { revoked = true; },
      permissionReader,
    };
  }

  it('checks the client even when its WebID is unchanged', async () => {
    const h = harness();
    expect((await h.resolve({ ...owner, client: { clientId: 'trusted' } })).deniedGraphUrls).toBeUndefined();
    expect((await h.resolve({ ...owner, client: { clientId: 'restricted' } })).deniedGraphUrls).toEqual([graph]);
    expect(h.permissionReader.handleSafe).toHaveBeenCalledTimes(2);
  });

  it('rechecks policy immediately after revocation', async () => {
    const h = harness();
    await h.resolve(owner);
    h.revoke();
    expect((await h.resolve(owner)).deniedGraphUrls).toEqual([graph]);
  });

  it('does not share concurrent authorization work across clients', async () => {
    const h = harness();
    const [allowed, denied] = await Promise.all([
      h.resolve({ ...owner, client: { clientId: 'trusted' } }),
      h.resolve({ ...owner, client: { clientId: 'restricted' } }),
    ]);
    expect(allowed.deniedGraphUrls).toBeUndefined();
    expect(denied.deniedGraphUrls).toEqual([graph]);
  });
});
