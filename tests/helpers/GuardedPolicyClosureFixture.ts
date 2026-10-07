// Root-owned acceptance fixture: actual file/SQLite, CSS WAC/ACP, hierarchy locks and
// Mix prepared-update adapter. The native protocol producer uses Comunica;
// this is neither production QLever nor current-user Gateway/DPoP acceptance.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  AuthAuxiliaryReader, AuthorizingHttpHandler, BaseAuthorizationManager, BasicRepresentation,
  BasicETagHandler, BasicResponseWriter, AuxiliaryLinkMetadataWriter, ContentTypeMetadataWriter,
  ChainedConverter, GetOperationHandler, HeadOperationHandler, HttpError, MethodModesExtractor, QuadToRdfConverter,
  ComposedAuxiliaryStrategy, ExtensionBasedMapper, FileDataAccessor,
  GreedyReadWriteLocker, INTERNAL_QUADS, MemoryMapStorage, MemoryResourceLocker,
  PermissionBasedAuthorizer, PolicyEngineReader, RdfToQuadConverter,
  AuxiliaryReader, PathBasedReader, OwnerPermissionReader, ReadDeleteReader,
  RepresentationMetadata, RoutingAuxiliaryStrategy, SingleRootIdentifierStrategy, SuffixAuxiliaryIdentifierStrategy,
  guardStream,
} from '@solid/community-server';
import { ParallelHandler, WaterfallHandler } from 'asynchronous-handlers';
import { AclPermissionsEngine, AgentAccessChecker, AgentClassAccessChecker, ManagedWacRepository, UnionAccessChecker, WacPolicyEngine, AcpPolicyEngine, ManagedAcpRepository } from '@solidlab/policy-engine';
import { DataFactory, Parser, Store, Writer } from 'n3';
import type { Quad, Term } from '@rdfjs/types';
import type { Authorizer, Credentials, DataAccessor, PermissionReader, ResourceIdentifier } from '@solid/community-server';
import { QueryEngine } from '@comunica/query-sparql';
import { drizzle } from '@undefineds.co/drizzle-solid';
import { chatResource } from '@undefineds.co/models';
import { vi } from 'vitest';
import { getIdentityDatabase, executeStatement } from '../../src/identity/drizzle/db';
import { PodLookupRepository } from '../../src/identity/drizzle/PodLookupRepository';
import { getSqliteRuntime } from '../../src/storage/SqliteRuntime';
import { MixDataAccessor } from '../../src/storage/accessors/MixDataAccessor';
import { SolidRdfDataAccessor } from '../../src/storage/accessors/SolidRdfDataAccessor';
import { SolidRdfEngine } from '../../src/storage/rdf';
import { LocalQleverNativeSparqlClient } from '../../src/storage/rdf/LocalQleverNativeSparqlClient';
import { SparqlUpdateResourceStore } from '../../src/storage/SparqlUpdateResourceStore';
import { RepresentationPartialConvertingStore } from '../../src/storage/RepresentationPartialConvertingStore';
import { LockingResourceStore } from '../../src/storage/LockingResourceStore';
import { HierarchicalReadWriteLocker } from '../../src/storage/HierarchicalReadWriteLocker';
import { SubgraphSparqlHttpHandler } from '../../src/http/SubgraphSparqlHttpHandler';
import { GuardedPolicyClosure } from '../../src/storage/GuardedPolicyClosure';
import { LocalRdfAuthorityRecoveryInitializer, RootedSolidFsSyncJournal } from '../../src/solidfs';
import { AgentReadObservation } from '../../src/authorization/AgentReadObservation';
import { ObservationPathBasedReader } from '../../src/authorization/ObservationPathBasedReader';

export const guardedMedia = 'application/vnd.xpod.guarded-sparql-update+json';
const aclNs = 'http://www.w3.org/ns/auth/acl#';

