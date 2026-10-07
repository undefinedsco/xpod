/**
 * B56 tests-only baseline (corrected) for the source-server conditional ACL/ACR primitive.
 *
 * Encodes the intended, root-accepted contract from
 * `root-review/conditional-auth-auxiliary-primitive-design.md`. It drives the **actual production
 * `SubgraphSparqlHttpHandler`** with the **real CSS `AuthAuxiliaryReader`** over the real
 * `ComposedAuxiliaryStrategy(SuffixAuxiliaryIdentifierStrategy(...))` and the **real
 * `PermissionBasedAuthorizer`**. The only fake is the unit-level underlying policy fact source and
 * the in-memory native/lock stubs, which are clearly substitutes for a real Pod/native engine.
 *
 * No product/SDK/config edits. The conditional ACL primitive is not implemented yet, so the
 * positive ACL cases are expected to fail now with a meaningful assertion once the fixture is valid.
 *
 * B56 correctness notes (from the native review):
 * - `IdentifierSetMultiMap` default iteration yields `[identifier, singleModeString]`; the correct
 *   accessor is `entrySets()` yielding `[identifier, Set<string>]`. Both the reader and the real
 *   `PermissionBasedAuthorizer` use `entrySets()`; the fixture does too.
 * - Positives provide a legitimate prepared native `updateAuthority` and a shared locker with
 *   `withWriteLockAndReadDependencies`; the "missing dependency" negatives explicitly omit exactly
 *   one of them so the positive/negative differ only by the dependency under test.
 */
import { describe, expect, it, vi } from 'vitest';
import { Parser } from 'sparqljs';
import {
  AuthAuxiliaryReader,
  ComposedAuxiliaryStrategy,
  ForbiddenHttpError,
  GreedyReadWriteLocker,
  IdentifierMap,
  IdentifierSetMultiMap,
  MemoryMapStorage,
  MemoryResourceLocker,
  PermissionBasedAuthorizer,
  SingleRootIdentifierStrategy,
  SuffixAuxiliaryIdentifierStrategy,
  type Authorizer,
  type PermissionReader,
  type ResourceIdentifier,
} from '@solid/community-server';
import { ACL, PERMISSIONS } from '@solidlab/policy-engine';
import { SubgraphSparqlHttpHandler } from '../../src/http/SubgraphSparqlHttpHandler';
import { HierarchicalReadWriteLocker } from '../../src/storage/HierarchicalReadWriteLocker';
import { metadataRequestContext } from '../../src/storage/MetadataRequestContext';
import { authoritySnapshotContext, captureAuthorityDependency } from '../../src/storage/AuthoritySnapshotContext';
import { authorityResourceTracker } from '../../src/storage/AuthorityResourceTracker';

const base = 'http://localhost:3000/authority-boundary/';
const chat = `${base}room.ttl#this`;
const chatDocument = `${base}room.ttl`;
const acl = `${base}room.ttl.acl`;
const acr = `${base}room.ttl.acr`;
const otherSibling = `${base}private/unrelated.ttl`;
const webId = `${base}profile/card#me`;

/** The ordinary modes a readable scope may grant; Control is the ACL-write gate. */
const READABLE_MODES = [ PERMISSIONS.Read, PERMISSIONS.Append, PERMISSIONS.Delete, PERMISSIONS.Modify, PERMISSIONS.Create ];

/**
 * A SPARQL update whose single write graph is exactly one ACL, with a fixed canonical Chat guard
 * (READ target) and an explicit NOT EXISTS old-ACL guard. This is the shape the primitive must
 * support; it never writes the Chat and never advances a phase in the same request.
 */
function aclConditionalUpdate(writeGraph = acl): string {
  return `INSERT { GRAPH <${writeGraph}> { <${chat}> <http://www.w3.org/ns/auth/acl#mode> <http://www.w3.org/ns/auth/acl#Read> } }
WHERE {
  GRAPH <${chatDocument}> { <${chat}> <https://undefineds.co/ns#protocols> ?protocols }
  FILTER NOT EXISTS { GRAPH <${writeGraph}> { <${chat}> <http://www.w3.org/ns/auth/acl#mode> ?old } }
}`;
}

