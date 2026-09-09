import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { DataFactory } from 'n3';
import {
  RdfQuadIndex,
  Rdf3xIndex,
  SolidRdfEngine,
  RDF_MODELS_SYNTHETIC_MESSAGE_QUADS,
  buildRdfModelsBenchmarkSeed,
  defaultSyntheticMessagesForRdfModelsScale,
  estimateRdfModelsSyntheticQuadCount,
  rdfModelsBenchmarkCaseNames,
  rdfModelsBenchmarkCasesForProfile,
  rdfModelsExtremeBenchmarkCaseNames,
  rdfModelsExtremeQueryBenchmarkCaseNames,
  rdfModelsQueryBenchmarkCaseNames,
  rdfModelsQueryBenchmarkCasesForProfile,
  rdfModelsPostgresQueryBenchmarkCasesForProfile,
  rdfModelsSearchFusionQueryBenchmarkCaseNames,
  rdfModelsBenchmarkScaleSatisfied,
  rdfModelsBenchmarkTargetSatisfied,
  rdfModelsBenchmarkScaleTargetQuads,
  rdfModelsBenchmarkSyntheticPodCount,
  rdfModelsSearchFusionBroadSourceCountForScale,
  runRdfModelsBenchmark,
  runRdfModelsRdf3xShadowBenchmark,
  seedRdfModelsSearchFusionIndexes,
  syntheticMessagesForRdfModelsTargetQuads,
} from '../../../src/storage/rdf';

const { namedNode, literal, quad } = DataFactory;
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const DCT_CREATED = 'http://purl.org/dc/terms/created';
const DCT_MODIFIED = 'http://purl.org/dc/terms/modified';
const DCT_TITLE = 'http://purl.org/dc/terms/title';
const SIOC_CONTENT = 'http://rdfs.org/sioc/ns#content';
const SIOC_HAS_MEMBER = 'http://rdfs.org/sioc/ns#has_member';
const UDFS = 'https://undefineds.co/ns#';
const XPOD_AI = 'https://vocab.xpod.dev/ai#';
const XPOD_CREDENTIAL = 'https://vocab.xpod.dev/credential#';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const XSD_BOOLEAN = 'http://www.w3.org/2001/XMLSchema#boolean';
const FOAF_AGENT = 'http://xmlns.com/foaf/0.1/Agent';
const FOAF_PERSON = 'http://xmlns.com/foaf/0.1/Person';
const FOAF_PRIMARY_TOPIC = 'http://xmlns.com/foaf/0.1/primaryTopic';
const VCARD_INDIVIDUAL = 'http://www.w3.org/2006/vcard/ns#Individual';
const VCARD_FN = 'http://www.w3.org/2006/vcard/ns#fn';
const LDP_INBOX = 'http://www.w3.org/ns/ldp#inbox';
const SCHEMA_CREATIVE_WORK = 'http://schema.org/CreativeWork';
const MEETING_MESSAGE = 'http://www.w3.org/ns/pim/meeting#Message';
const ACL = 'http://www.w3.org/ns/auth/acl#';
const ACP = 'http://www.w3.org/ns/solid/acp#';
const AS = 'https://www.w3.org/ns/activitystreams#';
const ODRL = 'http://www.w3.org/ns/odrl/2/';

function rdfModelsRuntimeAiQuads() {
  const profile = 'https://pod.example/alice/profile/card#me';
  const chatGraph = 'https://pod.example/alice/.data/chat/default/index.ttl';
  const chat = `${chatGraph}#this`;
  const thread = `${chatGraph}#thread_1`;
  const sessionGraph = 'https://pod.example/alice/.data/sessions/2026/05/18/session_1.ttl';
  const session = sessionGraph;
  const grant = 'https://pod.example/alice/settings/autonomy/grants/default.ttl';
  const approval = 'https://pod.example/alice/.data/approvals/2026/05/18.ttl#approval_1';
  const auditGraph = 'https://pod.example/alice/.data/audits/2026/05/18.ttl';
  const audit = `${auditGraph}#audit_1`;
  const provider = 'https://pod.example/alice/settings/providers/anthropic.ttl';
  const model = `${provider}#claude-sonnet-4`;
  const aiConfigGraph = 'https://pod.example/alice/settings/ai/config.ttl';
  const vectorStoreGraph = 'https://pod.example/alice/settings/ai/vector-stores.ttl';
  const indexedFileGraph = 'https://pod.example/alice/settings/ai/indexed-files.ttl';
  const agentStatusGraph = 'https://pod.example/alice/settings/ai/agent-status.ttl';

  return [
    quad(namedNode(session), namedNode(RDF_TYPE), namedNode(`${UDFS}Session`), namedNode(sessionGraph)),
    quad(namedNode(session), namedNode(`${UDFS}actor`), namedNode(profile), namedNode(sessionGraph)),
    quad(namedNode(session), namedNode(`${UDFS}conversation`), namedNode(chat), namedNode(sessionGraph)),
    quad(namedNode(session), namedNode(`${UDFS}inThread`), namedNode(thread), namedNode(sessionGraph)),
    quad(namedNode(session), namedNode(`${UDFS}conversationType`), literal('direct'), namedNode(sessionGraph)),
    quad(namedNode(session), namedNode(`${UDFS}sessionStatus`), literal('active'), namedNode(sessionGraph)),
    quad(namedNode(session), namedNode(`${UDFS}sessionTool`), literal('codex'), namedNode(sessionGraph)),
    quad(namedNode(session), namedNode(`${UDFS}tokenUsage`), literal('1500', namedNode(XSD_INTEGER)), namedNode(sessionGraph)),
    quad(namedNode(session), namedNode(`${UDFS}policy`), namedNode(grant), namedNode(sessionGraph)),
    quad(namedNode(session), namedNode(DCT_CREATED), literal('2026-05-18T03:00:00.000Z'), namedNode(sessionGraph)),
    quad(namedNode(session), namedNode(DCT_MODIFIED), literal('2026-05-18T03:10:00.000Z'), namedNode(sessionGraph)),
    quad(namedNode(audit), namedNode(RDF_TYPE), namedNode(`${UDFS}AuditEntry`), namedNode(auditGraph)),
    quad(namedNode(audit), namedNode(`${UDFS}actor`), namedNode(profile), namedNode(auditGraph)),
    quad(namedNode(audit), namedNode(`${UDFS}session`), namedNode(session), namedNode(auditGraph)),
    quad(namedNode(audit), namedNode(`${UDFS}approval`), namedNode(approval), namedNode(auditGraph)),
    quad(namedNode(audit), namedNode(`${UDFS}policy`), namedNode(grant), namedNode(auditGraph)),
    quad(namedNode(audit), namedNode(DCT_CREATED), literal('2026-05-18T03:05:00.000Z'), namedNode(auditGraph)),
    quad(namedNode(`${aiConfigGraph}#default`), namedNode(RDF_TYPE), namedNode(`${XPOD_AI}AIConfig`), namedNode(aiConfigGraph)),
    quad(namedNode(`${aiConfigGraph}#default`), namedNode(`${XPOD_AI}embeddingModel`), namedNode(model), namedNode(aiConfigGraph)),
    quad(namedNode(`${aiConfigGraph}#default`), namedNode(`${XPOD_AI}migrationStatus`), literal('ready'), namedNode(aiConfigGraph)),
    quad(namedNode(`${aiConfigGraph}#default`), namedNode(`${XPOD_AI}migrationProgress`), literal('100', namedNode(XSD_INTEGER)), namedNode(aiConfigGraph)),
    quad(namedNode('https://pod.example/alice/settings/ai/vector-stores.ttl#chat-default'), namedNode(RDF_TYPE), namedNode(`${XPOD_AI}VectorStore`), namedNode(vectorStoreGraph)),
    quad(namedNode('https://pod.example/alice/settings/ai/vector-stores.ttl#chat-default'), namedNode(`${XPOD_AI}status`), literal('active'), namedNode(vectorStoreGraph)),
    quad(namedNode('https://pod.example/alice/settings/ai/vector-stores.ttl#chat-default'), namedNode(`${XPOD_AI}chunkingStrategy`), literal('markdown-heading-v1'), namedNode(vectorStoreGraph)),
    quad(namedNode('https://pod.example/alice/settings/ai/indexed-files.ttl#chat-default-messages'), namedNode(RDF_TYPE), namedNode(`${XPOD_AI}IndexedFile`), namedNode(indexedFileGraph)),
    quad(namedNode('https://pod.example/alice/settings/ai/indexed-files.ttl#chat-default-messages'), namedNode(`${XPOD_AI}status`), literal('indexed'), namedNode(indexedFileGraph)),
    quad(namedNode('https://pod.example/alice/settings/ai/indexed-files.ttl#chat-default-messages'), namedNode(`${XPOD_AI}chunkingStrategy`), literal('markdown-heading-v1'), namedNode(indexedFileGraph)),
    quad(namedNode('https://pod.example/alice/settings/ai/indexed-files.ttl#chat-default-messages'), namedNode(`${XPOD_AI}usageBytes`), literal('2048', namedNode(XSD_INTEGER)), namedNode(indexedFileGraph)),
    quad(namedNode('https://pod.example/alice/settings/ai/agent-status.ttl#secretary'), namedNode(RDF_TYPE), namedNode(`${XPOD_AI}AgentStatus`), namedNode(agentStatusGraph)),
    quad(namedNode('https://pod.example/alice/settings/ai/agent-status.ttl#secretary'), namedNode(`${XPOD_AI}agentId`), literal('secretary'), namedNode(agentStatusGraph)),
    quad(namedNode('https://pod.example/alice/settings/ai/agent-status.ttl#secretary'), namedNode(`${XPOD_AI}status`), literal('running'), namedNode(agentStatusGraph)),
  ];
}

