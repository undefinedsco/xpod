// Independent handler-boundary acceptance. Native and locking transports are unit substitutes;
// this does not prove actual RDF condition evaluation, persistence, or multiple-CSS safety.
import { describe, expect, it, vi } from 'vitest';
import { Parser } from 'sparqljs';
import {
  AuthAuxiliaryReader,
  ComposedAuxiliaryStrategy,
  IdentifierMap,
  GreedyReadWriteLocker,
  MemoryMapStorage,
  MemoryResourceLocker,
  PermissionBasedAuthorizer,
  SingleRootIdentifierStrategy,
  SuffixAuxiliaryIdentifierStrategy,
} from '@solid/community-server';
import { ACL, PERMISSIONS } from '@solidlab/policy-engine';
import { UnsupportedSparqlQueryError } from '../../src/storage/rdf/RdfSparqlBoundary';
import { SubgraphSparqlHttpHandler } from '../../src/http/SubgraphSparqlHttpHandler';
import { captureAuthorityDependency } from '../../src/storage/AuthoritySnapshotContext';
import { authorityResourceTracker } from '../../src/storage/AuthorityResourceTracker';
import { HierarchicalReadWriteLocker } from '../../src/storage/HierarchicalReadWriteLocker';

const base = 'https://pod.example/conditional-root/';
const document = `${base}index.ttl`;
const auxiliary = `${document}.acl`;
const nested = `${base}nested.ttl`;
const policy = `${base}.acl`;
const privateSibling = `${base}private.ttl`;
const subject = `${document}#this`;
const insert = `GRAPH <${auxiliary}> { <${subject}> <urn:test:grant> <https://id.example/bob#me> }`;
const fixed = `GRAPH <${document}> { <${subject}> <urn:test:state> "pending" }`;
const query = `INSERT { ${insert} }
WHERE {
  ${fixed}
  FILTER NOT EXISTS {
    GRAPH <${auxiliary}> { <${subject}> <urn:test:grant> ?old }
    FILTER NOT EXISTS { GRAPH <${nested}> { <${subject}> <urn:test:blocked> ?blocked } }
  }
}`;

function fixture(options: { noNative?: boolean; noDependencyLock?: boolean; revokeBeforeLock?: boolean; noControl?: boolean } = {}) {
  let control = !options.noControl;
  let locked = false;
  let firstWindow = true;
  const entries: { path: string; modes: string[] }[] = [];
  const strategy = new ComposedAuxiliaryStrategy(new SuffixAuxiliaryIdentifierStrategy('.acl'), undefined, undefined, true, true);
  const policyReader = {
    handleSafe: async ({ requestedModes }: any) => {
      captureAuthorityDependency(policy, base);
      const available = new IdentifierMap();
      for (const [ identifier ] of requestedModes.entrySets()) {
        const visible = identifier.path !== privateSibling;
        available.set(identifier, {
          [PERMISSIONS.Read]: visible,
          [PERMISSIONS.Append]: visible,
          [PERMISSIONS.Delete]: visible,
          [PERMISSIONS.Modify]: visible,
          [PERMISSIONS.Create]: visible,
          [ACL.Control]: visible && control,
        });
      }
      return available;
    },
  };
  const reader = new AuthAuxiliaryReader(policyReader as never, strategy);
  const original = reader.handleSafe.bind(reader);
  vi.spyOn(reader, 'handleSafe').mockImplementation(async input => {
    for (const [ identifier, modes ] of input.requestedModes.entrySets()) {
      entries.push({ path: identifier.path, modes: [ ...modes ] });
    }
    return original(input);
  });
  const native = {
    executeSparqlUpdate: vi.fn(async (_query: string, _base?: string, _scope?: { allowedGraphUrls?: string[] }) => {
      expect(locked, 'native mutation must be inside the shared lock').toBe(true);
    }),
  };
  const beforeLock = async () => {
    if (firstWindow && options.revokeBeforeLock) {
      firstWindow = false;
      await authorityResourceTracker.runMutation(policy, async () => { control = false; });
    }
  };
  const enter = async (callback: (maintainLock: () => void) => unknown) => {
    locked = true;
    try { return await callback(() => undefined); } finally { locked = false; }
  };
  const actualLocker = new HierarchicalReadWriteLocker(
    new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage<number>()),
    new SingleRootIdentifierStrategy('https://pod.example/'),
  );
  const originalWrite = actualLocker.withWriteLock.bind(actualLocker);
  const originalPlan = actualLocker.withWriteLockAndReadDependencies.bind(actualLocker);
  vi.spyOn(actualLocker, 'withWriteLock').mockImplementation(async (identifier, callback) => {
    await beforeLock();
    return originalWrite(identifier, () => enter(callback)) as never;
  });
  vi.spyOn(actualLocker, 'withWriteLockAndReadDependencies').mockImplementation(async (identifier, dependencies, callback) => {
    await beforeLock();
    return originalPlan(identifier, dependencies, () => enter(callback)) as never;
  });
  const locker: any = options.noDependencyLock
    ? { withWriteLock: vi.fn((...args: Parameters<typeof actualLocker.withWriteLock>) => actualLocker.withWriteLock(...args)) }
    : actualLocker;
  const engine = {
    listGraphs: vi.fn(async () => new Set([ document, auxiliary, nested, privateSibling ])),
    queryVoid: vi.fn(async () => undefined),
  };
  const handler = Reflect.construct(SubgraphSparqlHttpHandler, [
    engine, { handleSafe: async () => ({ agent: { webId: 'https://id.example/alice#me' } }) },
    reader, new PermissionBasedAuthorizer(), {}, options.noNative ? undefined : native, undefined, locker, strategy,
  ]) as SubgraphSparqlHttpHandler;
  const run = async (text = query) => {
    const response = { setHeader: vi.fn(), end: vi.fn(), statusCode: 0 };
    await (handler as any).executeUpdate({
      basePath: '/conditional-root/', baseUrl: base, query: text, method: 'POST',
      origin: 'https://pod.example', defaultDataset: 'scopedUnion', ingressBytes: text.length,
    }, new Parser({ baseIRI: base }).parse(text), { headers: {}, method: 'POST' }, response, undefined);
    return response;
  };
  const zeroWrites = () => {
    expect(native.executeSparqlUpdate).not.toHaveBeenCalled();
    expect(engine.queryVoid).not.toHaveBeenCalled();
  };
  return { run, entries, native, engine, locker, zeroWrites };
}

