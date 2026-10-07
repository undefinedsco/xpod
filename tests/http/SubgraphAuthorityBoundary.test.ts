import { describe, expect, it, vi } from 'vitest';
import { Parser } from 'sparqljs';
import { ForbiddenHttpError, RepresentationMetadata, GreedyReadWriteLocker, MemoryMapStorage, MemoryResourceLocker, SingleRootIdentifierStrategy } from '@solid/community-server';
import { HierarchicalReadWriteLocker } from '../../src/storage/HierarchicalReadWriteLocker';
import { PERMISSIONS } from '@solidlab/policy-engine';
import { SubgraphSparqlHttpHandler } from '../../src/http/SubgraphSparqlHttpHandler';
import { metadataRequestContext } from '../../src/storage/MetadataRequestContext';
import { authoritySnapshotContext, captureAuthorityDependency } from '../../src/storage/AuthoritySnapshotContext';
import { authorityResourceTracker } from '../../src/storage/AuthorityResourceTracker';

const base = 'http://localhost:3000/authority-boundary/';
const graph = `${base}message.ttl`;
const update = `INSERT { GRAPH <${graph}> { <#event> <#body> "new" } }
WHERE { FILTER NOT EXISTS { GRAPH ?existing { <#event> <#body> ?body } } }`;

function harness(permissionReader: unknown, authorizer: unknown, listGraphs: () => Promise<Set<string>>) {
  const engine = { listGraphs: vi.fn(listGraphs), queryVoid: vi.fn(async () => undefined) };
  const handler = new SubgraphSparqlHttpHandler(engine as any, {
    handleSafe: async () => ({ agent: { webId: `${base}profile/card#me` } }),
  } as any, permissionReader as any, authorizer as any, {}, undefined, undefined,
  new HierarchicalReadWriteLocker(new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage<number>()),
    new SingleRootIdentifierStrategy('http://localhost:3000/')));
  const run = async (query = update) => {
    const request: any = {};
    const response: any = { setHeader: vi.fn(), end: vi.fn() };
    await (handler as any).executeUpdate({
      basePath: '/authority-boundary/', baseUrl: base, query, method: 'POST',
      origin: 'http://localhost:3000', defaultDataset: 'scopedUnion', ingressBytes: query.length,
    }, new Parser({ baseIRI: base }).parse(query), request, response, undefined);
    expect(response.statusCode).toBe(204);
  };
  return { engine, run };
}