describe('SolidRdfEngine', () => {
  let index: RdfQuadIndex;
  let engine: SolidRdfEngine;
  let root: string;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'xpod-solid-rdf-'));
    const dbPath = path.join(root, 'rdf.sqlite');
    index = new RdfQuadIndex({ path: dbPath });
    index.open();
    engine = new SolidRdfEngine({
      index,
    });
  });

  afterEach(async () => {
    index.close();
    await engine.close();
    await rm(root, { recursive: true, force: true });
  });

  it('ignores empty optional search-index placeholders from configuration', async () => {
    const placeholderEngine = new SolidRdfEngine({
      index,
      textIndex: {} as any,
      vectorIndex: {} as any,
      autoOpen: true,
    });

    expect(() => placeholderEngine.searchText('runtime')).toThrow('SolidRdfEngine text index is not configured');
    expect(() => placeholderEngine.searchVector({ embedding: [1] })).toThrow('SolidRdfEngine vector index is not configured');

    await placeholderEngine.close();
  });

  it('delegates the shared native SPARQL envelope seam to the Local QLever client', async () => {
    const nativeClient = {
      start: vi.fn(),
      query: vi.fn().mockResolvedValue({
        status: 'ok',
        mediaType: 'application/sparql-results+json',
        body: '{"boolean":true}',
      }),
      close: vi.fn(),
    };
    const localEngine = new SolidRdfEngine({
      index,
      nativeSparqlClient: nativeClient,
    });

    await localEngine.open();
    await expect(localEngine.sparqlQuery('ASK {}', {
      basePath: 'https://pod.example/',
      accessScope: {
        basePath: 'https://pod.example/',
        mode: 'read',
      },
    })).resolves.toMatchObject({ status: 'ok' });
    await localEngine.close();

    expect(nativeClient.start).toHaveBeenCalledOnce();
    expect(nativeClient.query).toHaveBeenCalledWith('ASK {}', expect.objectContaining({
      basePath: 'https://pod.example/',
    }));
    expect(nativeClient.close).toHaveBeenCalledOnce();
  });

  it('fails closed when Local QLever is not configured', async () => {
    await expect(engine.sparqlQuery('ASK {}', {
      basePath: 'https://pod.example/',
    })).rejects.toThrow('Local QLever runtime is not configured');
  });

  it('keeps local product RDF maintenance on the baseline facts engine', async () => {
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const type = namedNode(RDF_TYPE);
    const created = namedNode(DCT_CREATED);
    const messageType = namedNode(MEETING_MESSAGE);
    const msg1 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1');

    engine.put([
      quad(msg1, type, messageType, graph),
      quad(msg1, created, literal('2026-05-18T00:00:01.000Z'), graph),
    ]);

    expect(engine.refreshDerivedIndexes({ mode: 'full' })).toEqual({
      derivedIndexProfile: 'baseline',
      factsDataVersion: engine.index.dataVersion(),
    });

    const result = engine.query({
      patterns: [
        {
          subject: { variable: 'message' },
          predicate: type,
          object: messageType,
        },
        {
          subject: { variable: 'message' },
          predicate: created,
          object: { variable: 'createdAt' },
        },
      ],
      select: ['message', 'createdAt'],
    });

    expect(result.bindings.map((binding) => binding.message.value)).toEqual([
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
    ]);
    expect(result.metrics.plan.some((entry) => entry.startsWith('Rdf3xJoinBGP('))).toBe(false);

    const storage = engine.storageStats();
    expect(storage.derivedIndexProfile).toBe('baseline');
    expect(storage.rdf3x).toBeUndefined();
    expect(storage.derivedBytes).toBe(0);
    expect(storage.totalBytes).toBe(storage.factsBytes);
    expect(storage.totalToFactsRatio).toBe(1);
  });

  it('exposes a benchmark case list aligned to the spec', () => {
    expect(rdfModelsBenchmarkCaseNames()).toEqual([
      'list chats',
      'list tasks',
      'list threads by chat',
      'threads by modeled chat relation',
      'list threads by task',
      'messages by modeled thread relation',
      'chat latest message pointer',
      'list messages by thread',
      'latest message',
      'latest run',
      'pending runs',
      'running runs',
      'runs by workspace',
      'runs by numeric priority',
      'run with steps',
      'task materialization due time',
      'cron tasks due time',
      'waiting input runs',
      'runs by lease owner',
      'search message literals',
      'load by exact id',
      'acl graph prefix scoped query',
      'load webid profile',
      'profile public read acl',
      'profile public read acr',
      'list issues',
      'pending approvals',
      'active autonomy grants',
      'list inbox notifications',
      'list providers',
      'models by provider',
      'credentials by provider',
      'list agents',
      'list contacts',
      'list favorites',
      'list sessions',
      'active sessions',
      'audit entries by actor',
      'list ai configs',
      'list settings',
      'sensitive settings',
      'active vector stores',
      'indexed files by status',
      'running agent statuses',
      'oauth credentials expiring',
      'reply messages',
      'routed messages by target agent',
    ]);
    expect(rdfModelsQueryBenchmarkCaseNames()).toEqual([
      'latest message by thread query',
      'thread message keyset page query',
      'thread context window query',
      'modeled thread message page query',
      'chat latest message hydration query',
      'thread chat hydration query',
      'next queued run by workspace query',
      'run steps by run query',
      'task run execution detail query',
      'task materialization active due query',
      'scheduled task trigger query',
      'scheduled task trigger keyset continuation query',
      'leased running run query',
      'provider model credential join query',
      'provider model credential VALUES join query',
      'provider model credential ordered join query',
      'ai credential selection query',
      'provider model credential count query',
      'provider credential grouped count query',
      'provider credential single-pattern grouped count query',
      'provider credential fail count aggregate query',
      'oauth credential expiry query',
      'profile acl authorization join query',
      'profile acr authorization join query',
      'profile inbox activity join query',
      'approval grant action match query',
      'favorite target chat join query',
      'contact entity profile join query',
      'settings owner category query',
      'settings owner category keyset query',
      'active session thread hydration query',
      'message reply chain query',
      'routed message agent query',
      'audit approval policy trace query',
      'ai config embedding model query',
      'vector indexed file store query',
      'message count by thread with having',
      'queued run priority numeric aggregate',
      'message score by thread numeric aggregate',
      'message join count distinct',
    ]);
    expect(rdfModelsExtremeBenchmarkCaseNames()).toEqual([
      'extreme month message score range scan',
      'extreme month message text scan',
    ]);
    expect(rdfModelsExtremeQueryBenchmarkCaseNames()).toEqual([
      'extreme message eight-pattern star query',
      'extreme message large VALUES thread query',
      'extreme message count distinct thread query',
      'extreme message grouped count by thread query',
      'extreme message grouped numeric aggregate by thread query',
      'extreme native exact graph eight-pattern join query',
      'extreme native exact graph ordered-page query',
      'extreme native exact graph VALUES thread query',
      'extreme native exact graph count distinct thread query',
      'extreme native exact graph grouped count by thread query',
      'extreme native exact graph grouped numeric aggregate by thread query',
    ]);
    expect(rdfModelsSearchFusionQueryBenchmarkCaseNames()).toEqual([
      'agent context text vector fusion query',
      'broad agent context text vector fusion query',
    ]);
    expect(rdfModelsBenchmarkCasesForProfile('default').map((testCase) => testCase.name)).toEqual(rdfModelsBenchmarkCaseNames());
    expect(rdfModelsQueryBenchmarkCasesForProfile('default').map((testCase) => testCase.name)).toEqual(rdfModelsQueryBenchmarkCaseNames());
    expect(rdfModelsBenchmarkCasesForProfile('extreme').map((testCase) => testCase.name)).toEqual(rdfModelsExtremeBenchmarkCaseNames());
    expect(rdfModelsQueryBenchmarkCasesForProfile('extreme').map((testCase) => testCase.name)).toEqual(rdfModelsExtremeQueryBenchmarkCaseNames());
    expect(rdfModelsBenchmarkCasesForProfile('fusion')).toEqual([]);
    expect(rdfModelsQueryBenchmarkCasesForProfile('fusion').map((testCase) => testCase.name)).toEqual(
      rdfModelsSearchFusionQueryBenchmarkCaseNames(),
    );
    expect(rdfModelsPostgresQueryBenchmarkCasesForProfile('fusion').map((testCase) => testCase.name)).toEqual(
      rdfModelsSearchFusionQueryBenchmarkCaseNames(),
    );
    expect(rdfModelsBenchmarkCasesForProfile('all')).toHaveLength(
      rdfModelsBenchmarkCaseNames().length + rdfModelsExtremeBenchmarkCaseNames().length,
    );
    expect(rdfModelsQueryBenchmarkCasesForProfile('all')).toHaveLength(
      rdfModelsQueryBenchmarkCaseNames().length
        + rdfModelsExtremeQueryBenchmarkCaseNames().length
        + rdfModelsSearchFusionQueryBenchmarkCaseNames().length,
    );
  });

  it('keeps benchmark scale seed targets aligned with the spec', () => {
    expect(rdfModelsBenchmarkScaleTargetQuads('small')).toBeGreaterThanOrEqual(48);
    expect(rdfModelsBenchmarkScaleTargetQuads('medium')).toBe(10_000);
    expect(rdfModelsBenchmarkScaleTargetQuads('large')).toBe(1_000_000);
    expect(defaultSyntheticMessagesForRdfModelsScale('small')).toBe(12);
    const mediumSyntheticQuads = estimateRdfModelsSyntheticQuadCount(defaultSyntheticMessagesForRdfModelsScale('medium'));
    const largeSyntheticQuads = estimateRdfModelsSyntheticQuadCount(defaultSyntheticMessagesForRdfModelsScale('large'));
    expect(mediumSyntheticQuads).toBeGreaterThanOrEqual(10_000);
    expect(mediumSyntheticQuads).toBeLessThan(10_000 + RDF_MODELS_SYNTHETIC_MESSAGE_QUADS);
    expect(largeSyntheticQuads).toBeGreaterThanOrEqual(1_000_000);
    expect(largeSyntheticQuads).toBeLessThan(1_000_000 + RDF_MODELS_SYNTHETIC_MESSAGE_QUADS);
    const targetSyntheticQuads = estimateRdfModelsSyntheticQuadCount(syntheticMessagesForRdfModelsTargetQuads(36_000));
    expect(targetSyntheticQuads).toBeGreaterThanOrEqual(36_000);
    expect(targetSyntheticQuads).toBeLessThan(36_000 + RDF_MODELS_SYNTHETIC_MESSAGE_QUADS);
    expect(rdfModelsBenchmarkSyntheticPodCount('medium')).toBe(1);
    expect(rdfModelsBenchmarkSyntheticPodCount('large')).toBeGreaterThan(1);
    expect(rdfModelsSearchFusionBroadSourceCountForScale('small')).toBe(32);
    expect(rdfModelsSearchFusionBroadSourceCountForScale('medium')).toBeGreaterThan(rdfModelsSearchFusionBroadSourceCountForScale('small'));
    expect(rdfModelsSearchFusionBroadSourceCountForScale('large')).toBeGreaterThan(rdfModelsSearchFusionBroadSourceCountForScale('medium'));
    expect(rdfModelsBenchmarkScaleSatisfied('large', 100_000)).toBe(false);
    expect(rdfModelsBenchmarkScaleSatisfied('large', 1_000_000)).toBe(true);
    expect(rdfModelsBenchmarkTargetSatisfied(36_000, 35_999)).toBe(false);
    expect(rdfModelsBenchmarkTargetSatisfied(36_000, 36_000)).toBe(true);
  });

  it('seeds complete primary-pod RDF facts for large fusion candidates', () => {
    const broadSourceCount = rdfModelsSearchFusionBroadSourceCountForScale('large');
    const quads = buildRdfModelsBenchmarkSeed({
      syntheticMessages: broadSourceCount + 3,
      syntheticPodCount: rdfModelsBenchmarkSyntheticPodCount('large'),
      caseProfile: 'fusion',
      searchFusionBroadSourceCount: broadSourceCount,
    });

    const primarySyntheticMessages = new Set(
      quads
        .filter((entry) => entry.predicate.equals(namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type')))
        .map((entry) => entry.subject.value)
        .filter((subject) => subject.startsWith('https://pod.example/alice/.data/chat/default/2026/05/'))
        .filter((subject) => subject.includes('#synthetic_')),
    );

    expect(primarySyntheticMessages.size).toBeGreaterThanOrEqual(broadSourceCount + 3);
    expect(primarySyntheticMessages.has('https://pod.example/alice/.data/chat/default/2026/05/11/messages.ttl#synthetic_4098'))
      .toBe(true);
  });

  it('covers profile, access-control, and control-plane model cases in the benchmark seed', () => {
    engine.put(buildRdfModelsBenchmarkSeed({
      syntheticMessages: defaultSyntheticMessagesForRdfModelsScale('small'),
      syntheticPodCount: rdfModelsBenchmarkSyntheticPodCount('small'),
    }));

    const seededCaseNames = [
      'threads by modeled chat relation',
      'messages by modeled thread relation',
      'chat latest message pointer',
      'cron tasks due time',
      'waiting input runs',
      'runs by lease owner',
      'load webid profile',
      'profile public read acl',
      'profile public read acr',
      'list issues',
      'pending approvals',
      'active autonomy grants',
      'list inbox notifications',
      'list sessions',
      'active sessions',
      'audit entries by actor',
      'list settings',
      'sensitive settings',
      'list ai configs',
      'active vector stores',
      'indexed files by status',
      'running agent statuses',
      'oauth credentials expiring',
      'reply messages',
      'routed messages by target agent',
    ];
    const seededQueryCaseNames = [
      'modeled thread message page query',
      'chat latest message hydration query',
      'thread chat hydration query',
      'scheduled task trigger query',
      'leased running run query',
      'oauth credential expiry query',
      'profile acl authorization join query',
      'profile acr authorization join query',
      'profile inbox activity join query',
      'settings owner category query',
      'favorite target chat join query',
      'contact entity profile join query',
      'active session thread hydration query',
      'message reply chain query',
      'routed message agent query',
      'audit approval policy trace query',
      'ai config embedding model query',
      'vector indexed file store query',
    ];
    const seededCaseSet = new Set(seededCaseNames);
    const seededQueryCaseSet = new Set(seededQueryCaseNames);
    const report = runRdfModelsBenchmark(engine, {
      scale: 'medium',
      iterations: 1,
      cases: rdfModelsBenchmarkCasesForProfile('default').filter((testCase) => seededCaseSet.has(testCase.name)),
      queryCases: rdfModelsQueryBenchmarkCasesForProfile('default').filter((testCase) => seededQueryCaseSet.has(testCase.name)),
    });
    const byName = new Map(report.cases.map((testCase) => [testCase.name, testCase]));
    const queryByName = new Map(report.queryCases.map((testCase) => [testCase.name, testCase]));

    expect(report.planMatched).toBe(true);
    expect(report.failedPlanCases).toEqual([]);
    for (const caseName of seededCaseNames) {
      const result = byName.get(caseName);
      expect(result, `${caseName} should be part of the medium benchmark`).toBeDefined();
      expect(result?.planMatched).toBe(true);
      expect(result?.missingPlan).toEqual([]);
      expect(result?.returnedRows).toBeGreaterThan(0);
      expect(result?.durationsMs).toHaveLength(1);
    }
    for (const caseName of seededQueryCaseNames) {
      const result = queryByName.get(caseName);
      expect(result, `${caseName} should be part of the medium query benchmark`).toBeDefined();
      expect(result?.planMatched).toBe(true);
      expect(result?.missingPlan).toEqual([]);
      expect(result?.returnedRows).toBeGreaterThan(0);
      expect(result?.durationsMs).toHaveLength(1);
    }

    expect(byName.get('load webid profile')).toMatchObject({
      resource: 'profile',
      returnedRows: 1,
      metrics: { returnedRows: 1 },
    });
    expect(byName.get('profile public read acl')).toMatchObject({
      resource: 'acl',
      returnedRows: 1,
      metrics: { returnedRows: 1 },
    });
    expect(byName.get('profile public read acr')).toMatchObject({
      resource: 'acr',
      returnedRows: 1,
      metrics: { returnedRows: 1 },
    });
  });

  it('runs a models benchmark baseline report with checksums and index metrics', () => {
    engine.put([
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl#this'),
        namedNode(RDF_TYPE),
        namedNode('http://www.w3.org/ns/pim/meeting#LongChat'),
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/index.ttl#task_1'),
        namedNode(RDF_TYPE),
        namedNode(`${UDFS}Task`),
        namedNode('https://pod.example/alice/.data/task/index.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_1'),
        namedNode(RDF_TYPE),
        namedNode('http://rdfs.org/sioc/ns#Thread'),
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/index.ttl#thread_1'),
        namedNode(RDF_TYPE),
        namedNode('http://rdfs.org/sioc/ns#Thread'),
        namedNode('https://pod.example/alice/.data/task/default/index.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_1'),
        namedNode(`${UDFS}workspace`),
        namedNode('file://macbook.local/Users/alice/project/'),
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1'),
        namedNode(DCT_CREATED),
        literal('2026-05-18T01:02:03.000Z'),
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1'),
        namedNode(RDF_TYPE),
        namedNode(MEETING_MESSAGE),
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1'),
        namedNode(SIOC_HAS_MEMBER),
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_1'),
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1'),
        namedNode(`${UDFS}score`),
        literal('2', namedNode(XSD_INTEGER)),
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2'),
        namedNode(RDF_TYPE),
        namedNode(MEETING_MESSAGE),
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2'),
        namedNode(SIOC_HAS_MEMBER),
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_1'),
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2'),
        namedNode(`${UDFS}score`),
        literal('10', namedNode(XSD_INTEGER)),
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2'),
        namedNode(DCT_CREATED),
        literal('2026-05-18T01:03:03.000Z'),
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3'),
        namedNode(RDF_TYPE),
        namedNode(MEETING_MESSAGE),
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3'),
        namedNode(SIOC_HAS_MEMBER),
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_1'),
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3'),
        namedNode(`${UDFS}score`),
        literal('4', namedNode(XSD_INTEGER)),
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3'),
        namedNode(DCT_CREATED),
        literal('2026-05-18T01:04:03.000Z'),
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_1'),
        namedNode(RDF_TYPE),
        namedNode(`${UDFS}Run`),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_1'),
        namedNode(DCT_CREATED),
        literal('2026-05-18T01:00:00.000Z'),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_1'),
        namedNode(`${UDFS}task`),
        namedNode('https://pod.example/alice/.data/task/index.ttl#task_1'),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_1'),
        namedNode(`${UDFS}inThread`),
        namedNode('https://pod.example/alice/.data/task/default/index.ttl#thread_1'),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_1'),
        namedNode(`${UDFS}status`),
        literal('queued'),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_2'),
        namedNode(`${UDFS}status`),
        literal('running'),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_1'),
        namedNode(`${UDFS}workspace`),
        namedNode('file://macbook.local/Users/alice/project/'),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_1'),
        namedNode(`${UDFS}priority`),
        literal('10', namedNode(XSD_INTEGER)),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#step_1'),
        namedNode(RDF_TYPE),
        namedNode(`${UDFS}RunStep`),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#step_1'),
        namedNode(`${UDFS}run`),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_1'),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#step_1'),
        namedNode(`${UDFS}status`),
        literal('runtime.tool_call'),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#step_2'),
        namedNode(RDF_TYPE),
        namedNode(`${UDFS}RunStep`),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#step_2'),
        namedNode(`${UDFS}run`),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_1'),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#step_2'),
        namedNode(`${UDFS}status`),
        literal('run.completed'),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/schedules.ttl#schedule_1'),
        namedNode(RDF_TYPE),
        namedNode(`${UDFS}Schedule`),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/schedules.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/schedules.ttl#schedule_1'),
        namedNode(`${UDFS}status`),
        literal('active'),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/schedules.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/schedules.ttl#schedule_1'),
        namedNode(`${UDFS}nextRunAt`),
        literal('2026-05-18T01:00:00.000Z'),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/schedules.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/schedules.ttl#schedule_2'),
        namedNode(RDF_TYPE),
        namedNode(`${UDFS}Schedule`),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/schedules.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/schedules.ttl#schedule_2'),
        namedNode(`${UDFS}status`),
        literal('paused'),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/schedules.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/schedules.ttl#schedule_2'),
        namedNode(`${UDFS}nextRunAt`),
        literal('2026-05-18T00:30:00.000Z'),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/schedules.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
        namedNode(RDF_TYPE),
        namedNode(`${XPOD_AI}Provider`),
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
        namedNode(`${XPOD_AI}defaultModel`),
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl#claude-sonnet-4'),
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl#claude-sonnet-4'),
        namedNode(RDF_TYPE),
        namedNode(`${XPOD_AI}Model`),
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl#claude-sonnet-4'),
        namedNode(`${XPOD_AI}isProvidedBy`),
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl#claude-sonnet-4'),
        namedNode(`${XPOD_AI}status`),
        literal('active'),
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/settings/credentials.ttl#anthropic-default'),
        namedNode(`${XPOD_CREDENTIAL}provider`),
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
        namedNode('https://pod.example/alice/settings/credentials.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/settings/credentials.ttl#anthropic-default'),
        namedNode(`${XPOD_CREDENTIAL}service`),
        literal('ai'),
        namedNode('https://pod.example/alice/settings/credentials.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/settings/credentials.ttl#anthropic-default'),
        namedNode(`${XPOD_CREDENTIAL}status`),
        literal('active'),
        namedNode('https://pod.example/alice/settings/credentials.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/settings/credentials.ttl#anthropic-default'),
        namedNode(`${XPOD_CREDENTIAL}apiKey`),
        literal('sk-ant-test'),
        namedNode('https://pod.example/alice/settings/credentials.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/settings/credentials.ttl#anthropic-default'),
        namedNode(`${XPOD_CREDENTIAL}isDefault`),
        literal('true', namedNode(XSD_BOOLEAN)),
        namedNode('https://pod.example/alice/settings/credentials.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/settings/credentials.ttl#anthropic-default'),
        namedNode(`${XPOD_CREDENTIAL}failCount`),
        literal('15', namedNode(XSD_INTEGER)),
        namedNode('https://pod.example/alice/settings/credentials.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/agents/secretary.ttl#this'),
        namedNode(RDF_TYPE),
        namedNode(FOAF_AGENT),
        namedNode('https://pod.example/alice/.data/agents/secretary.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/contacts/secretary.ttl'),
        namedNode(RDF_TYPE),
        namedNode(VCARD_INDIVIDUAL),
        namedNode('https://pod.example/alice/.data/contacts/secretary.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/contacts/secretary.ttl'),
        namedNode(FOAF_PRIMARY_TOPIC),
        namedNode('https://pod.example/alice/.data/agents/secretary.ttl#this'),
        namedNode('https://pod.example/alice/.data/contacts/secretary.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/contacts/secretary.ttl'),
        namedNode(FOAF_PRIMARY_TOPIC),
        namedNode('https://pod.example/alice/.data/agents/secretary.ttl#this'),
        namedNode('https://pod.example/alice/.data/contacts/secretary.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/favorites/2026/05/18.ttl#favorite_1'),
        namedNode(RDF_TYPE),
        namedNode(SCHEMA_CREATIVE_WORK),
        namedNode('https://pod.example/alice/.data/favorites/2026/05/18.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/favorites/2026/05/18.ttl#favorite_1'),
        namedNode(`${UDFS}favoriteTarget`),
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl#this'),
        namedNode('https://pod.example/alice/.data/favorites/2026/05/18.ttl'),
      ),
      ...rdfModelsRuntimeAiQuads(),
    ]);

    const baselineCaseNames = new Set([
      'list chats',
      'list tasks',
      'list threads by chat',
      'list threads by task',
      'list messages by thread',
      'latest message',
      'latest run',
      'pending runs',
      'running runs',
      'runs by workspace',
      'runs by numeric priority',
      'run with steps',
      'load by exact id',
      'list providers',
      'models by provider',
      'credentials by provider',
      'list agents',
      'list contacts',
      'list favorites',
      'list sessions',
      'active sessions',
      'list ai configs',
      'active vector stores',
      'indexed files by status',
      'running agent statuses',
    ]);
    const baselineQueryCaseNames = new Set([
      'latest message by thread query',
      'thread message keyset page query',
      'thread context window query',
      'next queued run by workspace query',
      'run steps by run query',
      'task run execution detail query',
      'task materialization active due query',
      'provider model credential join query',
      'provider model credential VALUES join query',
      'provider model credential ordered join query',
      'ai credential selection query',
      'provider model credential count query',
      'provider credential grouped count query',
      'provider credential single-pattern grouped count query',
      'provider credential fail count aggregate query',
      'favorite target chat join query',
      'contact entity profile join query',
      'active session thread hydration query',
      'ai config embedding model query',
      'vector indexed file store query',
      'message count by thread with having',
      'queued run priority numeric aggregate',
      'message score by thread numeric aggregate',
      'message join count distinct',
    ]);
    const report = runRdfModelsBenchmark(engine, {
      scale: 'small',
      iterations: 2,
      cases: rdfModelsBenchmarkCasesForProfile('default').filter((testCase) => baselineCaseNames.has(testCase.name)),
      queryCases: rdfModelsQueryBenchmarkCasesForProfile('default')
        .filter((testCase) => baselineQueryCaseNames.has(testCase.name)),
    });
    const byName = new Map(report.cases.map((testCase) => [testCase.name, testCase]));

    expect(report.engine).toBe('solid-rdf');
    expect(report.caseProfile).toBe('default');
    expect(report.iterations).toBe(2);
    expect(report.cases).toHaveLength(baselineCaseNames.size);
    expect(report.queryCases).toHaveLength(baselineQueryCaseNames.size);
    expect(report.failedPlanCases).toEqual([]);
    expect(report.planMatched).toBe(true);
    expect(report.storage.derivedIndexProfile).toBe('baseline');
    expect(report.storage.facts.quadCount).toBeGreaterThan(0);
    expect(report.storage.factsBytes).toBeGreaterThan(0);
    expect(report.storage.totalBytes).toBeGreaterThanOrEqual(report.storage.factsBytes);
    expect(report.cases.every((testCase) => testCase.planMatched)).toBe(true);
    expect(byName.get('list chats')).toMatchObject({
      returnedRows: 1,
      scannedRows: 1,
      indexChoice: 'GPOS',
      joinOrder: ['GPOS'],
      fallbackReason: null,
      metrics: { indexChoice: 'GPOS', matchedRows: 1, returnedRows: 1 },
    });
    expect(byName.get('list chats')?.physicalPlan.some((entry) => entry.includes('SELECT'))).toBe(true);
    expect(byName.get('pending runs')).toMatchObject({
      returnedRows: 1,
      metrics: { indexChoice: 'GPOS', matchedRows: 1, returnedRows: 1 },
    });
    expect(byName.get('running runs')).toMatchObject({
      returnedRows: 1,
      metrics: { indexChoice: 'GPOS', matchedRows: 1, returnedRows: 1 },
    });
    expect(byName.get('latest run')).toMatchObject({
      returnedRows: 1,
      metrics: { indexChoice: 'GPOS', matchedRows: 1, returnedRows: 1 },
    });
    expect(byName.get('runs by workspace')).toMatchObject({
      returnedRows: 1,
      metrics: { indexChoice: 'GPOS', matchedRows: 1, returnedRows: 1 },
    });
    expect(byName.get('runs by numeric priority')).toMatchObject({
      returnedRows: 1,
      metrics: { indexChoice: 'GPOS', matchedRows: 1, returnedRows: 1 },
    });
    expect(byName.get('runs by numeric priority')?.metrics.queryPlan).toContain('NumericRange(object$gt)');
    expect(byName.get('runs by numeric priority')?.metrics.queryPlan?.join('\n')).toContain('JOIN rdf_terms object_id_numeric_range_gt');
    expect(byName.get('models by provider')).toMatchObject({
      returnedRows: 1,
      metrics: { indexChoice: 'POSG', matchedRows: 1, returnedRows: 1 },
    });
    expect(byName.get('credentials by provider')).toMatchObject({
      returnedRows: 1,
      metrics: { indexChoice: 'POSG', matchedRows: 1, returnedRows: 1 },
    });
    expect(byName.get('list agents')).toMatchObject({
      returnedRows: 1,
      metrics: { indexChoice: 'GPOS', matchedRows: 1, returnedRows: 1 },
    });
    expect(byName.get('list contacts')).toMatchObject({
      returnedRows: 1,
      metrics: { indexChoice: 'GPOS', matchedRows: 1, returnedRows: 1 },
    });
    expect(byName.get('list favorites')).toMatchObject({
      returnedRows: 1,
      metrics: { indexChoice: 'GPOS', matchedRows: 1, returnedRows: 1 },
    });
    expect(byName.get('search message literals')).toBeUndefined();
    expect(byName.get('task materialization due time')).toBeUndefined();
    expect(byName.get('list chats')?.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(byName.get('list chats')?.durationsMs).toHaveLength(2);
    expect(byName.get('list chats')?.indexStats.quadCount).toBe(84);
    expect(byName.get('list chats')?.indexStats.tableBytes).toBeGreaterThan(0);
    expect(byName.get('list chats')?.indexStats.indexBytes).toBeGreaterThan(0);
    expect(byName.get('list chats')?.indexStats.spaceObjects.some((object) => object.kind === 'table')).toBe(true);
    expect(byName.get('list chats')?.indexStats.spaceObjects.some((object) => object.kind === 'index')).toBe(true);
    expect(byName.get('list chats')?.query.pattern).toMatchObject({
      predicate: RDF_TYPE,
      object: 'http://www.w3.org/ns/pim/meeting#LongChat',
      graph: { $startsWith: 'https://pod.example/alice/.data/chat/' },
    });
    const groupedMessages = report.queryCases.find((testCase) => testCase.name === 'message count by thread with having');
    const messageScoreByThread = report.queryCases.find((testCase) => testCase.name === 'message score by thread numeric aggregate');
    const latestMessageByThread = report.queryCases.find((testCase) => testCase.name === 'latest message by thread query');
    const threadMessageKeysetPage = report.queryCases.find((testCase) => testCase.name === 'thread message keyset page query');
    const threadContextWindow = report.queryCases.find((testCase) => testCase.name === 'thread context window query');
    const nextQueuedRun = report.queryCases.find((testCase) => testCase.name === 'next queued run by workspace query');
    const runSteps = report.queryCases.find((testCase) => testCase.name === 'run steps by run query');
    const taskRunExecution = report.queryCases.find((testCase) => testCase.name === 'task run execution detail query');
    const taskMaterialization = report.queryCases.find((testCase) => testCase.name === 'task materialization active due query');
    const aiCredentialSelection = report.queryCases.find((testCase) => testCase.name === 'ai credential selection query');
    expect(latestMessageByThread).toMatchObject({
      planMatched: true,
      missingPlan: [],
      returnedRows: 1,
      query: {
        patterns: [
          {
            subject: { variable: 'message' },
            predicate: SIOC_HAS_MEMBER,
            object: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
          },
          {
            graph: { $startsWith: 'https://pod.example/alice/.data/chat/default/' },
            subject: { variable: 'message' },
            predicate: DCT_CREATED,
            object: { variable: 'createdAt' },
          },
        ],
        select: ['message', 'createdAt'],
        orderBy: [{ variable: 'createdAt', direction: 'desc' }],
        limit: 1,
      },
      metrics: {
        returnedRows: 1,
      },
    });
    expect(latestMessageByThread?.physicalPlan).toContain('IndexJoinOrder(desc:createdAt)');
    expect(latestMessageByThread?.physicalPlan).toContain('IndexJoinLimit');
    expect(latestMessageByThread?.checksum).toBe(latestMessageByThread?.orderedChecksum);
    expect(latestMessageByThread?.physicalPlan.some((entry) => entry.startsWith('IndexScan('))).toBe(false);
    expect(threadMessageKeysetPage).toMatchObject({
      planMatched: true,
      missingPlan: [],
      returnedRows: 2,
      query: {
        filters: [
          {
            variable: 'createdAt',
            operator: '$lt',
            value: '"2026-05-18T01:04:03.000Z"',
          },
        ],
        select: ['message', 'createdAt'],
        orderBy: [{ variable: 'createdAt', direction: 'desc' }],
        limit: 2,
      },
      metrics: {
        filtersApplied: 0,
        filtersPushedDown: 1,
        returnedRows: 2,
      },
    });
    expect(threadMessageKeysetPage?.physicalPlan).toContain('LexicalRange(object$lt)');
    expect(threadMessageKeysetPage?.physicalPlan).toContain('IndexJoinOrder(desc:createdAt)');
    expect(threadMessageKeysetPage?.physicalPlan).toContain('IndexJoinLimit');
    expect(threadMessageKeysetPage?.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(threadMessageKeysetPage?.orderedChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(threadMessageKeysetPage?.physicalPlan.some((entry) => entry.startsWith('IndexScan('))).toBe(false);
    expect(threadContextWindow).toMatchObject({
      planMatched: true,
      missingPlan: [],
      returnedRows: 3,
      query: {
        select: ['message', 'createdAt', 'score'],
        orderBy: [{ variable: 'createdAt', direction: 'desc' }],
        limit: 20,
      },
      metrics: {
        returnedRows: 3,
      },
    });
    expect(threadContextWindow?.physicalPlan).toContain('IndexJoinOrder(desc:createdAt)');
    expect(threadContextWindow?.physicalPlan).toContain('IndexJoinLimit');
    expect(threadContextWindow?.physicalPlan.some((entry) => entry.startsWith('IndexScan('))).toBe(false);
    expect(nextQueuedRun).toMatchObject({
      planMatched: true,
      missingPlan: [],
      returnedRows: 1,
      query: {
        patterns: [
          {
            graph: { $startsWith: 'https://pod.example/alice/.data/task/default/' },
            subject: { variable: 'run' },
            predicate: `${UDFS}status`,
            object: '"queued"',
          },
          {
            graph: { $startsWith: 'https://pod.example/alice/.data/task/default/' },
            subject: { variable: 'run' },
            predicate: `${UDFS}workspace`,
            object: 'file://macbook.local/Users/alice/project/',
          },
          {
            graph: { $startsWith: 'https://pod.example/alice/.data/task/default/' },
            subject: { variable: 'run' },
            predicate: DCT_CREATED,
            object: { variable: 'createdAt' },
          },
        ],
        select: ['run', 'createdAt'],
        orderBy: [{ variable: 'createdAt', direction: 'asc' }],
        limit: 1,
      },
      metrics: {
        returnedRows: 1,
      },
    });
    expect(nextQueuedRun?.physicalPlan).toContain('IndexJoinOrder(asc:createdAt)');
    expect(nextQueuedRun?.physicalPlan).toContain('IndexJoinLimit');
    expect(nextQueuedRun?.physicalPlan.some((entry) => entry.startsWith('IndexScan('))).toBe(false);
    expect(runSteps).toMatchObject({
      planMatched: true,
      missingPlan: [],
      returnedRows: 2,
      query: {
        patterns: [
          {
            graph: { $startsWith: 'https://pod.example/alice/.data/task/default/2026/05/' },
            subject: { variable: 'step' },
            predicate: RDF_TYPE,
            object: `${UDFS}RunStep`,
          },
          {
            graph: { $startsWith: 'https://pod.example/alice/.data/task/default/2026/05/' },
            subject: { variable: 'step' },
            predicate: `${UDFS}run`,
            object: 'https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_1',
          },
        ],
        select: ['step'],
        orderBy: [{ variable: 'step', direction: 'asc' }],
        limit: 50,
      },
      metrics: {
        returnedRows: 2,
      },
    });
    expect(runSteps?.physicalPlan).toContain('IndexJoinOrder(asc:step)');
    expect(runSteps?.physicalPlan).toContain('IndexJoinLimit');
    expect(runSteps?.physicalPlan.some((entry) => entry.startsWith('IndexScan('))).toBe(false);
    expect(taskRunExecution).toMatchObject({
      planMatched: true,
      missingPlan: [],
      returnedRows: 2,
      query: {
        select: ['task', 'run', 'thread', 'step', 'stepType'],
        orderBy: [{ variable: 'step', direction: 'asc' }],
        limit: 10,
      },
      metrics: {
        returnedRows: 2,
      },
    });
    expect(taskRunExecution?.physicalPlan).toContain('IndexJoinOrder(asc:step)');
    expect(taskRunExecution?.physicalPlan).toContain('IndexJoinLimit');
    expect(taskRunExecution?.physicalPlan.some((entry) => entry.startsWith('IndexScan('))).toBe(false);
    expect(taskMaterialization).toMatchObject({
      planMatched: true,
      missingPlan: [],
      returnedRows: 1,
      query: {
        patterns: [
          {
            graph: { $startsWith: 'https://pod.example/alice/.data/task/default/' },
            subject: { variable: 'schedule' },
            predicate: RDF_TYPE,
            object: `${UDFS}Schedule`,
          },
          {
            graph: { $startsWith: 'https://pod.example/alice/.data/task/default/' },
            subject: { variable: 'schedule' },
            predicate: `${UDFS}status`,
            object: '"active"',
          },
          {
            graph: { $startsWith: 'https://pod.example/alice/.data/task/default/' },
            subject: { variable: 'schedule' },
            predicate: `${UDFS}nextRunAt`,
            object: { variable: 'nextRunAt' },
          },
        ],
        filters: [
          {
            variable: 'nextRunAt',
            operator: '$lte',
            value: '"2026-05-18T01:30:00.000Z"',
          },
        ],
        select: ['schedule', 'nextRunAt'],
        orderBy: [{ variable: 'nextRunAt', direction: 'asc' }],
        limit: 100,
      },
      metrics: {
        filtersApplied: 0,
        filtersPushedDown: 1,
        returnedRows: 1,
      },
    });
    expect(taskMaterialization?.physicalPlan).toContain('LexicalRange(object$lte)');
    expect(taskMaterialization?.physicalPlan).toContain('IndexJoinOrder(asc:nextRunAt)');
    expect(taskMaterialization?.physicalPlan).toContain('IndexJoinLimit');
    expect(taskMaterialization?.physicalPlan.some((entry) => entry.startsWith('IndexScan('))).toBe(false);
    expect(aiCredentialSelection).toMatchObject({
      planMatched: true,
      missingPlan: [],
      returnedRows: 1,
      query: {
        select: ['provider', 'model', 'credential', 'apiKey', 'failCount'],
        orderBy: [{ variable: 'failCount', direction: 'asc' }],
        limit: 1,
      },
      metrics: {
        returnedRows: 1,
      },
    });
    expect(aiCredentialSelection?.physicalPlan).toContain('IndexJoinOrder(asc:failCount)');
    expect(aiCredentialSelection?.physicalPlan).toContain('IndexJoinLimit');
    expect(aiCredentialSelection?.physicalPlan.some((entry) => entry.startsWith('IndexScan('))).toBe(false);
    expect(groupedMessages).toMatchObject({
      planMatched: true,
      missingPlan: [],
      returnedRows: 1,
      metrics: {
        filtersApplied: 0,
        filtersPushedDown: 1,
        returnedRows: 1,
      },
    });
    expect(groupedMessages?.physicalPlan).toContain('IndexGroupCountHaving(?count$gt)');
    expect(groupedMessages?.physicalPlan).toContain('IndexGroupCountLimit');
    expect(groupedMessages?.physicalPlan).not.toContain('Having(?count$gt)');
    expect(groupedMessages?.physicalPlan).not.toContain('Limit');
    expect(messageScoreByThread).toMatchObject({
      planMatched: true,
      missingPlan: [],
      returnedRows: 1,
      metrics: {
        filtersApplied: 0,
        filtersPushedDown: 2,
        returnedRows: 1,
      },
    });
    expect(messageScoreByThread?.physicalPlan).toContain('JoinGroupAggregateNumeric(?score)');
    expect(messageScoreByThread?.physicalPlan).toContain('IndexGroupAggregateHaving(?scoreTotal$gt)');
    expect(messageScoreByThread?.physicalPlan).toContain('IndexGroupAggregateLimit');
    expect(messageScoreByThread?.physicalPlan).not.toContain('Having(?scoreTotal$gt)');
    expect(messageScoreByThread?.physicalPlan).not.toContain('Limit');
    const joinCount = report.queryCases.find((testCase) => testCase.name === 'message join count distinct');
    expect(joinCount).toMatchObject({
      planMatched: true,
      missingPlan: [],
      returnedRows: 1,
      metrics: {
        returnedRows: 1,
      },
    });
    expect(joinCount?.physicalPlan).toContain('Aggregate(join-count-distinct-index)');
    expect(joinCount?.physicalPlan.some((entry) => entry.startsWith('IndexJoinCount('))).toBe(true);
    expect(joinCount?.physicalPlan.some((entry) => entry.startsWith('IndexScan('))).toBe(false);
  });

  it('keeps the models text-search benchmark case on the embedded text index path', () => {
    const quads = [
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1'),
        namedNode('http://rdfs.org/sioc/ns#content'),
        literal('canonical message without keyword'),
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2'),
        namedNode('http://rdfs.org/sioc/ns#content'),
        literal('synthetic searchable message'),
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
    ];
    for (let index = 0; index < 55; index += 1) {
      quads.push(quad(
        namedNode(`https://pod.example/alice/.data/chat/default/2026/05/19/messages.ttl#searchable_${index}`),
        namedNode('http://rdfs.org/sioc/ns#content'),
        literal(`synthetic searchable page candidate ${index}`),
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/19/messages.ttl'),
      ));
    }
    engine.put(quads);

    const report = runRdfModelsBenchmark(engine, { scale: 'medium', iterations: 1 });
    const search = report.cases.find((testCase) => testCase.name === 'search message literals');

    expect(search).toMatchObject({
      planMatched: true,
      missingPlan: [],
      returnedRows: 50,
      metrics: {
        indexChoice: 'GPOS',
        matchedRows: 56,
        returnedRows: 50,
      },
    });
    expect(search?.planMatched).toBe(true);
    expect(search?.metrics.queryPlan).toContain('TextSearch(object$contains)');
    expect(search?.metrics.queryPlan?.join('\n')).toContain('JOIN rdf_terms prefix_graph_id');
    expect(search?.metrics.queryPlan?.join('\n')).toContain('JOIN rdf_terms text_object_id_contains');
    expect(search?.metrics.queryPlan?.join('\n')).not.toContain('rdf_quads.graph_id IN (?, ?, ?, ?, ?,');
    expect(search?.query.pattern).toMatchObject({
      object: { $contains: 'searchable' },
    });
  });

  it('keeps the models range benchmark case on term JOIN planning', () => {
    engine.put([
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/schedule.ttl#daily'),
        namedNode(`${UDFS}nextRunAt`),
        literal('2026-05-18T01:00:00.000Z'),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/schedule.ttl'),
      ),
    ]);

    const report = runRdfModelsBenchmark(engine, { scale: 'medium', iterations: 1 });
    const range = report.cases.find((testCase) => testCase.name === 'task materialization due time');

    expect(range).toMatchObject({
      planMatched: true,
      missingPlan: [],
      metrics: {
        indexChoice: 'GPOS',
        returnedRows: 1,
      },
    });
    expect(range?.metrics.queryPlan).toContain('LexicalRange(object$lte)');
    expect(range?.metrics.queryPlan?.join('\n')).toContain('JOIN rdf_terms object_id_range_lte');
    expect(range?.metrics.queryPlan?.join('\n')).not.toContain('object_id IN (\n        SELECT');
  });

  it('exposes the derived text index without changing quad authority', async () => {
    const textEngine = new SolidRdfEngine({
      index: { path: ':memory:' },
      textIndex: { path: ':memory:' },
      autoOpen: true,
    });

    try {
      textEngine.indexTextSource({
        source: 'https://pod.example/alice/projects/demo/README.md',
        workspace: 'https://pod.example/alice/projects/demo/',
        localPath: 'README.md',
        contentType: 'text/markdown',
      }, '# Runbook\n\nUse managed runtime for agent runs.\n');

      expect(textEngine.searchText({
        query: 'managed runtime',
        workspace: 'https://pod.example/alice/projects/demo/',
      })).toMatchObject([
        {
          source: 'https://pod.example/alice/projects/demo/README.md',
          heading: 'Runbook',
          path: ['Runbook'],
          score: 1,
        },
      ]);
      expect(textEngine.index.stats().quadCount).toBe(0);
    } finally {
      await textEngine.close();
    }
  });

  it('runs the models fusion profile through text, vector, and RDF sources', async () => {
    const fusionEngine = new SolidRdfEngine({
      index: { path: ':memory:' },
      textIndex: { path: ':memory:' },
      vectorIndex: { path: ':memory:' },
      autoOpen: true,
    });

    try {
      fusionEngine.put(buildRdfModelsBenchmarkSeed({
        syntheticMessages: defaultSyntheticMessagesForRdfModelsScale('small'),
        syntheticPodCount: rdfModelsBenchmarkSyntheticPodCount('small'),
        caseProfile: 'fusion',
      }));
      await seedRdfModelsSearchFusionIndexes(fusionEngine);

      const directResult = fusionEngine.query(rdfModelsQueryBenchmarkCasesForProfile('fusion')[0].query);
      const report = runRdfModelsBenchmark(fusionEngine, {
        scale: 'small',
        iterations: 1,
        caseProfile: 'fusion',
      });
      const fusion = report.queryCases.find((testCase) => testCase.name === 'agent context text vector fusion query');
      const broadFusion = report.queryCases.find((testCase) => testCase.name === 'broad agent context text vector fusion query');
      const planText = fusion?.physicalPlan.join('\n') ?? '';

      expect(report.cases).toEqual([]);
      expect(report.queryCases.map((testCase) => testCase.name)).toEqual(rdfModelsSearchFusionQueryBenchmarkCaseNames());
      expect(fusion).toBeDefined();
      expect(broadFusion).toBeDefined();
      expect(fusion?.planMatched).toBe(true);
      expect(fusion?.missingPlan).toEqual([]);
      expect(fusion?.returnedRows).toBe(2);
      expect(fusion?.indexChoices).toContain('text-chunk');
      expect(fusion?.indexChoices).toContain('vector-chunk');
      expect(broadFusion?.planMatched).toBe(true);
      expect(broadFusion?.missingPlan).toEqual([]);
      expect(broadFusion?.returnedRows).toBeGreaterThan(0);
      expect(planText).toContain('TextSearch(');
      expect(planText).toContain('VectorSearch(');
      expect(planText).toContain('Bind(?fusionScore:=');
      expect(planText).toContain('Sort');
      expect(planText).toMatch(/IndexJoin\(|IndexScan\(/);
      expect(directResult.bindings.map((binding) => binding.message?.value)).toEqual([
        'https://pod.example/alice/.data/chat/default/2026/05/01/messages.ttl#synthetic_0',
        'https://pod.example/alice/.data/chat/default/2026/05/02/messages.ttl#synthetic_1',
      ]);
      const scores = directResult.bindings.map((binding) => Number(binding.fusionScore?.value));
      expect(scores.every((score) => Number.isFinite(score))).toBe(true);
      expect(scores[0]).toBeGreaterThanOrEqual(scores[1]);
    } finally {
      await fusionEngine.close();
    }
  });

  it('rebuilds RDF quads for an authority source without appending stale data', () => {
    const source = {
        source: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl',
      workspace: 'https://pod.example/alice/.data/chat/default/',
      localPath: '.data/chat/default/2026/05/18/messages.ttl',
      contentType: 'text/turtle',
      sourceVersion: 'v1',
    };

    engine.replaceSource([
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1'),
        namedNode('http://rdfs.org/sioc/ns#content'),
        literal('stale message'),
        namedNode(source.source),
      ),
    ], source);
    engine.replaceSource([
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2'),
        namedNode('http://rdfs.org/sioc/ns#content'),
        literal('fresh message'),
        namedNode(source.source),
      ),
    ], { ...source, sourceVersion: 'v2' });

    const result = engine.scan({
      pattern: {
        graph: namedNode(source.source),
      },
    });

    expect(result.quads.map((q) => q.object.value)).toEqual(['fresh message']);
    expect(result.metrics.indexChoice).toBe('GSPO');
    expect(engine.index.stats()).toMatchObject({
      quadCount: 1,
      sourceCount: 1,
    });
  });

  it('runs a models benchmark shadow report against the RDF-3X shadow index', () => {
    const quads = [
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl#this'),
        namedNode(RDF_TYPE),
        namedNode('http://www.w3.org/ns/pim/meeting#LongChat'),
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/index.ttl#task_1'),
        namedNode(RDF_TYPE),
        namedNode(`${UDFS}Task`),
        namedNode('https://pod.example/alice/.data/task/index.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_1'),
        namedNode(RDF_TYPE),
        namedNode('http://rdfs.org/sioc/ns#Thread'),
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1'),
        namedNode(RDF_TYPE),
        namedNode(MEETING_MESSAGE),
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1'),
        namedNode(SIOC_HAS_MEMBER),
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_1'),
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1'),
        namedNode(`${UDFS}score`),
        literal('2', namedNode(XSD_INTEGER)),
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2'),
        namedNode(RDF_TYPE),
        namedNode(MEETING_MESSAGE),
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2'),
        namedNode(SIOC_HAS_MEMBER),
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_1'),
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2'),
        namedNode(`${UDFS}score`),
        literal('10', namedNode(XSD_INTEGER)),
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3'),
        namedNode(RDF_TYPE),
        namedNode(MEETING_MESSAGE),
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3'),
        namedNode(SIOC_HAS_MEMBER),
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_1'),
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3'),
        namedNode(`${UDFS}score`),
        literal('4', namedNode(XSD_INTEGER)),
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1'),
        namedNode(DCT_CREATED),
        literal('2026-05-18T01:02:03.000Z'),
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2'),
        namedNode(DCT_CREATED),
        literal('2026-05-18T01:03:03.000Z'),
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3'),
        namedNode(DCT_CREATED),
        literal('2026-05-18T01:04:03.000Z'),
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1'),
        namedNode(SIOC_CONTENT),
        literal('alpha searchable note'),
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_1'),
        namedNode(RDF_TYPE),
        namedNode(`${UDFS}Run`),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_1'),
        namedNode(`${UDFS}status`),
        literal('queued'),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_1'),
        namedNode(`${UDFS}task`),
        namedNode('https://pod.example/alice/.data/task/index.ttl#task_1'),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_1'),
        namedNode(`${UDFS}inThread`),
        namedNode('https://pod.example/alice/.data/task/default/index.ttl#thread_1'),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_1'),
        namedNode(`${UDFS}workspace`),
        namedNode('file://macbook.local/Users/alice/project/'),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_1'),
        namedNode(DCT_CREATED),
        literal('2026-05-18T01:00:00.000Z'),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_1'),
        namedNode(`${UDFS}priority`),
        literal('10', namedNode(XSD_INTEGER)),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#step_1'),
        namedNode(RDF_TYPE),
        namedNode(`${UDFS}RunStep`),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#step_1'),
        namedNode(`${UDFS}run`),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_1'),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#step_1'),
        namedNode(`${UDFS}status`),
        literal('runtime.tool_call'),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#step_2'),
        namedNode(RDF_TYPE),
        namedNode(`${UDFS}RunStep`),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#step_2'),
        namedNode(`${UDFS}run`),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_1'),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#step_2'),
        namedNode(`${UDFS}status`),
        literal('run.completed'),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
        namedNode(RDF_TYPE),
        namedNode(`${XPOD_AI}Provider`),
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
        namedNode(`${XPOD_AI}defaultModel`),
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl#claude-sonnet-4'),
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl#claude-sonnet-4'),
        namedNode(`${XPOD_AI}isProvidedBy`),
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl#claude-sonnet-4'),
        namedNode(`${XPOD_AI}status`),
        literal('active'),
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/settings/credentials.ttl#anthropic-default'),
        namedNode(`${XPOD_CREDENTIAL}provider`),
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
        namedNode('https://pod.example/alice/settings/credentials.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/settings/credentials.ttl#anthropic-default'),
        namedNode(`${XPOD_CREDENTIAL}service`),
        literal('ai'),
        namedNode('https://pod.example/alice/settings/credentials.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/settings/credentials.ttl#anthropic-default'),
        namedNode(`${XPOD_CREDENTIAL}status`),
        literal('active'),
        namedNode('https://pod.example/alice/settings/credentials.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/settings/credentials.ttl#anthropic-default'),
        namedNode(`${XPOD_CREDENTIAL}apiKey`),
        literal('sk-ant-test'),
        namedNode('https://pod.example/alice/settings/credentials.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/settings/credentials.ttl#anthropic-default'),
        namedNode(`${XPOD_CREDENTIAL}isDefault`),
        literal('true', namedNode(XSD_BOOLEAN)),
        namedNode('https://pod.example/alice/settings/credentials.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/settings/credentials.ttl#anthropic-default'),
        namedNode(`${XPOD_CREDENTIAL}failCount`),
        literal('15', namedNode(XSD_INTEGER)),
        namedNode('https://pod.example/alice/settings/credentials.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/index.ttl#thread_1'),
        namedNode(RDF_TYPE),
        namedNode('http://rdfs.org/sioc/ns#Thread'),
        namedNode('https://pod.example/alice/.data/task/default/index.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_2'),
        namedNode(`${UDFS}status`),
        literal('running'),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1'),
        namedNode(DCT_MODIFIED),
        literal('2026-05-18T01:03:00.000Z'),
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/settings/models/claude.ttl'),
        namedNode(`${XPOD_AI}isProvidedBy`),
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
        namedNode('https://pod.example/alice/settings/models/claude.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/settings/credentials/anthropic.ttl'),
        namedNode(`${XPOD_CREDENTIAL}provider`),
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
        namedNode('https://pod.example/alice/settings/credentials/anthropic.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/settings/credentials/anthropic.ttl'),
        namedNode(`${XPOD_CREDENTIAL}failCount`),
        literal('15', namedNode(XSD_INTEGER)),
        namedNode('https://pod.example/alice/settings/credentials/anthropic.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/agents/secretary.ttl#this'),
        namedNode(RDF_TYPE),
        namedNode(FOAF_AGENT),
        namedNode('https://pod.example/alice/.data/agents/secretary.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/contacts/secretary.ttl'),
        namedNode(RDF_TYPE),
        namedNode(VCARD_INDIVIDUAL),
        namedNode('https://pod.example/alice/.data/contacts/secretary.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/contacts/secretary.ttl'),
        namedNode(FOAF_PRIMARY_TOPIC),
        namedNode('https://pod.example/alice/.data/agents/secretary.ttl#this'),
        namedNode('https://pod.example/alice/.data/contacts/secretary.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/favorites/2026/05/18.ttl#favorite_1'),
        namedNode(RDF_TYPE),
        namedNode(SCHEMA_CREATIVE_WORK),
        namedNode('https://pod.example/alice/.data/favorites/2026/05/18.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/favorites/2026/05/18.ttl#favorite_1'),
        namedNode(`${UDFS}favoriteTarget`),
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl#this'),
        namedNode('https://pod.example/alice/.data/favorites/2026/05/18.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/profile/card#me'),
        namedNode(RDF_TYPE),
        namedNode(FOAF_PERSON),
        namedNode('https://pod.example/alice/profile/card'),
      ),
      quad(
        namedNode('https://pod.example/alice/profile/card#me'),
        namedNode(VCARD_FN),
        literal('Alice'),
        namedNode('https://pod.example/alice/profile/card'),
      ),
      quad(
        namedNode('https://pod.example/alice/profile/card#me'),
        namedNode(LDP_INBOX),
        namedNode('https://pod.example/alice/inbox/'),
        namedNode('https://pod.example/alice/profile/card'),
      ),
      quad(
        namedNode('https://pod.example/alice/profile/card.acl#public'),
        namedNode(RDF_TYPE),
        namedNode(`${ACL}Authorization`),
        namedNode('https://pod.example/alice/profile/card.acl'),
      ),
      quad(
        namedNode('https://pod.example/alice/profile/card.acl#public'),
        namedNode(`${ACL}accessTo`),
        namedNode('https://pod.example/alice/profile/card'),
        namedNode('https://pod.example/alice/profile/card.acl'),
      ),
      quad(
        namedNode('https://pod.example/alice/profile/card.acl#public'),
        namedNode(`${ACL}mode`),
        namedNode(`${ACL}Read`),
        namedNode('https://pod.example/alice/profile/card.acl'),
      ),
      quad(
        namedNode('https://pod.example/alice/profile/card'),
        namedNode(`${ACP}accessControl`),
        namedNode('https://pod.example/alice/profile/.acr#publicReadAccess'),
        namedNode('https://pod.example/alice/profile/.acr'),
      ),
      quad(
        namedNode('https://pod.example/alice/profile/.acr#publicReadAccess'),
        namedNode(`${ACP}apply`),
        namedNode('https://pod.example/alice/profile/card'),
        namedNode('https://pod.example/alice/profile/.acr'),
      ),
      quad(
        namedNode('https://pod.example/alice/profile/.acr#publicReadAccess'),
        namedNode(`${ACP}allow`),
        namedNode(`${ACP}Read`),
        namedNode('https://pod.example/alice/profile/.acr'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/issues/issue_1.ttl'),
        namedNode(RDF_TYPE),
        namedNode(`${UDFS}Issue`),
        namedNode('https://pod.example/alice/.data/issues/issue_1.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/issues/issue_1.ttl'),
        namedNode(DCT_TITLE),
        literal('Profile access regression'),
        namedNode('https://pod.example/alice/.data/issues/issue_1.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/issues/issue_1.ttl'),
        namedNode(`${UDFS}status`),
        literal('open'),
        namedNode('https://pod.example/alice/.data/issues/issue_1.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/approvals/2026/05/18.ttl#approval_1'),
        namedNode(RDF_TYPE),
        namedNode(`${UDFS}ApprovalRequest`),
        namedNode('https://pod.example/alice/.data/approvals/2026/05/18.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/approvals/2026/05/18.ttl#approval_1'),
        namedNode(`${UDFS}status`),
        literal('pending'),
        namedNode('https://pod.example/alice/.data/approvals/2026/05/18.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/approvals/2026/05/18.ttl#approval_1'),
        namedNode(`${ODRL}action`),
        namedNode(`${UDFS}runTool`),
        namedNode('https://pod.example/alice/.data/approvals/2026/05/18.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/approvals/2026/05/18.ttl#approval_1'),
        namedNode(`${ODRL}target`),
        namedNode('file://macbook.local/Users/alice/project/'),
        namedNode('https://pod.example/alice/.data/approvals/2026/05/18.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/settings/autonomy/grants/default.ttl'),
        namedNode(RDF_TYPE),
        namedNode(`${UDFS}AutonomyGrant`),
        namedNode('https://pod.example/alice/settings/autonomy/grants/default.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/settings/autonomy/grants/default.ttl'),
        namedNode(`${ODRL}action`),
        namedNode(`${UDFS}runTool`),
        namedNode('https://pod.example/alice/settings/autonomy/grants/default.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/settings/autonomy/grants/default.ttl'),
        namedNode(`${ODRL}target`),
        namedNode('file://macbook.local/Users/alice/project/'),
        namedNode('https://pod.example/alice/settings/autonomy/grants/default.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/settings/autonomy/grants/default.ttl'),
        namedNode(`${UDFS}effect`),
        literal('allow'),
        namedNode('https://pod.example/alice/settings/autonomy/grants/default.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/inbox/notification_1.ttl'),
        namedNode(RDF_TYPE),
        namedNode(`${AS}Activity`),
        namedNode('https://pod.example/alice/inbox/notification_1.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/inbox/notification_1.ttl'),
        namedNode(`${AS}actor`),
        namedNode('https://pod.example/alice/profile/card#me'),
        namedNode('https://pod.example/alice/inbox/notification_1.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/schedules.ttl#schedule_1'),
        namedNode(RDF_TYPE),
        namedNode(`${UDFS}Schedule`),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/schedules.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/schedules.ttl#schedule_1'),
        namedNode(`${UDFS}status`),
        literal('active'),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/schedules.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/schedules.ttl#schedule_1'),
        namedNode(`${UDFS}nextRunAt`),
        literal('2026-05-18T01:00:00.000Z'),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/schedules.ttl'),
      ),
      ...rdfModelsRuntimeAiQuads(),
    ];
    engine.index.multiPut(quads);

    const rdf3xShadowCaseNames = new Set([
      'list chats',
      'runs by numeric priority',
      'search message literals',
      'task materialization due time',
    ]);
    const rdf3xShadowQueryCaseNames = new Set([
      'latest message by thread query',
      'task materialization active due query',
      'message count by thread with having',
      'message score by thread numeric aggregate',
      'message join count distinct',
    ]);
    const rdf3xIndex = new Rdf3xIndex({ path: path.join(root, 'rdf.sqlite') });
    rdf3xIndex.open();
    try {
      const report = runRdfModelsRdf3xShadowBenchmark(engine, {
        rdf3xIndex,
        scale: 'medium',
      iterations: 1,
      cases: rdfModelsBenchmarkCasesForProfile('default').filter((testCase) => rdf3xShadowCaseNames.has(testCase.name)),
      queryCases: rdfModelsQueryBenchmarkCasesForProfile('default')
        .filter((testCase) => rdf3xShadowQueryCaseNames.has(testCase.name)),
    });
    const listChats = report.cases.find((testCase) => testCase.name === 'list chats');
    const numericPriority = report.cases.find((testCase) => testCase.name === 'runs by numeric priority');
    const latestMessageJoin = report.joinCases.find((testCase) => testCase.name === 'latest message by thread query');
    const taskMaterializationJoin = report.joinCases.find((testCase) => testCase.name === 'task materialization active due query');
    const messageCountByThread = report.joinCases.find((testCase) => testCase.name === 'message count by thread with having');
    const messageScoreByThread = report.joinCases.find((testCase) => testCase.name === 'message score by thread numeric aggregate');
    const messageJoinCount = report.joinCases.find((testCase) => testCase.name === 'message join count distinct');
    const searchMessages = report.cases.find((testCase) => testCase.name === 'search message literals');

    expect(report.engine).toBe('rdf3x-shadow');
    expect(report.rebuild.scannedQuads).toBe(quads.length);
    expect(report.storage.rdf3x).toBeUndefined();
    expect(report.storage.derivedBytes).toBe(0);
    expect(report.storage.totalBytes).toBe(report.storage.factsBytes);
    expect(report.skippedCases).not.toContain('runs by numeric priority');
    expect(report.skippedCases).not.toContain('search message literals');
    expect(report.skippedJoinCases).not.toContain('task materialization active due query');
    expect(report.failedPlanCases).toEqual([]);
    expect(report.planMatched).toBe(true);
    expect(report.failedJoinCases).toEqual([]);
    expect([...report.cases, ...report.joinCases]
      .filter((testCase) => testCase.supported)
      .every((testCase) => testCase.planMatched && testCase.missingPlan.length === 0)).toBe(true);
    expect([...report.cases, ...report.joinCases]
      .flatMap((testCase) => testCase.rdf3x?.physicalPlan ?? [])
      .some((entry) => /\bunresolved\b/i.test(entry))).toBe(false);
    expect(numericPriority).toMatchObject({
      supported: true,
      planMatched: true,
      missingPlan: [],
      matched: true,
      orderedMatch: true,
      solidRdf: { returnedRows: 1 },
      rdf3x: {
        returnedRows: 1,
        metrics: { indexChoice: 'source-membership', matchedRows: 1, returnedRows: 1 },
      },
    });
    expect(numericPriority?.unsupportedReason).toBeUndefined();
    expect(numericPriority?.rdf3x?.physicalPlan).toContain('NumericRange(object$gt)');
    expect(numericPriority?.rdf3x?.physicalPlan.join('\n')).toContain('JOIN rdf_terms object_range');
    expect(numericPriority?.rdf3x?.physicalPlan.join('\n')).toContain('ON object_range.id = membership.object_id');
    expect(searchMessages).toMatchObject({
      supported: true,
      planMatched: true,
      missingPlan: [],
      matched: true,
      orderedMatch: true,
      solidRdf: { returnedRows: 1 },
      rdf3x: {
        returnedRows: 1,
        metrics: { indexChoice: 'source-membership', matchedRows: 1, returnedRows: 1 },
      },
    });
    expect(searchMessages?.rdf3x?.physicalPlan).toContain('TextSearch(object$contains)');
    expect(listChats).toMatchObject({
      supported: true,
      planMatched: true,
      missingPlan: [],
      matched: true,
      orderedMatch: true,
      solidRdf: { returnedRows: 1 },
      rdf3x: {
        returnedRows: 1,
        metrics: { indexChoice: 'source-membership', matchedRows: 1, returnedRows: 1 },
      },
    });
    expect(listChats?.rdf3x?.physicalPlan).toContain('Rdf3xMembershipScan');
    expect(listChats?.rdf3x?.physicalPlan.join('\n')).toContain('GraphPrefixMembershipFilter');
    expect(latestMessageJoin).toMatchObject({
      supported: true,
      planMatched: true,
      missingPlan: [],
      matched: true,
      orderedMatch: true,
      solidRdf: { returnedRows: 1 },
      rdf3x: {
        returnedRows: 1,
        metrics: {
          engine: 'solid-rdf3x',
          returnedRows: 1,
        },
      },
    });
    expect(latestMessageJoin?.rdf3x?.physicalPlan).toContain('Rdf3xJoinBGP(2)');
    expect(latestMessageJoin?.rdf3x?.physicalPlan).toContain('Rdf3xJoinLimit');
    expect(taskMaterializationJoin).toMatchObject({
      supported: true,
      planMatched: true,
      missingPlan: [],
      matched: true,
      orderedMatch: true,
      solidRdf: { returnedRows: 1 },
      rdf3x: {
        returnedRows: 1,
        metrics: {
          engine: 'solid-rdf3x',
          returnedRows: 1,
        },
      },
    });
    expect(taskMaterializationJoin?.rdf3x?.physicalPlan).toContain('Rdf3xJoinBGP(3)');
    expect(taskMaterializationJoin?.rdf3x?.physicalPlan).toContain('LexicalRange(object$lte)');
    expect(messageCountByThread).toMatchObject({
      supported: true,
      planMatched: true,
      missingPlan: [],
      matched: true,
      orderedMatch: true,
      solidRdf: { returnedRows: 1 },
      rdf3x: {
        returnedRows: 1,
        metrics: {
          engine: 'solid-rdf3x',
          returnedRows: 1,
        },
      },
    });
    expect(messageCountByThread?.rdf3x?.physicalPlan).toContain('Rdf3xJoinGroupCount(?thread)');
    expect(messageCountByThread?.rdf3x?.physicalPlan).toContain('Rdf3xJoinGroupCountHaving(count$gt)');
    expect(messageScoreByThread).toMatchObject({
      supported: true,
      planMatched: true,
      missingPlan: [],
      matched: true,
      orderedMatch: true,
      solidRdf: { returnedRows: 1 },
      rdf3x: {
        returnedRows: 1,
        metrics: {
          engine: 'solid-rdf3x',
          returnedRows: 1,
        },
      },
    });
    expect(messageScoreByThread?.rdf3x?.physicalPlan).toContain('Rdf3xJoinGroupAggregateNumeric(?score)');
    expect(messageScoreByThread?.rdf3x?.physicalPlan).toContain('Rdf3xJoinGroupAggregateHaving(scoreTotal$gt)');
    expect(messageJoinCount).toMatchObject({
      supported: true,
      planMatched: true,
      missingPlan: [],
      matched: true,
      orderedMatch: true,
      rdf3x: {
        returnedRows: 1,
        metrics: {
          engine: 'solid-rdf3x',
          returnedRows: 1,
        },
      },
    });
      expect(messageJoinCount?.rdf3x?.physicalPlan).toContain('Rdf3xJoinCount(count(?message),count:DISTINCT(?thread))');
    } finally {
      rdf3xIndex.close();
    }
  });
});
