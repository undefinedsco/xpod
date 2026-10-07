// Actual file-backed WAC reader and hierarchical locks. Native mutation is counted;
// this does not prove production QLever, Redis, or a running Gateway.
// The actor has WAC Control; this fixture omits the production Pod-owner supplement.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  AuthAuxiliaryReader, BaseAuthorizationManager, BasicRepresentation,
  ComposedAuxiliaryStrategy, GreedyReadWriteLocker, INTERNAL_QUADS,
  MemoryMapStorage, MemoryResourceLocker, NotFoundHttpError,
  PermissionBasedAuthorizer, PolicyEngineReader, SingleRootIdentifierStrategy,
  SuffixAuxiliaryIdentifierStrategy,
} from '@solid/community-server';
import { AclPermissionsEngine, AgentAccessChecker, ManagedWacRepository, WacPolicyEngine } from '@solidlab/policy-engine';
import { Parser } from 'n3';
import { Parser as SparqlParser } from 'sparqljs';
import { SubgraphSparqlHttpHandler } from '../../src/http/SubgraphSparqlHttpHandler';
import { HierarchicalReadWriteLocker } from '../../src/storage/HierarchicalReadWriteLocker';
import { LockingResourceStore } from '../../src/storage/LockingResourceStore';
import { AuthorityResourceTracker, authorityResourceTracker } from '../../src/storage/AuthorityResourceTracker';
import { rdfAccessGraphAllowed, type RdfAccessScope } from '../../src/storage/rdf/RdfAccessScope';

const root = 'https://authority-current.invalid/';
const scope = `${root}room/`;
const document = `${scope}index.ttl`;
const acl = `${scope}.acl`;
const owner = 'https://id.example/alice#me';
const ns = 'http://www.w3.org/ns/auth/acl#';
const policy = (control: boolean, write = true) => `<${acl}#owner> a <${ns}Authorization>;
  <${ns}accessTo> <${scope}>; <${ns}default> <${scope}>;
  <${ns}agent> <${owner}>; <${ns}mode> <${ns}Read>${write ? `, <${ns}Write>` : ''}${control ? `, <${ns}Control>` : ''} .`;
const update = `INSERT { GRAPH <${acl}> { <${acl}#new> <${ns}agent> <https://id.example/bob#me> } }
  WHERE { GRAPH <${document}> { <${document}#this> <urn:test:phase> "pending" } }`;

