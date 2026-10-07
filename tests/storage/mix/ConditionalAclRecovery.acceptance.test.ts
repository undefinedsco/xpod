// Actual file/SQLite recovery and production prepared-update adapter with the protocol runtime
// fixture (Comunica evaluator). This is not production-QLever or current-user-Gateway acceptance.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { AuthAuxiliaryReader, BaseAuthorizationManager, BaseIdentifierStrategy, ComposedAuxiliaryStrategy, ExtensionBasedMapper, FileDataAccessor, GreedyReadWriteLocker, IdentifierSetMultiMap, MemoryMapStorage, MemoryResourceLocker, PermissionBasedAuthorizer, PolicyEngineReader, RdfToQuadConverter, SingleRootIdentifierStrategy, SuffixAuxiliaryIdentifierStrategy, guardStream } from '@solid/community-server';
import { AclPermissionsEngine, AgentAccessChecker, ManagedWacRepository, PERMISSIONS, WacPolicyEngine } from '@solidlab/policy-engine';
import { DataFactory, Parser, Store, Writer } from 'n3';
import { QueryEngine } from '@comunica/query-sparql';
import { drizzle } from '@undefineds.co/drizzle-solid';
import { chatResource } from '@undefineds.co/models';
import { MixDataAccessor } from '../../../src/storage/accessors/MixDataAccessor';
import { SolidRdfDataAccessor } from '../../../src/storage/accessors/SolidRdfDataAccessor';
import { SolidRdfEngine } from '../../../src/storage/rdf';
import { LocalQleverNativeSparqlClient } from '../../../src/storage/rdf/LocalQleverNativeSparqlClient';
import { LocalRdfAuthorityRecoveryInitializer, RootedSolidFsSyncJournal } from '../../../src/solidfs';
import { createFakeQleverRuntimeCommand } from '../../helpers/qleverRuntime';
import { encodeSourceBoundRoomId } from '../../../src/api/matrix/canonicalRoomIdentity';
import { SparqlUpdateResourceStore } from '../../../src/storage/SparqlUpdateResourceStore';
import { RepresentationPartialConvertingStore } from '../../../src/storage/RepresentationPartialConvertingStore';
import { LockingResourceStore } from '../../../src/storage/LockingResourceStore';
import { HierarchicalReadWriteLocker } from '../../../src/storage/HierarchicalReadWriteLocker';
import { SubgraphSparqlHttpHandler } from '../../../src/http/SubgraphSparqlHttpHandler';
import { Parser as SparqlParser } from 'sparqljs';

const origin = 'https://acl-recovery.invalid/';
const pod = `${origin}alice/`;
const owner = 'https://id.example/alice#me';
const member = 'https://id.example/bob#me';
const writer = 'https://id.example/carol#me';
const source = chatResource.buildIri(pod, { id: 'native-guard' });
const document = source.split('#')[0];
const scope = document.slice(0, document.lastIndexOf('/') + 1);
const acl = `${document}.acl`;
const ns = 'http://www.w3.org/ns/auth/acl#';
const ownerRule = `${acl}#owner`;
const newRule = `${acl}#new-member`;
const oldAcl = `<${ownerRule}> a <${ns}Authorization>; <${ns}accessTo> <${document}>; <${ns}agent> <${owner}>; <${ns}mode> <${ns}Control>, <${ns}Read>, <${ns}Write> .\n` +
  `<${acl}#member> a <${ns}Authorization>; <${ns}accessTo> <${document}>; <${ns}agent> <${member}>; <${ns}mode> <${ns}Read> .\n` +
  `<${acl}#writer> a <${ns}Authorization>; <${ns}accessTo> <${document}>; <${ns}agent> <${writer}>; <${ns}mode> <${ns}Read>, <${ns}Write> .\n` +
  `<${acl}#unrelated> <urn:test:policy> "preserve" .\n`;