// Independently specified oracle. Do not import the product digest as its own expected value.
function expectedGroundTriples(quads: readonly Quad[]): unknown[] {
  const term = (value: Term): unknown[] => {
    if (value.termType === 'NamedNode') return [ 'NamedNode', value.value ];
    if (value.termType === 'Literal') return [ 'Literal', value.value, value.datatype.value, value.language.toLowerCase() ];
    throw new Error('Root oracle accepts only ground policy terms');
  };
  const entries = [...new Set(quads.map(q => JSON.stringify([ term(q.subject), term(q.predicate), term(q.object) ])))];
  entries.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return entries.map(e => JSON.parse(e));
}
export function expectedGroundDigest(iri: string, quads: readonly Quad[], kind: 'wac' | 'acp' = 'wac'): string {
  return createHash('sha256').update(JSON.stringify([ 'ground-RDF-v1', iri, kind, expectedGroundTriples(quads) ])).digest('hex');
}
export function expectedSourceDigest(sourceIri: string, documentIri: string, quads: readonly Quad[]): string {
  const physical = new URL(sourceIri);
  physical.hash = '';
  if (physical.href !== documentIri) throw new Error('Root source oracle document mismatch');
  for (const quad of quads) {
    if (quad.subject.termType !== 'NamedNode' || quad.predicate.termType !== 'NamedNode'
      || (quad.graph.termType !== 'DefaultGraph'
        && !(quad.graph.termType === 'NamedNode' && quad.graph.value === documentIri))) {
      throw new Error('Root source oracle accepts only the physical ground document');
    }
  }
  return createHash('sha256').update(JSON.stringify([
    'ground-source-v1', sourceIri, documentIri, expectedGroundTriples(quads),
  ])).digest('hex');
}

interface ObservationFixtureOptions {
  disabled?: boolean;
  reader?: (actual: PermissionReader, defaultReader: PermissionReader) => PermissionReader;
  authorizer?: (actual: Authorizer) => Authorizer;
  credentials?: (actual: Credentials) => Credentials;
  routes?: (room: string) => Record<string, PermissionReader>;
  boundArgs?: (actual: ConstructorParameters<typeof AgentReadObservation>) => ConstructorParameters<typeof AgentReadObservation>;
}
interface PolicyMappingOptions {
  podPolicyInsideRoom?: boolean;
  roomPolicyOutsideRoom?: boolean;
  policyKind?: 'wac' | 'acp';
  observation?: ObservationFixtureOptions;
  intercept?: (request: IncomingMessage, response: ServerResponse, url: string) => Promise<boolean> | boolean;
  /** Exercise the actual configured Local journal/mapper/recovery lifecycle. */
  authorityRecovery?: boolean;
  rdfFileDataAccessor?: (options: {
    origin: string;
    rootFilePath: string;
    mapper: ExtensionBasedMapper;
  }) => DataAccessor | Promise<DataAccessor>;
}

export function rootAcpPolicy(iri: string, resource: string, agent: string, modes: string[], options: {deny?: boolean; selfOnly?: boolean; label?: string} = {}): string {
  const acp = 'http://www.w3.org/ns/solid/acp#';
  const prefix = `${iri}#${options.label ?? 'owner'}`;
  return `<${iri}#acr> a <${acp}AccessControlResource>; <${acp}resource> <${resource}>;
    <${acp}accessControl> <${prefix}-control>${options.selfOnly ? '' : `; <${acp}memberAccessControl> <${prefix}-control>`} .
    <${prefix}-control> a <${acp}AccessControl>; <${acp}apply> <${prefix}-policy> .
    <${prefix}-policy> a <${acp}Policy>; <${acp}${options.deny ? 'deny' : 'allow'}> ${modes.map(mode => `<${aclNs}${mode}>`).join(', ')};
      <${acp}anyOf> <${prefix}-matcher> .
    <${prefix}-matcher> a <${acp}Matcher>; <${acp}agent> <${agent}> .`;
}