describe('strict SPARQL permission collection boundary', () => {
  it('does not carry a warm allowed decision into fresh authorization', async() => {
    const seen = new Set<string>();
    const permissionReader = {handleSafe: async() => {
      const state = authoritySnapshotContext.getStore()!;
      seen.add(state.phase);
      if (state.phase === 'fresh') throw new ForbiddenHttpError('current policy revoked');
      return {};
    }};
    const {engine, run} = harness(permissionReader, {handleSafe: async() => undefined}, async() => new Set([graph]));
    await expect(run()).rejects.toThrow('current policy revoked');
    expect([...seen]).toEqual(['discovery', 'fresh']);
    expect(engine.queryVoid).not.toHaveBeenCalled();
  });

  it('does not turn an uncovered dependency into a filtered denied graph', async() => {
    const fresh = new Set<unknown>();
    const permissionReader = {handleSafe: async({requestedModes}: any) => {
      const state = authoritySnapshotContext.getStore()!;
      const target = [...requestedModes.keys()][0].path;
      if (state.phase === 'fresh' && target === graph && requestedModes.hasEntry({path:graph}, PERMISSIONS.Read)) {
        fresh.add(state);
        const uri = `http://localhost:3000/uncovered/${fresh.size}`;
        captureAuthorityDependency(`${uri}.acl`, uri);
      }
      return {};
    }};
    const {engine, run} = harness(permissionReader, {handleSafe: async() => undefined}, async() => new Set([graph]));
    await expect(run()).rejects.toThrow('Local authorization changed');
    expect(fresh.size).toBe(3);
    expect(engine.queryVoid).not.toHaveBeenCalled();
  });
  it('expands a newly discovered dependency only after releasing the old plan', async() => {
    let freshAttempts = 0;
    const phases: string[] = [];
    const permissionReader = { handleSafe: async() => {
      const state = authoritySnapshotContext.getStore()!;
      if (!phases.includes(`${state.phase}:${freshAttempts}`)) phases.push(`${state.phase}:${freshAttempts}`);
      captureAuthorityDependency(`${base}.acl`, base);
      if (state.phase === 'fresh') {
        freshAttempts++;
        captureAuthorityDependency('http://localhost:3000/policy/new.acl', 'http://localhost:3000/policy/new');
      }
      return {};
    } };
    const {engine, run} = harness(permissionReader, {handleSafe: async() => undefined}, async() => new Set([graph]));
    await run();
    expect(freshAttempts).toBeGreaterThan(1);
    expect(engine.queryVoid).toHaveBeenCalledOnce();
    expect(phases[0]).toBe('discovery:0');
  });

  it('exhausts three plans without a native mutation when dependencies keep growing', async() => {
    const freshStates = new Set<unknown>();
    const permissionReader = { handleSafe: async() => {
      const state = authoritySnapshotContext.getStore()!;
      if (state.phase === 'fresh') {
        freshStates.add(state);
        const uri = `http://localhost:3000/policy/new-${freshStates.size}`;
        captureAuthorityDependency(`${uri}.acl`, uri);
      }
      return {};
    } };
    const {engine, run} = harness(permissionReader, {handleSafe: async() => undefined}, async() => new Set([graph]));
    await expect(run()).rejects.toThrow('Local authorization changed');
    expect(freshStates.size).toBe(3);
    expect(engine.queryVoid).not.toHaveBeenCalled();
  });
  it('collects permission reads without collecting inventory or the native mutation', async () => {
    const states: NonNullable<ReturnType<typeof authoritySnapshotContext.getStore>>[] = [];
    const permissionReader = { handleSafe: vi.fn(async () => {
      const state = authoritySnapshotContext.getStore();
      expect(state).toBeDefined();
      states.push(state!);
      captureAuthorityDependency(`${base}.acl`, base);
      return {};
    }) };
    const authorizer = { handleSafe: vi.fn(async () => {
      expect(authoritySnapshotContext.getStore()).toBe(states[states.length - 1]);
    }) };
    const { engine, run } = harness(permissionReader, authorizer, async () => {
      expect(authoritySnapshotContext.getStore(), 'inventory is ordinary data, not a permission dependency').toBeUndefined();
      captureAuthorityDependency(`${base}inventory-only.ttl`, base);
      return new Set([ graph ]);
    });
    engine.queryVoid.mockImplementation(async () => {
      expect(authoritySnapshotContext.getStore()).toBeUndefined();
      captureAuthorityDependency(`${base}native-only.ttl`, base);
    });
    await run();
    expect(engine.queryVoid).toHaveBeenCalledOnce();
    expect(states.length).toBeGreaterThan(0);
    const unique = [...new Set(states)];
    expect(unique.map(state => state.phase)).toEqual(['discovery', 'fresh']);
    for (const state of unique) expect([ ...state.dependencies.keys() ]).toEqual([ `${base}.acl` ]);
  });

  it('does not reuse an inventory metadata miss after that ACL has been created', async () => {
    const acl = `${graph}.acl`;
    let created = false;
    const permissionCaches: unknown[] = [];
    const inventoryCaches: unknown[] = [];
    const permissionReader = { handleSafe: vi.fn(async ({ requestedModes }: any) => {
      const state = metadataRequestContext.getStore();
      expect(state).toBeDefined();
      permissionCaches.push(state!.metadataCache);
      const target = [ ...requestedModes.keys() ][0].path;
      if (target !== graph || !requestedModes.hasEntry({ path: graph }, PERMISSIONS.Read)) return { allowed: true };
      captureAuthorityDependency(acl, graph);
      const cached = state!.metadataCache.get(acl);
      if (cached) return { allowed: cached.kind === 'hit' };
      state!.metadataCache.set(acl, created
        ? { kind: 'hit', metadata: new RepresentationMetadata({ path: acl }) }
        : { kind: 'miss' });
      return { allowed: created };
    }) };
    const authorizer = { handleSafe: async ({ availablePermissions }: any) => {
      if (!availablePermissions.allowed) throw new ForbiddenHttpError('Stale metadata miss');
    } };
    const { engine, run } = harness(permissionReader, authorizer, async () => {
      const state = metadataRequestContext.getStore()!;
      inventoryCaches.push(state.metadataCache);
      state.metadataCache.set(acl, { kind: 'miss' });
      if (!created) {
        await authorityResourceTracker.runMutation(acl, async () => { created = true; });
      }
      return new Set([ graph ]);
    });
    await run();
    expect(engine.queryVoid).toHaveBeenCalledOnce();
    expect(new Set(permissionCaches).size).toBeGreaterThanOrEqual(2);
    expect(inventoryCaches.every(cache => !permissionCaches.includes(cache))).toBe(true);
  });

  it('retries a changed authority with fresh permission caches before executing one mutation', async () => {
    const acl = `${base}retry.acl`;
    let changed = false;
    const caches: unknown[] = [];
    const states: unknown[] = [];
    const requestedModes: unknown[] = [];
    const permissionReader = { handleSafe: async (input: any) => {
      captureAuthorityDependency(acl, base);
      caches.push(metadataRequestContext.getStore()!.metadataCache);
      states.push(authoritySnapshotContext.getStore());
      requestedModes.push(input.requestedModes);
      return {};
    } };
    const { engine, run } = harness(permissionReader, { handleSafe: async () => undefined }, async () => {
      if (!changed) {
        await authorityResourceTracker.runMutation(acl, async () => { changed = true; });
      }
      return new Set([ graph ]);
    });
    await run();
    expect(engine.queryVoid).toHaveBeenCalledOnce();
    expect([...new Set(states)].map(state => (state as any).phase)).toEqual(['discovery', 'discovery', 'fresh']);
    expect(new Set(caches).size).toBe(new Set(states).size);
    expect(new Set(requestedModes).size).toBe(requestedModes.length);
  });

  it('keeps ordinary writes outside strict permission collection', async () => {
    const permissionReader = { handleSafe: async () => {
      expect(authoritySnapshotContext.getStore()).toBeUndefined();
      return {};
    } };
    const { engine, run } = harness(permissionReader, { handleSafe: async () => undefined }, async () => new Set());
    await run(`INSERT DATA { GRAPH <${graph}> { <#event> <#body> "ordinary" } }`);
    expect(engine.queryVoid).toHaveBeenCalledOnce();
  });
});