interface HarnessOptions {
  /** Real configured auth auxiliary strategy suffix (WebACL `.acl` or ACP `.acr`). */
  authSuffix?: string;
  /** Whether the subject resource grants Control (the ACL-write gate). */
  subjectControl?: boolean;
  /** Finite candidate inventory the engine reports; the fixed branch must not enumerate it. */
  listGraphs?: () => Promise<Set<string>>;
  /**
   * Prepared native authority. `'prepared'` (default) installs a legitimate prepared Mix stub;
   * `'absent'` omits it so the primitive must refuse before mutating.
   */
  updateAuthority?: 'prepared' | 'absent';
  /**
   * Shared scope locker. `'shared'` (default) provides `withWriteLockAndReadDependencies`;
   * `'write-only'` omits it so the primitive must refuse before mutating.
   */
  locks?: 'shared' | 'write-only';
  /** Records every (identifier, modes) the underlying reader is asked about. */
  observed?: { path: string; modes: string[] }[];
}

/**
 * The fake underlying policy fact source. It answers the **real CSS permission map schema**
 * (`{ [mode]: boolean }`) for the modes the reader asks about, iterating `entrySets()` exactly like
 * the real `AuthAuxiliaryReader`/`PermissionBasedAuthorizer`. This is a unit substitute for a real
 * ACL/ACR read — not a Pod or cross-document proof.
 */
function fakePolicyFacts(options: HarnessOptions) {
  return {
    handleSafe: vi.fn(async ({ requestedModes }: { requestedModes: IdentifierSetMultiMap<string> }) => {
      const result = new IdentifierMap<Record<string, boolean>>();
      for (const [ identifier, modes ] of requestedModes.entrySets()) {
        options.observed?.push({ path: identifier.path, modes: [ ...modes ] });
        const permissions: Record<string, boolean> = {};
        for (const mode of modes) {
          permissions[mode] = mode === ACL.Control ? options.subjectControl === true : READABLE_MODES.includes(mode);
        }
        result.set(identifier, permissions);
      }
      return result;
    }),
  };
}

type SharedLocker = HierarchicalReadWriteLocker & { calls: { dependencies: string[] }[] };

/**
 * A real shared hierarchical locker whose dependency-plan call is spied but still runs the REAL lock
 * plan, so the current-authority `hasHeldReadLock` coverage behaves exactly as production. Production
 * now requires an actual `HierarchicalReadWriteLocker` instance, and the plan must really be held for
 * the fresh attempt; `beforeLock` runs before any lock is acquired so a test can force staleness.
 */
function sharedLocker(beforeLock?: () => Promise<void>): SharedLocker {
  const calls: { dependencies: string[] }[] = [];
  const locker = new HierarchicalReadWriteLocker(
    new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage()),
    new SingleRootIdentifierStrategy(base),
  );
  const real = locker.withWriteLockAndReadDependencies.bind(locker);
  vi.spyOn(locker, 'withWriteLockAndReadDependencies').mockImplementation(async(
    identifier: ResourceIdentifier,
    dependencies: readonly ResourceIdentifier[],
    whileLocked: (maintainLock: () => void) => unknown,
  ) => {
    calls.push({ dependencies: dependencies.map(dependency => dependency.path) });
    if (beforeLock) await beforeLock();
    return await real(identifier, dependencies, whileLocked);
  });
  (locker as SharedLocker).calls = calls;
  return locker as SharedLocker;
}

/** A legitimate unit substitute for the prepared native Mix authority. */
function preparedNativeAuthority() {
  const calls: { query: string; baseIri?: string; accessScope?: { allowedGraphUrls?: string[] } }[] = [];
  return {
    calls,
    executeSparqlUpdate: vi.fn(async(
      query: string,
      baseIri?: string,
      accessScope?: { allowedGraphUrls?: string[] },
    ) => { calls.push({ query, baseIri, accessScope }); }),
  };
}