describe('independent current WAC decision at the locked commit boundary', () => {
  const owned: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(owned.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  });

  async function fixture(revoke: boolean, kind: 'auxiliary' | 'fixed-source' | 'deletewhere' = 'auxiliary', privateSibling = false) {
    const parent = path.resolve('.test-data/current-authority-under-lock');
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(path.join(parent, 'run-'));
    owned.push(directory);
    const file = path.join(directory, 'room.acl');
    const rootAcl = `${root}.acl`;
    const rootFile = path.join(directory, 'root.acl');
    const privateDocument = `${scope}private.ttl`;
    const privateAcl = `${privateDocument}.acl`;
    const privateFile = path.join(directory, 'private.acl');
    await writeFile(privateFile, `<${privateAcl}#reader> a <${ns}Authorization>;
      <${ns}accessTo> <${privateDocument}>; <${ns}agent> <https://id.example/bob#me>;
      <${ns}mode> <${ns}Read> .`);
    // CSS also checks parent Write for Delete on the update's base container.
    // Its actual root policy remains valid while the room-specific permission is revoked.
    await writeFile(rootFile, `<${rootAcl}#controller> a <${ns}Authorization>;
      <${ns}accessTo> <${root}>; <${ns}default> <${root}>;
      <${ns}agent> <${owner}>; <${ns}mode> <${ns}Read>, <${ns}Write>, <${ns}Control> .`);
    const query = kind === 'auxiliary' ? update : kind === 'fixed-source'
      ? `DELETE { GRAPH <${document}> { <${document}#this> <urn:test:phase> "pending" } }
        INSERT { GRAPH <${document}> { <${document}#this> <urn:test:phase> "committed" } }
        WHERE { GRAPH <${document}> { <${document}#this> <urn:test:phase> "pending" } }`
      : `DELETE WHERE { GRAPH <${document}> { <${document}#this> <urn:test:phase> ?phase } }`;
    await writeFile(file, policy(true));
    const identifiers = new SingleRootIdentifierStrategy(root);
    const locks = new HierarchicalReadWriteLocker(
      new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage<number>()), identifiers,
    );
    const strategy = new ComposedAuxiliaryStrategy(new SuffixAuxiliaryIdentifierStrategy('.acl'), undefined, undefined, true, true);
    const reads: { uri: string; insideCommitPlan: boolean }[] = [];
    let insideCommitPlan = false;
    const source = {
      getRepresentation: async (identifier: { path: string }) => {
        reads.push({ uri: identifier.path, insideCommitPlan });
        const policyFile = identifier.path === acl ? file : identifier.path === rootAcl ? rootFile
          : identifier.path === privateAcl ? privateFile : undefined;
        if (!policyFile) throw new NotFoundHttpError('No independent policy here');
        return new BasicRepresentation(Readable.from(new Parser({ baseIRI: identifier.path }).parse(await readFile(policyFile, 'utf8')), { objectMode: true }), INTERNAL_QUADS);
      },
    };
    const store = new LockingResourceStore(source as never, locks, strategy);
    const manager = new BaseAuthorizationManager(identifiers, strategy, store);
    const permissions = new AuthAuxiliaryReader(new PolicyEngineReader(new AclPermissionsEngine(
      new WacPolicyEngine(new AgentAccessChecker(), new ManagedWacRepository(manager)), manager,
    )), strategy);
    const native = { executeSparqlUpdate: vi.fn(async (_query: string, _base?: string,
      _scope?: RdfAccessScope) => undefined) };
    const engine = { listGraphs: vi.fn(async () => new Set(privateSibling ? [ document, privateDocument ] : [ document ])), queryVoid: vi.fn(async () => undefined) };
    const handler = new SubgraphSparqlHttpHandler(engine as never,
      { handleSafe: async () => ({ agent: { webId: owner } }) } as never,
      permissions, new PermissionBasedAuthorizer(), {}, native as never, undefined, locks, strategy);
    const before = authorityResourceTracker.snapshot(acl);
    const otherProcessTracker = new AuthorityResourceTracker();
    const originalLock = locks.withWriteLockAndReadDependencies.bind(locks);
    let changed = false;
    vi.spyOn(locks, 'withWriteLockAndReadDependencies').mockImplementation(async (...args) => {
      if (revoke && !changed) {
        changed = true;
        // B's committed file and tracker are independent of A's process-local generation.
        await otherProcessTracker.runMutation(acl, async () => writeFile(file,
          kind === 'auxiliary' ? policy(false) : policy(true, false)));
      }
      return originalLock(args[0], args[1], async maintainLock => {
        insideCommitPlan = true;
        try { return await args[2](maintainLock); } finally { insideCommitPlan = false; }
      });
    });
    const run = async () => {
      const response = { setHeader: vi.fn(), end: vi.fn(), statusCode: 0 };
      await (handler as any).executeUpdate({ basePath: new URL(scope).pathname, baseUrl: scope,
        query, method: 'POST', origin: root.slice(0, -1), defaultDataset: 'scopedUnion', ingressBytes: query.length },
      new SparqlParser({ baseIRI: scope }).parse(query), { headers: {}, method: 'POST' }, response, undefined);
      return response;
    };
    return { run, native, engine, reads, file, before, otherProcessTracker, privateDocument };
  }

  it('rejects actual Control revocation without relying on the other process generation', async () => {
    const f = await fixture(true);
    await expect(f.run()).rejects.toMatchObject({ statusCode: 403 });
    expect(f.otherProcessTracker.generation(acl)).toBe(1);
    expect(authorityResourceTracker.snapshot(acl)).toEqual(f.before);
    expect(f.native.executeSparqlUpdate).not.toHaveBeenCalled();
    expect(f.engine.queryVoid).not.toHaveBeenCalled();
    expect(await readFile(f.file, 'utf8')).toBe(policy(false));
  });

  it('reads the current policy again under the plan and commits once without self-deadlock', async () => {
    const f = await fixture(false);
    expect((await f.run()).statusCode).toBe(204);
    expect(f.reads.some(read => read.uri === acl && read.insideCommitPlan)).toBe(true);
    expect(f.native.executeSparqlUpdate).toHaveBeenCalledOnce();
    expect(f.engine.queryVoid).not.toHaveBeenCalled();
  });

  it.each([ 'fixed-source', 'deletewhere' ] as const)('rejects ordinary document Write revocation for %s without changing Read', async kind => {
    const f = await fixture(true, kind);
    await expect(f.run()).rejects.toMatchObject({ statusCode: 403 });
    expect(f.otherProcessTracker.generation(acl)).toBe(1);
    expect(authorityResourceTracker.snapshot(acl)).toEqual(f.before);
    expect(f.native.executeSparqlUpdate).not.toHaveBeenCalled();
    expect(f.engine.queryVoid).not.toHaveBeenCalled();
    expect(await readFile(f.file, 'utf8')).toBe(policy(true, false));
  });

  it('recalculates fixed-source conditional permissions under the same lock', async () => {
    const f = await fixture(false, 'fixed-source');
    expect((await f.run()).statusCode).toBe(204);
    expect(f.reads.some(read => read.uri === acl && read.insideCommitPlan)).toBe(true);
    expect(f.native.executeSparqlUpdate).toHaveBeenCalledOnce();
  });

  it('preserves fixed-source visible-dataset behavior when an unrelated sibling is unreadable', async () => {
    const f = await fixture(false, 'fixed-source', true);
    expect((await f.run()).statusCode).toBe(204);
    expect(f.native.executeSparqlUpdate).toHaveBeenCalledOnce();
    const freshScope = f.native.executeSparqlUpdate.mock.calls[0][2];
    expect(freshScope?.basePath).toBe(scope);
    expect(freshScope?.mode).toBe('read');
    expect(rdfAccessGraphAllowed(document, freshScope!)).toBe(true);
    expect(rdfAccessGraphAllowed(f.privateDocument, freshScope!)).toBe(false);
    expect(freshScope?.deniedGraphUrls).toContain(f.privateDocument);
    expect(f.reads.some(read => read.uri === acl && read.insideCommitPlan)).toBe(true);
  });
});