class Identifiers extends BaseIdentifierStrategy {
  public supportsIdentifier(identifier: { path: string }): boolean { return identifier.path.startsWith(origin); }
  public isRootContainer(identifier: { path: string }): boolean { return identifier.path === origin; }
}
async function compileChat(operation: string) {
  const protocols = { matrix: { roomId: encodeSourceBoundRoomId(source), pendingMembership: { operation, phase: 'acl' } } };
  const db = drizzle({ info: { isLoggedIn: true, webId: owner, podUrl: pod }, fetch: async () => { throw new Error('Compile only'); } } as never,
    { disableInteropDiscovery: true, resourcePreparation: 'off', podUrl: pod });
  const query = db.insert(chatResource).values({ id: chatResource.buildId({ id: 'native-guard' }), author: owner,
    participants: [ owner, member ], metadata: { '@id': `${source}/metadata`, memberRoles: { [owner]: 'owner', [member]: 'member' }, protocols },
  } as never).toSPARQL().query;
  const graph = new Store();
  await new QueryEngine().queryVoid(query, { sources: [ graph ], destination: graph });
  const quads = graph.getQuads(null, null, null, null).map(q => DataFactory.quad(q.subject, q.predicate, q.object));
  const edge = quads.find(q => q.object.termType === 'Literal' && q.object.value === JSON.stringify(protocols));
  if (!edge || edge.object.termType !== 'Literal') throw new Error('Actual public protocols term missing');
  const writer = new Writer(); writer.addQuads(quads);
  const text = await new Promise<string>((resolve, reject) => writer.end((error, result) => error ? reject(error) : resolve(result)));
  return { text, edge };
}