/** A locker that only offers the ordinary `withWriteLock`, missing the read-dependency variant. */
function writeOnlyLocker() {
  return { withWriteLock: vi.fn(async(_identifier: unknown, task: () => Promise<void>) => task()) };
}

/**
 * Build the actual production handler. The constructor is the current 8-argument one; a future DI
 * argument (the aux identifier strategy) is appended via `Reflect.construct`, so the handler
 * instance and the code path it runs are the real production ones.
 */
function buildHandler(options: HarnessOptions = {}) {
  const underlyingReader = fakePolicyFacts(options);
  const authStrategy = new ComposedAuxiliaryStrategy(
    new SuffixAuxiliaryIdentifierStrategy(options.authSuffix ?? '.acl'),
    undefined,
    undefined,
    true,
    true,
  );
  const permissionReader = new AuthAuxiliaryReader(underlyingReader as unknown as PermissionReader, authStrategy as never);
  const authorizer: Authorizer = new PermissionBasedAuthorizer();
  const engine = {
    listGraphs: vi.fn(options.listGraphs ?? (async() => new Set([ chatDocument, acl ]))),
    queryVoid: vi.fn(async() => undefined),
  };
  const credentialsExtractor = { handleSafe: async() => ({ agent: { webId } }) };
  // Always build the spies so callers can assert on them, but only wire them in when the mode asks
  // for the dependency under test. This keeps the positive/negative inputs identical except for the
  // one missing dependency.
  const nativeAuthority = preparedNativeAuthority();
  const locker = sharedLocker();
  const updateAuthority = options.updateAuthority === 'absent' ? undefined : nativeAuthority;
  const locks = options.locks === 'write-only' ? writeOnlyLocker() : locker;
  const handler = Reflect.construct(SubgraphSparqlHttpHandler, [
    engine,
    credentialsExtractor,
    permissionReader,
    authorizer,
    {},
    updateAuthority,
    undefined,
    locks,
    authStrategy,
  ]) as SubgraphSparqlHttpHandler;
  return { handler, engine, permissionReader, underlyingReader, authStrategy, authorizer, nativeAuthority, locker };
}

function run(handler: SubgraphSparqlHttpHandler, query: string) {
  const request: any = {};
  const response: any = { setHeader: vi.fn(), end: vi.fn(), statusCode: 0 };
  return (handler as any).executeUpdate({
    basePath: '/authority-boundary/', baseUrl: base, query, method: 'POST',
    origin: 'http://localhost:3000', defaultDataset: 'scopedUnion', ingressBytes: query.length,
  }, new Parser({ baseIRI: base }).parse(query), request, response, undefined)
    .then(() => response);
}

describe('real CSS AuthAuxiliaryReader + PermissionBasedAuthorizer mapping (fixture validity)', () => {
  /** Directly prove the real reader/authorizer mapping, independent of the missing handler feature. */
  async function authorizeAclWrite(subjectControl: boolean) {
    const authStrategy = new ComposedAuxiliaryStrategy(
      new SuffixAuxiliaryIdentifierStrategy('.acl'),
      undefined,
      undefined,
      true,
      true,
    );
    const facts = {
      handleSafe: async ({ requestedModes }: { requestedModes: IdentifierSetMultiMap<string> }) => {
        const result = new IdentifierMap<Record<string, boolean>>();
        for (const [ identifier, modes ] of requestedModes.entrySets()) {
          const permissions: Record<string, boolean> = {};
          for (const mode of modes) {
            permissions[mode] = mode === ACL.Control ? subjectControl : READABLE_MODES.includes(mode);
          }
          result.set(identifier, permissions);
        }
        return result;
      },
    };
    const reader = new AuthAuxiliaryReader(facts as unknown as PermissionReader, authStrategy as never);
    const authorizer: Authorizer = new PermissionBasedAuthorizer();
    const requestedModes = new IdentifierSetMultiMap<string>();
    requestedModes.add({ path: acl }, PERMISSIONS.Append);
    const availablePermissions = await reader.handleSafe({ credentials: { agent: { webId } }, requestedModes });
    await authorizer.handleSafe({ credentials: { agent: { webId } }, requestedModes, availablePermissions });
  }

  it('allows an ACL Append when Control is granted on the subject', async() => {
    await expect(authorizeAclWrite(true)).resolves.toBeUndefined();
  });

  it('refuses an ACL Append with an explicit Forbidden when Control is absent', async() => {
    await expect(authorizeAclWrite(false)).rejects.toBeInstanceOf(ForbiddenHttpError);
  });
});