describe('independent finite conditional ACL handler boundary', () => {
  it('authorizes exact guard Reads at the real auxiliary-reader entry and sends only their finite graph set to native', async () => {
    const f = fixture();
    expect((await f.run()).statusCode).toBe(204);
    for (const path of [ document, auxiliary, nested ]) {
      expect(f.entries.some(entry => entry.path === path && entry.modes.includes(PERMISSIONS.Read)), path).toBe(true);
    }
    expect(f.entries.map(entry => entry.path)).not.toContain(privateSibling);
    expect(f.engine.listGraphs).not.toHaveBeenCalled();
    expect(f.engine.queryVoid).not.toHaveBeenCalled();
    expect(f.native.executeSparqlUpdate).toHaveBeenCalledOnce();
    expect(new Set(f.native.executeSparqlUpdate.mock.calls[0][2]?.allowedGraphUrls))
      .toEqual(new Set([ document, auxiliary, nested ]));
    expect(f.locker.withWriteLockAndReadDependencies).toHaveBeenCalledOnce();
    expect(f.locker.withWriteLock).not.toHaveBeenCalled();
  });

  it('refuses Control-less ACL writes through the real CSS authorizer', async () => {
    const f = fixture({ noControl: true });
    await expect(f.run()).rejects.toMatchObject({ statusCode: 403 });
    f.zeroWrites();
  });

  it.each([ { noNative: true }, { noDependencyLock: true } ])('refuses missing primitive capability before writes: %j', async options => {
    const f = fixture(options);
    await expect(f.run()).rejects.toBeInstanceOf(UnsupportedSparqlQueryError);
    f.zeroWrites();
  });

  it.each([
    [ 'variable graph', `INSERT { ${insert} } WHERE { GRAPH ?g { <${subject}> <urn:test:state> ?state } }` ],
    [ 'default graph', `INSERT { ${insert} } WHERE { ${fixed} ?s ?p ?o }` ],
    [ 'service', `INSERT { ${insert} } WHERE { ${fixed} SERVICE <https://other.example/sparql> { ?s ?p ?o } }` ],
    [ 'subquery', `INSERT { ${insert} } WHERE { ${fixed} { SELECT ?s WHERE { GRAPH <${nested}> { ?s ?p ?o } } } }` ],
    [ 'multiple write graphs', `INSERT { ${insert} GRAPH <${document}> { <${subject}> <urn:test:state> "done" } } WHERE { ${fixed} }` ],
  ])('refuses unsupported %s before either execution entry', async (_name, text) => {
    const f = fixture();
    await expect(f.run(text)).rejects.toMatchObject({ code: 'rdf.sparql.conditional_acl_unsupported', capability: 'sparql.update.conditional_acl' });
    f.zeroWrites();
    expect(f.engine.listGraphs).not.toHaveBeenCalled();
  });

  it('reauthorizes a policy changed before the lock and never commits with the revoked Control', async () => {
    const f = fixture({ revokeBeforeLock: true });
    await expect(f.run()).rejects.toMatchObject({ statusCode: 403 });
    f.zeroWrites();
  });
});