describe('independent old ACL recovery and fenced adapter conditions', () => {
  let directory: string;
  let mapper: ExtensionBasedMapper;
  let structured: SolidRdfDataAccessor;
  let accessor: MixDataAccessor;
  let recovery: LocalRdfAuthorityRecoveryInitializer;
  let runtime: ReturnType<typeof createFakeQleverRuntimeCommand>;
  let aclFile: string;
  let chatFile: string;
  let locks: HierarchicalReadWriteLocker;

  function open() {
    const sqlite = path.join(directory, 'rdf.sqlite');
    const client = new LocalQleverNativeSparqlClient({ command: runtime.command, args: [ '--sqlite-path', sqlite ] });
    const engine = new SolidRdfEngine({ index: { path: sqlite }, nativeSparqlClient: client });
    structured = new SolidRdfDataAccessor(engine, new Identifiers());
    accessor = new MixDataAccessor(structured, new FileDataAccessor(mapper));
    return engine;
  }
  beforeEach(async () => {
    const root = path.resolve('.test-data/conditional-acl-recovery');
    await mkdir(root, { recursive: true });
    directory = await mkdtemp(path.join(root, 'run-'));
    const data = path.join(directory, 'data');
    await mkdir(data, { recursive: true });
    mapper = new ExtensionBasedMapper(origin, data);
    locks = new HierarchicalReadWriteLocker(new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage<number>()), new SingleRootIdentifierStrategy(origin));
    runtime = createFakeQleverRuntimeCommand();
    const engine = open();
    await engine.open();
    aclFile = (await mapper.mapUrlToFilePath({ path: acl }, false, 'text/turtle')).filePath;
    chatFile = (await mapper.mapUrlToFilePath({ path: document }, false, 'text/turtle')).filePath;
    await mkdir(path.dirname(aclFile), { recursive: true });
    const rootAcl = `${origin}.acl`;
    const rootAclFile = (await mapper.mapUrlToFilePath({ path: rootAcl }, false, 'text/turtle')).filePath;
    // The real ACL permission adapter also checks parent Write for Delete. Preserve its actual
    // contract by supplying a legitimate inherited root policy rather than an always-allow reader.
    await writeFile(rootAclFile, `<${rootAcl}#owner> a <${ns}Authorization>; <${ns}accessTo> <${origin}>; <${ns}default> <${origin}>; <${ns}agent> <${owner}>; <${ns}mode> <${ns}Control>, <${ns}Read>, <${ns}Write> .\n`);
    await writeFile(aclFile, oldAcl);
    await writeFile(chatFile, (await compileChat('A')).text);
    expect(engine.scan({ pattern: { graph: DataFactory.namedNode(acl) } }).quads).toEqual([]);
    recovery = new LocalRdfAuthorityRecoveryInitializer(new RootedSolidFsSyncJournal(data), accessor, mapper, origin, data);
    await recovery.handle();
    expect(await readFile(aclFile, 'utf8')).toBe(oldAcl);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await recovery?.finalize();
    await structured?.finalize();
    runtime?.cleanup();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  const execute = (query: string) => accessor.executeSparqlUpdate(query, scope, {
    basePath: scope, mode: 'read', allowedGraphUrls: [ document, acl ],
  });
  const grant = (where: string) => `INSERT { GRAPH <${acl}> { <${newRule}> <${ns}agent> <${member}>; <${ns}mode> <${ns}Read> } } WHERE { ${where} }`;
  async function hasNewGrant() {
    return new Parser({ baseIRI: acl }).parse(await readFile(aclFile, 'utf8')).some(q => q.subject.value === newRule);
  }
  async function oldOperationGuard() {
    const { edge } = await compileChat('A');
    const object = edge.object;
    if (object.termType !== 'Literal') throw new Error('Expected literal');
    const literal = `${JSON.stringify(object.value)}^^<${object.datatype.value}>`;
    return `GRAPH <${document}> { <${edge.subject.value}> <${edge.predicate.value}> ${literal} }
FILTER NOT EXISTS { GRAPH <${document}> { <${edge.subject.value}> <${edge.predicate.value}> ?other } FILTER(!sameTerm(?other, ${literal})) }`;
  }

  function currentPermissions() {
    const strategy = new ComposedAuxiliaryStrategy(new SuffixAuxiliaryIdentifierStrategy('.acl'), undefined, undefined, true, true);
    const metadata = new ComposedAuxiliaryStrategy(new SuffixAuxiliaryIdentifierStrategy('.meta'));
    const sourceStore = new SparqlUpdateResourceStore({ accessor, identifierStrategy: new Identifiers(), auxiliaryStrategy: strategy, metadataStrategy: metadata });
    const converter = new RdfToQuadConverter();
    const store = new RepresentationPartialConvertingStore(sourceStore, metadata, { inConverter: converter, outConverter: converter });
    const manager = new BaseAuthorizationManager(new Identifiers(), strategy, new LockingResourceStore(store, locks, strategy));
    const engine = new WacPolicyEngine(new AgentAccessChecker(), new ManagedWacRepository(manager));
    return new AuthAuxiliaryReader(new PolicyEngineReader(new AclPermissionsEngine(engine, manager)), strategy);
  }
  async function authorize(resource: string, webId: string, modes: string[]) {
    const requestedModes = new IdentifierSetMultiMap<string>();
    for (const mode of modes) requestedModes.add({ path: resource }, mode);
    const credentials = { agent: { webId } };
    const availablePermissions = await currentPermissions().handleSafe({ requestedModes, credentials });
    await new PermissionBasedAuthorizer().handleSafe({ requestedModes, credentials, availablePermissions });
  }

  it('obtains owner ACL authority from the recovered file through the actual CSS conversion and WAC reader', async () => {
    await expect(authorize(acl, owner, [ PERMISSIONS.Read, PERMISSIONS.Append, PERMISSIONS.Delete ])).resolves.toBeUndefined();
    expect(await readFile(aclFile, 'utf8')).toBe(oldAcl);
  });

  it.each([ member, writer ])('rejects ACL access for %s despite its actual document permissions', async webId => {
    await expect(authorize(document, webId, [ PERMISSIONS.Read ])).resolves.toBeUndefined();
    if (webId === writer) await expect(authorize(document, webId, [ PERMISSIONS.Append, PERMISSIONS.Modify ])).resolves.toBeUndefined();
    await expect(authorize(acl, webId, [ PERMISSIONS.Read, PERMISSIONS.Append, PERMISSIONS.Delete ])).rejects.toMatchObject({ statusCode: 403 });
    expect(await hasNewGrant()).toBe(false);
    expect(await readFile(aclFile, 'utf8')).toBe(oldAcl);
  });

  it('rechecks actual CSS authority when B removes Control through Mix after A authorized but before A locks', async () => {
    const native = vi.spyOn(accessor, 'executeSparqlUpdate');
    const handler = () => new SubgraphSparqlHttpHandler({} as never,
      { handleSafe: async () => ({ agent: { webId: owner } }) } as never,
      currentPermissions(), new PermissionBasedAuthorizer(), {}, accessor, undefined, locks,
      new SuffixAuxiliaryIdentifierStrategy('.acl'));
    const a = handler(); const b = handler();
    const run = async (instance: SubgraphSparqlHttpHandler, query: string) => {
      await (instance as any).executeUpdate({ basePath: new URL(document).pathname, baseUrl: document,
        query, method: 'POST', origin: origin.slice(0, -1), defaultDataset: 'scopedUnion', ingressBytes: query.length },
      new SparqlParser({ baseIRI: document }).parse(query), { headers: {}, method: 'POST' },
      { setHeader: vi.fn(), end: vi.fn(), statusCode: 0 }, undefined);
    };
    const guard = await oldOperationGuard();
    const revoke = `DELETE { GRAPH <${acl}> { <${ownerRule}> <${ns}mode> <${ns}Control> } } WHERE { ${guard} }`;
    const originalLock = locks.withWriteLockAndReadDependencies.bind(locks);
    vi.spyOn(locks, 'withWriteLockAndReadDependencies').mockImplementationOnce(async (...args) => {
      // A has completed actual permission reads. B performs its own real authorization and
      // commits through the same source lock/native adapter before A may acquire its write plan.
      await run(b, revoke);
      return originalLock(...args);
    });
    const before = await readFile(chatFile, 'utf8');
    await expect(run(a, grant(guard))).rejects.toMatchObject({ statusCode: 403 });
    expect(native).toHaveBeenCalledTimes(1);
    expect(await hasNewGrant()).toBe(false);
    expect(await readFile(chatFile, 'utf8')).toBe(before);
    await expect(authorize(acl, owner, [ PERMISSIONS.Append ])).rejects.toMatchObject({ statusCode: 403 });
  });

  it('recovers old owner/member/unrelated rules, evaluates old-rule guards, and reopens the persisted result', async () => {
    const where = `GRAPH <${acl}> { <${ownerRule}> <${ns}mode> <${ns}Control> }`;
    const unchanged = await readFile(chatFile, 'utf8');
    await execute(grant(where));
    expect(await hasNewGrant()).toBe(true);
    expect(await readFile(chatFile, 'utf8')).toBe(unchanged);
    const quads = new Parser({ baseIRI: acl }).parse(await readFile(aclFile, 'utf8'));
    const old = new Parser({ baseIRI: acl }).parse(oldAcl);
    expect(old.every(q => quads.some(persisted => persisted.equals(q)))).toBe(true);
    await structured.finalize();
    const reopened = open();
    await reopened.open();
    expect(reopened.scan({ pattern: { graph: DataFactory.namedNode(acl) } }).quads.some(q => q.subject.value === newRule)).toBe(true);
    expect(await hasNewGrant()).toBe(true);
  });

  it('does not grant when NOT EXISTS contradicts a recovered old owner rule', async () => {
    await execute(grant(`FILTER NOT EXISTS { GRAPH <${acl}> { <${ownerRule}> <${ns}mode> <${ns}Control> } }`));
    expect(await hasNewGrant()).toBe(false);
    expect(await readFile(aclFile, 'utf8')).toBe(oldAcl);
  });

  it('does not apply old A after canonical B replaced its raw typed protocols term', async () => {
    await accessor.syncLocalRdfDocument({ path: document }, guardStream(Readable.from([ (await compileChat('B')).text ])), 'text/turtle');
    const current = await readFile(chatFile, 'utf8');
    await execute(grant(await oldOperationGuard()));
    expect(await hasNewGrant()).toBe(false);
    expect(await readFile(aclFile, 'utf8')).toBe(oldAcl);
    expect(await readFile(chatFile, 'utf8')).toBe(current);
  });

  it('refuses the A guard when the same protocols predicate also has a different value', async () => {
    const a = await compileChat('A'); const b = await compileChat('B');
    const extra = new Writer(); extra.addQuad(b.edge);
    const extraText = await new Promise<string>((resolve, reject) => extra.end((error, result) => error ? reject(error) : resolve(result)));
    await accessor.syncLocalRdfDocument({ path: document }, guardStream(Readable.from([ a.text + extraText ])), 'text/turtle');
    await execute(grant(await oldOperationGuard()));
    expect(await hasNewGrant()).toBe(false);
    expect(await readFile(aclFile, 'utf8')).toBe(oldAcl);
  });
});