export async function guardedPolicyClosureFixture<T>(run: (fixture: Awaited<ReturnType<typeof openGuardedFixture>>) => Promise<T>, mapping: PolicyMappingOptions = {}): Promise<T> {
  const parent = path.resolve('.test-data/solid-multiparty-acceptance/provider-b/root-review/guarded-fixtures');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'root-'));
  const cleanup: Array<() => Promise<void> | void> = [];
  try { return await run(await openGuardedFixture(directory, cleanup, mapping)); }
  finally {
    try { for (const close of cleanup.reverse()) await close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
}

async function openGuardedFixture(directory: string, cleanup: Array<() => Promise<void> | void>, mapping: PolicyMappingOptions) {
  const kind = mapping.policyKind ?? 'wac';
  const profile = kind === 'acp' ? 'acp-ground-v1' as const : 'wac-ground-v1' as const;
  let handler: SubgraphSparqlHttpHandler;
  let readHttp: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  const handlerErrors: Array<{ name: string; message: string }> = [];
  const server = createServer((request, response) => {
    const dispatch = () => request.method === 'GET' || request.method === 'HEAD'
      ? readHttp(request, response) : handler.handle({ request: request as never, response: response as never });
    const pending = mapping.intercept ? (async () => {
      if (!await mapping.intercept!(request, response, `http://${request.headers.host}${request.url}`)) await dispatch();
    })() : dispatch();
    void pending.catch(error => {
      handlerErrors.push({ name: error instanceof Error ? error.name : 'unknown', message: String(error instanceof Error ? error.message : error).slice(0, 320) });
      if (!response.headersSent) response.writeHead(HttpError.isInstance(error) ? error.statusCode : 500);
      response.end('Root fixture handler failed');
    });
  });
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing root HTTP listener');
  const origin = `http://127.0.0.1:${address.port}/`;
  const pod = `${origin}alice/`;
  const owner = `${pod}profile/card#me`;
  const source = chatResource.buildIri(pod, { id: 'root-guarded' });
  const document = source.split('#')[0];
  const room = document.slice(0, document.lastIndexOf('/') + 1);
  const identifiers = new SingleRootIdentifierStrategy(origin);
  // A legitimate CSS strategy implementation with actual non-suffix mappings. All store,
  // authorization and guard consumers share it; no fabricated HTTP Link or product escape.
  const mappedPolicies = new Map<string, string>();
  if (mapping.podPolicyInsideRoom) mappedPolicies.set(pod, `${room}pod-authorization-policy.ttl`);
  if (mapping.roomPolicyOutsideRoom) mappedPolicies.set(room, `${pod}policies/actual-room-policy.ttl`);
  const authStrategy = new class extends SuffixAuxiliaryIdentifierStrategy {
    public override getAuxiliaryIdentifier(identifier: ResourceIdentifier): ResourceIdentifier {
      const path = mappedPolicies.get(identifier.path);
      return path ? { path } : super.getAuxiliaryIdentifier(identifier);
    }
    public override isAuxiliaryIdentifier(identifier: ResourceIdentifier): boolean {
      return [...mappedPolicies.values()].includes(identifier.path) || super.isAuxiliaryIdentifier(identifier);
    }
    public override getSubjectIdentifier(identifier: ResourceIdentifier): ResourceIdentifier {
      const match = [...mappedPolicies].find(([, iri]) => iri === identifier.path);
      return match ? { path: match[0] } : super.getSubjectIdentifier(identifier);
    }
  }(kind === 'acp' ? '.acr' : '.acl');
  const metadataStrategy = new ComposedAuxiliaryStrategy(new SuffixAuxiliaryIdentifierStrategy('.meta'));
  const authorizationStrategy = new ComposedAuxiliaryStrategy(authStrategy, undefined, undefined, true, true);
  const auxiliary = new RoutingAuxiliaryStrategy([ authorizationStrategy, metadataStrategy ]);
  const locks = new HierarchicalReadWriteLocker(new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage<number>()), identifiers);
  const command = path.join(directory, 'native-protocol-producer');
  await writeFile(command, `#!${process.execPath}\nrequire(${JSON.stringify(path.resolve('tests/fixtures/fake-qlever-native-runtime.js'))});\n`);
  await chmod(command, 0o755);
  const indexPath = path.join(directory, 'rdf.sqlite');
  const client = new LocalQleverNativeSparqlClient({ command, args: [ '--sqlite-path', indexPath ] });
  const engine = new SolidRdfEngine({ index: { path: indexPath }, nativeSparqlClient: client });
  const structured = new SolidRdfDataAccessor(engine, identifiers);
  cleanup.push(async () => { await structured.finalize(); });
  const data = path.join(directory, 'data'); await mkdir(data);
  const mapper = new ExtensionBasedMapper(origin, data);
  const ordinaryFiles = new FileDataAccessor(mapper);
  const rdfFiles = mapping.rdfFileDataAccessor
    ? await mapping.rdfFileDataAccessor({ origin, rootFilePath: data, mapper })
    : ordinaryFiles;
  const journal = mapping.authorityRecovery ? new RootedSolidFsSyncJournal(data) : undefined;
  const accessor = new MixDataAccessor(structured, ordinaryFiles, false, true, rdfFiles, false,
    journal ? mapper : undefined, journal);
  await structured.initialize();
  if (journal) {
    const recovery = new LocalRdfAuthorityRecoveryInitializer(journal, accessor, mapper, origin, data);
    cleanup.push(async () => { await recovery.finalize(); });
    await recovery.handle();
  }
  const resourceStore = new SparqlUpdateResourceStore({ accessor, identifierStrategy: identifiers, auxiliaryStrategy: auxiliary, metadataStrategy });
  const converter = new ChainedConverter([ new RdfToQuadConverter(), new QuadToRdfConverter() ]);
  // Preserve the seed/write representations; the bidirectional chain is needed
  // only when actual HTTP reads request Turtle from generated internal quads.
  const converted = new RepresentationPartialConvertingStore(resourceStore, metadataStrategy, {
    inPreferences: { type: { 'text/turtle': 1, [INTERNAL_QUADS]: 1 } },
    inConverter: converter, outConverter: converter,
  });
  const lockedStore = new LockingResourceStore(converted, locks, auxiliary);
  const manager = new BaseAuthorizationManager(identifiers, authorizationStrategy, lockedStore);
  const engineReader = new PolicyEngineReader(new AclPermissionsEngine(kind === 'acp'
    ? new AcpPolicyEngine(new ManagedAcpRepository(manager))
    : new WacPolicyEngine(new UnionAccessChecker([ new AgentAccessChecker(), new AgentClassAccessChecker() ]), new ManagedWacRepository(manager)), manager));
  // ACP uses the installed default reader ordering. Pod ownership below is a fixture
  // adapter for the same identity seeded in its registry; it only grants Control.
  const defaultReader = new AuthAuxiliaryReader(new OwnerPermissionReader({
      findByBaseUrl: async (url: string) => url === pod ? {id: 'root-guard-pod'} : undefined,
      getOwners: async (id: string) => id === 'root-guard-pod' ? [{webId: owner}] : [],
    } as never, {getStorageIdentifier: async (identifier: ResourceIdentifier) => ({path: identifier.path.startsWith(pod) ? pod : origin})} as never,
    new ReadDeleteReader(engineReader, {hasResource: async (identifier: ResourceIdentifier) => {
      try { await accessor.getMetadata(identifier); return true; }
      catch (error) { if (HttpError.isInstance(error) && error.statusCode === 404) return false; throw error; }
    }} as never, identifiers)), authorizationStrategy);
  const pathReader = mapping.observation
    ? new ObservationPathBasedReader(origin, mapping.observation.routes?.(room) ?? {}, defaultReader)
    : new PathBasedReader(origin, {}, defaultReader);
  const audited = kind === 'acp' || Boolean(mapping.observation && !mapping.observation.disabled);
  const ordinaryPermissions = audited ? new AuxiliaryReader(pathReader, auxiliary)
    : new AuthAuxiliaryReader(engineReader, authorizationStrategy);
  const permissions = mapping.observation?.reader?.(ordinaryPermissions, defaultReader) ?? ordinaryPermissions;
  const ordinaryAuthorizer = new PermissionBasedAuthorizer();
  const authorizer = mapping.observation?.authorizer?.(ordinaryAuthorizer) ?? ordinaryAuthorizer;
  const credentialsExtractor = { handleSafe: async (request: IncomingMessage) => {
    const actual: Credentials = { agent: { webId: String(request.headers['x-root-fixture-principal'] ?? owner) } };
    return mapping.observation?.credentials?.(actual) ?? actual;
  } };
  const etags = new BasicETagHandler();
  const authorizedRead = new AuthorizingHttpHandler({
    // Actual CSS authorization, with a counted fixture identity rather than DPoP.
    credentialsExtractor: credentialsExtractor as never,
    modesExtractor: new MethodModesExtractor(lockedStore), permissionReader: permissions,
    authorizer,
    operationHandler: new WaterfallHandler([ new HeadOperationHandler(lockedStore, etags),
      new GetOperationHandler(lockedStore, etags) ]) as never,
  });
  const responseWriter = new BasicResponseWriter(new ParallelHandler([
    new ContentTypeMetadataWriter(), new AuxiliaryLinkMetadataWriter(auxiliary, authorizationStrategy, 'acl'),
  ]));
  readHttp = async (request, response) => {
    const result = await authorizedRead.handleSafe({ request: request as never, response: response as never,
      operation: { method: request.method!, target: { path: new URL(request.url!, origin).href },
        preferences: { type: { 'text/turtle': 1 } }, body: new BasicRepresentation(), },
    });
    await responseWriter.handleSafe({ result, response: response as never });
  };
  const identityDbUrl = `sqlite:${path.join(directory, 'identity.sqlite')}`;
  const sqliteOpen = vi.spyOn(getSqliteRuntime(), 'openDatabase');
  const identity = getIdentityDatabase(identityDbUrl);
  const identityConnection = sqliteOpen.mock.results[sqliteOpen.mock.results.length - 1]?.value;
  sqliteOpen.mockRestore();
  cleanup.push(() => { identityConnection?.close(); });
  await executeStatement(identity, sql`CREATE TABLE IF NOT EXISTS identity_store (container TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (container, id))`);
  await executeStatement(identity, sql`CREATE TABLE IF NOT EXISTS internal_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)`);
  await executeStatement(identity, sql`INSERT INTO identity_store (container, id, payload) VALUES ('pod', 'root-guard-pod', ${JSON.stringify({ accountId: 'root-guard-account', baseUrl: pod, webId: owner })})`);
  const executeNative = accessor.executeSparqlUpdate.bind(accessor);
  const native = vi.spyOn(accessor, 'executeSparqlUpdate');
  const queryEngine = { listGraphs: vi.fn(async () => new Set<string>()), queryVoid: vi.fn(async () => { throw new Error('Root fixture forbids non-native update fallback'); }) };
  const options = { identityDbUrl, guardedPolicyProfile: profile };
  const observationArgs: ConstructorParameters<typeof AgentReadObservation> = [ permissions, authorizer,
    credentialsExtractor as never, accessor, lockedStore, locks, identifiers, authStrategy, auxiliary, profile ];
  const observation = mapping.observation && !mapping.observation.disabled
    ? new AgentReadObservation(...(mapping.observation.boundArgs?.(observationArgs) ?? observationArgs)) : undefined;
  // Postfixed DI parameters are a public constructor contract. Until implemented, JS ignores
  // the extra arguments; the baseline still exercises actual unsupported-media rejection.
  handler = Reflect.construct(SubgraphSparqlHttpHandler, [ queryEngine,
    mapping.observation ? credentialsExtractor : { handleSafe: async () => ({ agent: { webId: owner } }) }, permissions,
    authorizer, options, accessor, undefined, locks, authStrategy,
    lockedStore, identifiers, auxiliary, observation,
  ]) as SubgraphSparqlHttpHandler;
  const closure = new GuardedPolicyClosure({ accessor, store: lockedStore, locks,
    identifierStrategy: identifiers, authStrategy, auxiliaryStrategy: auxiliary,
    podLookup: new PodLookupRepository(identity), profile } as never);
  const policyIri = (iri: string) => authStrategy.getAuxiliaryIdentifier({ path: iri }).path;
  const putContainer = async (iri: string) => lockedStore.setRepresentation({ path: iri }, new BasicRepresentation(Readable.from([], { objectMode: true }), new RepresentationMetadata({ path: iri }, INTERNAL_QUADS)));
  const putRdf = async (iri: string, ttl: string) => lockedStore.setRepresentation({ path: iri }, new BasicRepresentation(Readable.from([ ttl ]), 'text/turtle'));
  const putRdfSet = async (iri: string, ttl: string) => {
    const writer = new Writer({ format: 'Turtle' });
    writer.addQuads(new Store(new Parser({ baseIRI: iri }).parse(ttl)).getQuads(null, null, null, null));
    const text = await new Promise<string>((resolve, reject) => {
      writer.end((error, output) => error ? reject(error) : resolve(output));
    });
    await putRdf(iri, text);
  };
  const ancestors: string[] = [];
  let current = room;
  while (current !== origin) { ancestors.unshift(current); current = identifiers.getParentContainer({ path: current }).path; }
  await putContainer(origin);
  for (const iri of ancestors) await putContainer(iri);
  if (mapping.roomPolicyOutsideRoom) await putContainer(`${pod}policies/`);
  const podAcl = policyIri(pod);
  const ownerPolicy = kind === 'acp' ? rootAcpPolicy(podAcl, pod, owner, ['Read', 'Write', 'Control'])
    : `<${podAcl}#owner> a <${aclNs}Authorization>; <${aclNs}accessTo> <${pod}>; <${aclNs}default> <${pod}>; <${aclNs}agent> <${owner}>; <${aclNs}mode> <${aclNs}Read>, <${aclNs}Write>, <${aclNs}Control> .`;
  await putRdf(podAcl, ownerPolicy);
  const compiler = drizzle({ info: { isLoggedIn: true, webId: owner, podUrl: pod }, fetch: async () => { throw new Error('Root compiler does not fetch'); } } as never,
    { disableInteropDiscovery: true, resourcePreparation: 'off', podUrl: pod });
  const insert = compiler.insert(chatResource).values({ id: chatResource.buildId({ id: 'root-guarded' }), author: owner,
    participants: [ owner ], metadata: { '@id': `${source}/metadata`, protocols: { matrix: { acceptancePhase: 'pending' } }, memberRoles: { [owner]: 'owner' } },
  } as never).toSPARQL().query;
  const seed = new Store(); await new QueryEngine().queryVoid(insert, { sources: [ seed ], destination: seed });
  await lockedStore.setRepresentation({ path: document }, new BasicRepresentation(Readable.from(seed.getQuads(null, null, null, null).map(q => DataFactory.quad(q.subject, q.predicate, q.object)), { objectMode: true }), INTERNAL_QUADS));
  const phaseQuad = seed.getQuads(null, null, null, null).find(q => q.object.termType === 'Literal' && q.object.value.includes('acceptancePhase'));
  if (!phaseQuad) throw new Error('Public ORM did not produce phase seed');
  const rawTerm = phaseQuad.object;
  if (rawTerm.termType !== 'Literal') throw new Error('Missing raw protocols literal');
  const phaseLiteral = `${JSON.stringify(rawTerm.value)}^^<${rawTerm.datatype.value}>`;
  const guardWhere = `GRAPH <${document}> { <${phaseQuad.subject.value}> <${phaseQuad.predicate.value}> ${phaseLiteral} }
    FILTER NOT EXISTS { GRAPH <${document}> { <${phaseQuad.subject.value}> <${phaseQuad.predicate.value}> ?other } FILTER(!sameTerm(?other, ${phaseLiteral})) }`;
  const sourceUpdate = `DELETE { GRAPH <${document}> { <${phaseQuad.subject.value}> <${phaseQuad.predicate.value}> ${phaseLiteral} } }
    INSERT { GRAPH <${document}> { <${phaseQuad.subject.value}> <${phaseQuad.predicate.value}> ${JSON.stringify(rawTerm.value.replace('pending', 'committed'))}^^<${rawTerm.datatype.value}> } }
    WHERE { ${guardWhere} }`;
  const roomAcl = policyIri(room);
  const roomPolicy = kind === 'acp' ? rootAcpPolicy(roomAcl, room, owner, ['Read', 'Write', 'Control'])
    : `<${roomAcl}#owner> a <${aclNs}Authorization>; <${aclNs}accessTo> <${room}>; <${aclNs}default> <${room}>; <${aclNs}agent> <${owner}>; <${aclNs}mode> <${aclNs}Read>, <${aclNs}Write>, <${aclNs}Control> .`;
  const policyUpdate = `INSERT { GRAPH <${roomAcl}> { ${roomPolicy} } } WHERE { ${guardWhere} }`;
  const readPersisted = async (iri: string) => {
    const file = (await mapper.mapUrlToFilePath({ path: iri }, false, 'text/turtle')).filePath;
    return await readFile(file, 'utf8');
  };
  const observationRequest = async (targetWebId = owner, extra: Record<string, unknown> = {}) => ({
    version: 1, profile: 'acp-agent-read-v1', sourceIri: source,
    expectedSourceDigest: expectedSourceDigest(source, document,
      new Parser({ baseIRI: document }).parse(await readPersisted(document))),
    targetWebId, contextDigest: 'ab'.repeat(32), challenge: 'cd'.repeat(16), ...extra,
  });
  const post = async (payload: unknown, media = guardedMedia) => {
    const response = await fetch(`${room}-/sparql`, { method: 'POST', headers: { 'content-type': media }, body: typeof payload === 'string' ? payload : JSON.stringify(payload) });
    return { status: response.status, text: await response.text() };
  };
  const expected = () => {
    const normal = [ room, document ];
    const requiredAncestors = [...(kind === 'acp' ? [origin] : []), ...ancestors.filter(iri => iri !== room)];
    const policies = [...new Set([...normal, ...requiredAncestors].map(policyIri))].map(iri => ({ iri, kind,
      state: iri === podAcl ? 'present' as const : 'absent404' as const,
      digest: iri === podAcl ? expectedGroundDigest(iri, new Parser({ baseIRI: iri }).parse(ownerPolicy), kind) : null,
    }));
    return { profile, scope: room,
      resources: normal.map(iri => ({ iri, container: iri === room, children: iri === room ? [ document ] : [], policyIri: policyIri(iri) })),
      ancestors: requiredAncestors.map(iri => ({ iri, policyIri: policyIri(iri) })), policies };
  };
  const withHistory = async () => {
    const history = `${room}history.ttl`;
    const historyPolicy = policyIri(history);
    await putRdf(history, '<urn:root:history> <urn:root:value> "historical" .');
    const guard = expected();
    guard.resources[0].children.push(history);
    guard.resources.push({ iri: history, container: false, children: [], policyIri: historyPolicy });
    guard.policies.push({ iri: historyPolicy, kind, state: 'absent404', digest: null });
    native.mockClear();
    return { history, historyPolicy, guard };
  };
  native.mockClear();
  return { origin, pod, owner, room, document, source, podAcl, roomAcl, ownerPolicy,
    directory, identity,
    accessor, structured, engine, locks, lockedStore, identifiers, authStrategy, auxiliary,
    permissions, defaultReader, authorizer, pathReader,
    native, executeNative, queryEngine, handlerErrors, expected, withHistory, post, putRdf, putRdfSet,
    putContainer, readPersisted, observationRequest,
    readClosure: async () => await closure.read(room),
    sourceUpdate, policyUpdate, policyIri,
  };
}