describe('conditional auth auxiliary primitive — WebACL real CSS strategy', () => {
  it('maps Control on the subject to Read/Write on a `.acl` and allows the ACL write', async() => {
    const { handler, nativeAuthority, engine } = buildHandler({ subjectControl: true });
    const response = await run(handler, aclConditionalUpdate());
    expect(response.statusCode).toBe(204);
    // The primitive commits through the prepared native authority, never an unlocked queryVoid.
    expect((nativeAuthority.executeSparqlUpdate as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    expect(engine.queryVoid).not.toHaveBeenCalled();
  });

  it('refuses a `.acl` write when the caller has no Control on the subject', async() => {
    const observed: { path: string; modes: string[] }[] = [];
    const { handler, nativeAuthority, engine } = buildHandler({ subjectControl: false, observed });
    await expect(run(handler, aclConditionalUpdate())).rejects.toBeInstanceOf(ForbiddenHttpError);
    // The refusal is the real Control mapping: the reader asked for Control on the subject.
    expect(observed.some(entry => entry.path === chatDocument && entry.modes.includes(ACL.Control))).toBe(true);
    expect((nativeAuthority.executeSparqlUpdate as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(engine.queryVoid).not.toHaveBeenCalled();
  });

  it('treats an ACP `.acr` write the same way through its own auxiliary strategy', async() => {
    const { handler, nativeAuthority } = buildHandler({ authSuffix: '.acr', subjectControl: true });
    const response = await run(handler, aclConditionalUpdate(acr));
    expect(response.statusCode).toBe(204);
    expect((nativeAuthority.executeSparqlUpdate as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
  });
});

describe('conditional auth auxiliary primitive — fixed graph scope and bounded reads', () => {
  it('collects the fixed Chat guard and ACL write as explicit read targets without listing graphs', async() => {
    const listGraphs = vi.fn(async() => new Set([ chatDocument, acl ]));
    const observed: { path: string; modes: string[] }[] = [];
    const { handler, nativeAuthority } = buildHandler({ listGraphs, subjectControl: true, observed });
    const response = await run(handler, aclConditionalUpdate());
    expect(response.statusCode).toBe(204);
    expect((nativeAuthority.executeSparqlUpdate as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    // The underlying reader sees the ACL via its **subject** + Control (the real AuthAuxiliaryReader
    // maps `.acl` -> subject Control); it also sees the fixed Chat guard as a Read target.
    const subjectEntries = observed.filter(entry => entry.path === chatDocument);
    expect(subjectEntries.some(entry => entry.modes.includes(ACL.Control))).toBe(true);
    expect(subjectEntries.some(entry => entry.modes.includes(PERMISSIONS.Read))).toBe(true);
    expect(observed.map(entry => entry.path)).not.toContain(otherSibling);
    expect(listGraphs).not.toHaveBeenCalled();
  });

  it('recurses into a nested NOT EXISTS guard on a third fixed graph', async() => {
    // The innermost graph (`nested.ttl`) appears only in the deepest guard; if recursion is missed it
    // is never read, so observing it proves the nested target was collected.
    const nestedDocument = `${base}nested.ttl`;
    const query = `INSERT { GRAPH <${acl}> { <${chat}> <http://www.w3.org/ns/auth/acl#mode> <http://www.w3.org/ns/auth/acl#Read> } }
WHERE {
  GRAPH <${chatDocument}> { <${chat}> <https://undefineds.co/ns#protocols> ?protocols }
  FILTER NOT EXISTS {
    GRAPH <${acl}> { <${chat}> <http://www.w3.org/ns/auth/acl#mode> ?old }
    FILTER NOT EXISTS { GRAPH <${nestedDocument}> { <${chat}> <http://www.w3.org/ns/auth/acl#agent> ?agent } }
  }
}`;
    const observed: { path: string; modes: string[] }[] = [];
    const { handler } = buildHandler({ subjectControl: true, observed });
    await run(handler, query);
    const nestedReads = observed.filter(entry => entry.path === nestedDocument);
    expect(nestedReads.length).toBeGreaterThan(0);
    expect(nestedReads.some(entry => entry.modes.includes(PERMISSIONS.Read))).toBe(true);
  });

  it('isolates an unreadable, unrelated private sibling from the fixed ACL branch', async() => {
    // The sibling is present in the engine inventory and is unreadable (no Control/Read); a fixed
    // named-graph branch must not enumerate it and so must not fail on it.
    const listGraphs = vi.fn(async() => new Set([ chatDocument, acl, otherSibling ]));
    const observed: { path: string; modes: string[] }[] = [];
    const { handler } = buildHandler({ listGraphs, subjectControl: true, observed });
    const response = await run(handler, aclConditionalUpdate());
    expect(response.statusCode).toBe(204);
    expect(observed.map(entry => entry.path)).not.toContain(otherSibling);
    expect(listGraphs).not.toHaveBeenCalled();
  });

  it('keeps ordinary data writes on the existing compatible behavior', async() => {
    const ordinary = `INSERT DATA { GRAPH <${chatDocument}> { <#e> <#b> "ordinary" } }`;
    // Ordinary data (no conditional ACL write) keeps the historical unlocked engine path.
    const { handler, engine } = buildHandler({ updateAuthority: 'absent' });
    const response = await run(handler, ordinary);
    expect(response.statusCode).toBe(204);
    expect(engine.queryVoid).toHaveBeenCalledOnce();
  });
});

describe('conditional auth auxiliary primitive — native prepared authority required', () => {
  it('rejects before any native write when the prepared native Mix authority is absent', async() => {
    const { handler, engine } = buildHandler({ subjectControl: true, updateAuthority: 'absent' });
    await expect(run(handler, aclConditionalUpdate())).rejects.toThrow();
    expect(engine.queryVoid).not.toHaveBeenCalled();
  });

  it('rejects before mutation when the shared locker lacks withWriteLockAndReadDependencies', async() => {
    const { handler, nativeAuthority } = buildHandler({ subjectControl: true, locks: 'write-only' });
    await expect(run(handler, aclConditionalUpdate())).rejects.toThrow();
    expect((nativeAuthority.executeSparqlUpdate as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('keeps the authority snapshot active while collecting the fixed ACL permission dependencies', async() => {
    const seen: unknown[] = [];
    const built = buildHandler({ subjectControl: true });
    const original = built.underlyingReader.handleSafe.getMockImplementation()!;
    built.underlyingReader.handleSafe.mockImplementation(async (input: any) => {
      seen.push(authoritySnapshotContext.getStore());
      return await original(input);
    });
    await run(built.handler, aclConditionalUpdate());
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(state => state !== undefined)).toBe(true);
  });

  it('records the captured ACL authority dependency in the snapshot', async() => {
    const dependencies: string[][] = [];
    const built = buildHandler({ subjectControl: true });
    const original = built.underlyingReader.handleSafe.getMockImplementation()!;
    built.underlyingReader.handleSafe.mockImplementation(async (input: any) => {
      captureAuthorityDependency(acl, chatDocument);
      const state = authoritySnapshotContext.getStore();
      if (state) dependencies.push([ ...state.dependencies.keys() ]);
      return await original(input);
    });
    await run(built.handler, aclConditionalUpdate());
    expect(dependencies.some(keys => keys.includes(acl))).toBe(true);
  });

  it('reauthorizes with a fresh permission cache when the tracked ACL changes in the lock window', async() => {
    // Deterministic auth-complete / lock-before window: the first lock acquisition mutates the ACL
    // authority the authorization depended on, so the attempt must be stale, reauthorized with a
    // fresh cache, and never commit the stale authorization.
    const permissionCaches: unknown[] = [];
    const nativeAuthority = preparedNativeAuthority();
    const firstWindow = { used: false };
    const locker = sharedLocker(async() => {
      if (!firstWindow.used) {
        firstWindow.used = true;
        await authorityResourceTracker.runMutation(acl, async() => undefined);
      }
    });
    const built = buildHandler({ subjectControl: true });
    const original = built.underlyingReader.handleSafe.getMockImplementation()!;
    built.underlyingReader.handleSafe.mockImplementation(async (input: any) => {
      permissionCaches.push(metadataRequestContext.getStore()?.metadataCache);
      captureAuthorityDependency(acl, chatDocument);
      return await original(input);
    });
    const handler = Reflect.construct(SubgraphSparqlHttpHandler, [
      built.engine,
      { handleSafe: async() => ({ agent: { webId } }) },
      built.permissionReader,
      built.authorizer,
      {},
      nativeAuthority,
      undefined,
      locker,
      built.authStrategy,
    ]) as SubgraphSparqlHttpHandler;
    await run(handler, aclConditionalUpdate());
    // Every retried authorization attempt gets its own fresh permission cache, so the stale first
    // window and the retried windows never share one cache object.
    expect(new Set(permissionCaches).size).toBeGreaterThanOrEqual(2);
    // The committed write happened once, under a fresh (second-window) authorization.
    expect(nativeAuthority.executeSparqlUpdate).toHaveBeenCalledOnce();
    expect(locker.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('uses a fresh permission metadata cache, consistent within one authorization attempt', async() => {
    const permissionCaches: unknown[] = [];
    const built = buildHandler({ subjectControl: true });
    const original = built.underlyingReader.handleSafe.getMockImplementation()!;
    built.underlyingReader.handleSafe.mockImplementation(async (input: any) => {
      permissionCaches.push(metadataRequestContext.getStore()?.metadataCache);
      return await original(input);
    });
    await run(built.handler, aclConditionalUpdate());
    expect(permissionCaches.length).toBeGreaterThan(0);
    // Every permission read sees a metadata cache (the fresh per-attempt window) …
    expect(permissionCaches.every(cache => cache !== undefined)).toBe(true);
    // … and reads are grouped by their per-attempt window: the dependency-discovery attempt and the
    // in-lock fresh attempt each use exactly one cache object across all of their reads.
    expect(new Set(permissionCaches).size).toBe(2);
  });

  it('commits the fixed ACL write under the shared lock with finite read dependencies', async() => {
    const observed: { path: string; modes: string[] }[] = [];
    const { handler, locker, nativeAuthority } = buildHandler({ subjectControl: true, observed });
    const response = await run(handler, aclConditionalUpdate());
    expect(response.statusCode).toBe(204);
    expect(nativeAuthority.executeSparqlUpdate).toHaveBeenCalledOnce();
    expect(locker.withWriteLockAndReadDependencies).toHaveBeenCalledOnce();
    // The native commit receives the finite scope: the explicit read graphs plus the ACL write graph,
    // never an unbounded whole-inventory read.
    const scope = nativeAuthority.calls[0].accessScope;
    expect(scope?.allowedGraphUrls).toEqual(expect.arrayContaining([ chatDocument, acl ]));
    expect(observed.some(entry => entry.path === chatDocument && entry.modes.includes(ACL.Control))).toBe(true);
  });

  it('reads the innermost third guard graph and passes it in the native finite scope', async() => {
    const nestedDocument = `${base}nested.ttl`;
    const query = `INSERT { GRAPH <${acl}> { <${chat}> <http://www.w3.org/ns/auth/acl#mode> <http://www.w3.org/ns/auth/acl#Read> } }
WHERE {
  GRAPH <${chatDocument}> { <${chat}> <https://undefineds.co/ns#protocols> ?protocols }
  FILTER NOT EXISTS {
    GRAPH <${acl}> { <${chat}> <http://www.w3.org/ns/auth/acl#mode> ?old }
    FILTER NOT EXISTS { GRAPH <${nestedDocument}> { <${chat}> <http://www.w3.org/ns/auth/acl#agent> ?agent } }
  }
}`;
    const observed: { path: string; modes: string[] }[] = [];
    const { handler, nativeAuthority } = buildHandler({ subjectControl: true, observed });
    const response = await run(handler, query);
    expect(response.statusCode).toBe(204);
    // The innermost fixed graph is genuinely read-authorized (not merely parsed).
    expect(observed.some(entry => entry.path === nestedDocument && entry.modes.includes(PERMISSIONS.Read))).toBe(true);
    // …and it is among the finite native allowed graphs.
    expect(nativeAuthority.calls[0].accessScope?.allowedGraphUrls).toContain(nestedDocument);
  });
});

describe('conditional auth auxiliary primitive — unsupported shapes fail closed', () => {
  const validGuard = aclConditionalUpdate();
  expect(validGuard).toContain('room.ttl.acl');

  it('refuses a variable-GRAPH shape as a conditional ACL write while Control is granted', async() => {
    const variableGuard = `INSERT { GRAPH <${acl}> { <${chat}> <http://www.w3.org/ns/auth/acl#mode> <http://www.w3.org/ns/auth/acl#Read> } }
WHERE { GRAPH ?g { <${chat}> <https://undefineds.co/ns#protocols> ?protocols } }`;
    const { handler, engine, nativeAuthority } = buildHandler({ subjectControl: true });
    await expect(run(handler, variableGuard)).rejects.toThrow();
    expect((nativeAuthority.executeSparqlUpdate as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(engine.queryVoid).not.toHaveBeenCalled();
  });

  it('refuses a default-graph read in the ACL conditional guard while Control is granted', async() => {
    const defaultGraphGuard = `INSERT { GRAPH <${acl}> { <${chat}> <http://www.w3.org/ns/auth/acl#mode> <http://www.w3.org/ns/auth/acl#Read> } }
WHERE { <${chat}> <https://undefineds.co/ns#protocols> ?protocols }`;
    const { handler, nativeAuthority } = buildHandler({ subjectControl: true });
    await expect(run(handler, defaultGraphGuard)).rejects.toThrow();
    expect((nativeAuthority.executeSparqlUpdate as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('refuses a SERVICE/subquery shape in the ACL conditional guard while Control is granted', async() => {
    const serviceGuard = `INSERT { GRAPH <${acl}> { <${chat}> <http://www.w3.org/ns/auth/acl#mode> <http://www.w3.org/ns/auth/acl#Read> } }
WHERE {
  GRAPH <${chatDocument}> { <${chat}> <https://undefineds.co/ns#protocols> ?protocols }
  SERVICE <http://evil.example/sparql> { ?s ?p ?o }
}`;
    const subqueryGuard = `INSERT { GRAPH <${acl}> { <${chat}> <http://www.w3.org/ns/auth/acl#mode> <http://www.w3.org/ns/auth/acl#Read> } }
WHERE {
  GRAPH <${chatDocument}> { <${chat}> <https://undefineds.co/ns#protocols> ?protocols }
  { SELECT ?s WHERE { GRAPH <${chatDocument}> { ?s ?p ?o } } }
}`;
    const { handler, nativeAuthority } = buildHandler({ subjectControl: true });
    for (const query of [ serviceGuard, subqueryGuard ]) {
      await expect(run(handler, query), query).rejects.toThrow();
    }
    expect((nativeAuthority.executeSparqlUpdate as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
