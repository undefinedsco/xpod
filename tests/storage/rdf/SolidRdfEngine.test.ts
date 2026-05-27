import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { DataFactory } from 'n3';
import { SqliteQuintStore } from '../../../src/storage/quint';
import {
  RdfQuadIndex,
  Rdf3xTripleIndex,
  SolidRdfEngine,
  defaultSyntheticMessagesForRdfModelsScale,
  estimateRdfModelsSyntheticQuadCount,
  rdfModelsBenchmarkCaseNames,
  rdfModelsLocalQueryBenchmarkCaseNames,
  rdfModelsBenchmarkScaleSatisfied,
  rdfModelsBenchmarkScaleTargetQuads,
  rdfModelsBenchmarkSyntheticPodCount,
  runRdfModelsBenchmark,
  runRdfModelsRdf3xShadowBenchmark,
  runRdfModelsShadowBenchmark,
} from '../../../src/storage/rdf';

const { namedNode, literal, quad } = DataFactory;
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const DCT_CREATED = 'http://purl.org/dc/terms/created';
const SIOC_HAS_MEMBER = 'http://rdfs.org/sioc/ns#has_member';
const UDFS = 'https://undefineds.co/ns#';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const FOAF_AGENT = 'http://xmlns.com/foaf/0.1/Agent';
const VCARD_INDIVIDUAL = 'http://www.w3.org/2006/vcard/ns#Individual';
const SCHEMA_CREATIVE_WORK = 'http://schema.org/CreativeWork';
const MEETING_MESSAGE = 'http://www.w3.org/ns/pim/meeting#Message';

describe('SolidRdfEngine', () => {
  let index: RdfQuadIndex;
  let rdf3xIndex: Rdf3xTripleIndex;
  let compatibilityStore: SqliteQuintStore;
  let engine: SolidRdfEngine;
  let root: string;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'xpod-solid-rdf-'));
    const dbPath = path.join(root, 'rdf.sqlite');
    index = new RdfQuadIndex({ path: dbPath });
    index.open();
    rdf3xIndex = new Rdf3xTripleIndex({ path: dbPath });
    rdf3xIndex.open();
    compatibilityStore = new SqliteQuintStore({ path: path.join(root, 'compat.sqlite') });
    await compatibilityStore.open();
    engine = new SolidRdfEngine({
      index,
      rdf3xIndex,
      compatibilityStore,
    });
  });

  afterEach(async () => {
    rdf3xIndex.close();
    index.close();
    await engine.close();
    await rm(root, { recursive: true, force: true });
  });

  it('runs a shadow compare against the compatibility quint store', async () => {
    const q = quad(
      namedNode('https://pod.example/alice/.data/chat/default/index.ttl#this'),
      namedNode('https://undefineds.co/ns#status'),
      literal('active'),
      namedNode('https://pod.example/alice/.data/chat/default/index.ttl'),
    );

    engine.put(q);
    await compatibilityStore.put(q);

    const result = await engine.shadowScan({
      pattern: {
        predicate: namedNode('https://undefineds.co/ns#status'),
        object: literal('active'),
      },
    });

    expect(result.matched).toBe(true);
    expect(result.diff).toEqual({
      missingFromPrimary: [],
      extraInPrimary: [],
    });
    expect(result.metrics.engine).toBe('solid-rdf');
  });

  it('runs a shadow compare against the RDF-3X shadow index', async () => {
    const graph = namedNode('https://pod.example/alice/.data/chat/default/index.ttl');
    const type = namedNode('https://undefineds.co/ns#type');
    const status = namedNode('https://undefineds.co/ns#status');
    const messageType = namedNode('https://type/Message');
    const message = namedNode('https://pod.example/alice/.data/chat/default/index.ttl#msg_1');

    index.multiPut([
      quad(message, type, messageType, graph),
      quad(message, status, literal('active'), graph),
    ]);

    const result = engine.shadowRdf3xScan({
      pattern: {
        predicate: type,
        object: messageType,
      },
    });

    expect(result.matched).toBe(true);
    expect(result.orderedMatch).toBe(true);
    expect(result.primary).toHaveLength(1);
    expect(result.rdf3x).toHaveLength(1);
    expect(result.rebuild.scannedQuads).toBe(2);
    expect(result.primaryMetrics.engine).toBe('solid-rdf');
    expect(result.rdf3xMetrics.engine).toBe('solid-rdf3x');
  });

  it('runs a shadow compare against the RDF-3X shadow index with graph prefix filters', async () => {
    const chatGraph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const taskGraph = namedNode('https://pod.example/alice/.data/task/secretary/2026/05/18/runs.ttl');
    const type = namedNode('https://undefineds.co/ns#type');
    const status = namedNode('https://undefineds.co/ns#status');
    const messageType = namedNode('https://type/Message');
    const message1 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1');
    const message2 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2');

    index.multiPut([
      quad(message1, type, messageType, chatGraph),
      quad(message1, status, literal('active'), chatGraph),
      quad(message1, status, literal('queued'), taskGraph),
      quad(message2, type, messageType, chatGraph),
    ]);

    const result = engine.shadowRdf3xScan({
      pattern: {
        graph: { $startsWith: 'https://pod.example/alice/.data/chat/' },
        predicate: status,
        object: literal('active'),
      },
    });

    expect(result.matched).toBe(true);
    expect(result.orderedMatch).toBe(true);
    expect(result.primary).toHaveLength(1);
    expect(result.rdf3x).toHaveLength(1);
    expect(result.rdf3xMetrics.queryPlan?.join('\n')).toContain('GraphPrefixMembershipFilter');
    expect(result.primaryMetrics.engine).toBe('solid-rdf');
    expect(result.rdf3xMetrics.engine).toBe('solid-rdf3x');
  });

  it('runs a shadow compare against the RDF-3X shadow index with numeric object ranges', () => {
    const xsdInteger = namedNode(XSD_INTEGER);
    const priority = namedNode(`${UDFS}priority`);
    const graph = namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl');

    index.multiPut([
      quad(namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_2'), priority, literal('2', xsdInteger), graph),
      quad(namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_10'), priority, literal('10', xsdInteger), graph),
      quad(namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_lexical'), priority, literal('9'), graph),
    ]);

    const result = engine.shadowRdf3xScan({
      pattern: {
        graph: { $startsWith: 'https://pod.example/alice/.data/task/' },
        predicate: priority,
        object: { $gt: literal('9', xsdInteger) },
      },
      options: { order: ['subject'] },
    });

    expect(result.matched).toBe(true);
    expect(result.orderedMatch).toBe(true);
    expect(result.primary).toHaveLength(1);
    expect(result.rdf3x.map((q) => q.subject.value)).toEqual(['https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_10']);
    expect(result.rdf3xMetrics.indexChoice).toBe('POS');
    expect(result.rdf3xMetrics.queryPlan?.join('\n')).toContain('NumericRange(object$gt)');
  });

  it('runs a shadow RDF-3X join compare against the baseline join planner', () => {
    const graph = namedNode('https://pod.example/alice/.data/chat/default/index.ttl');
    const type = namedNode('https://undefineds.co/ns#type');
    const content = namedNode('https://undefineds.co/ns#content');
    const messageType = namedNode('https://type/Message');
    const msg1 = namedNode('https://pod.example/alice/.data/chat/default/index.ttl#msg_1');
    const msg2 = namedNode('https://pod.example/alice/.data/chat/default/index.ttl#msg_2');

    index.multiPut([
      quad(msg1, type, messageType, graph),
      quad(msg1, content, literal('hello'), graph),
      quad(msg2, type, messageType, graph),
    ]);

    const result = engine.shadowRdf3xJoin([
      {
        pattern: {
          predicate: type,
          object: messageType,
        },
        variables: {
          subject: 'message',
        },
      },
      {
        pattern: {
          predicate: content,
        },
        variables: {
          subject: 'message',
          object: 'content',
        },
      },
    ]);

    expect(result.matched).toBe(true);
    expect(result.orderedMatch).toBe(true);
    expect(result.primary).toHaveLength(1);
    expect(result.rdf3x).toHaveLength(1);
    expect(result.rebuild.scannedQuads).toBe(3);
    expect(result.primaryMetrics.engine).toBe('solid-rdf');
    expect(result.rdf3xMetrics.engine).toBe('solid-rdf3x');
  });

  it('runs a shadow RDF-3X join compare with graph prefix filters', () => {
    const chatGraph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const taskGraph = namedNode('https://pod.example/alice/.data/task/secretary/2026/05/18/runs.ttl');
    const type = namedNode('https://undefineds.co/ns#type');
    const content = namedNode('https://undefineds.co/ns#content');
    const messageType = namedNode('https://type/Message');
    const msg1 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1');
    const msg2 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2');

    index.multiPut([
      quad(msg1, type, messageType, chatGraph),
      quad(msg1, content, literal('hello'), chatGraph),
      quad(msg1, content, literal('ignored'), taskGraph),
      quad(msg2, type, messageType, chatGraph),
    ]);

    const result = engine.shadowRdf3xJoin([
      {
        pattern: {
          graph: { $startsWith: 'https://pod.example/alice/.data/chat/' },
          predicate: type,
          object: messageType,
        },
        variables: {
          subject: 'message',
        },
      },
      {
        pattern: {
          graph: { $startsWith: 'https://pod.example/alice/.data/chat/' },
          predicate: content,
        },
        variables: {
          subject: 'message',
          object: 'content',
        },
      },
    ]);

    expect(result.matched).toBe(true);
    expect(result.orderedMatch).toBe(true);
    expect(result.primary).toHaveLength(1);
    expect(result.rdf3x).toHaveLength(1);
    expect(result.rdf3xMetrics.queryPlan?.join('\n')).toContain('GraphPrefixMembershipFilter');
    expect(result.primaryMetrics.engine).toBe('solid-rdf');
    expect(result.rdf3xMetrics.engine).toBe('solid-rdf3x');
  });

  it('auto-configures RDF-3X primary for file-backed engine options', async () => {
    const autoRoot = mkdtempSync(path.join(tmpdir(), 'xpod-solid-rdf-auto-'));
    const autoEngine = new SolidRdfEngine({
      index: { path: path.join(autoRoot, 'rdf.sqlite') },
      autoOpen: true,
    });

    try {
      expect(autoEngine.derivedIndexProfile).toBe('rdf3x');
      expect(autoEngine.rdf3xIndex).toBeInstanceOf(Rdf3xTripleIndex);

      const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
      const type = namedNode(RDF_TYPE);
      const created = namedNode(DCT_CREATED);
      const messageType = namedNode(MEETING_MESSAGE);
      const msg1 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1');
      const msg2 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2');

      autoEngine.put([
        quad(msg1, type, messageType, graph),
        quad(msg1, created, literal('2026-05-18T00:00:01.000Z'), graph),
        quad(msg2, type, messageType, graph),
        quad(msg2, created, literal('2026-05-18T00:00:03.000Z'), graph),
      ]);

      const result = autoEngine.query({
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
        orderBy: [{ variable: 'createdAt', direction: 'desc' }],
        limit: 1,
      });

      expect(result.bindings.map((binding) => ({
        message: binding.message.value,
        createdAt: binding.createdAt.value,
      }))).toEqual([
        {
          message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
          createdAt: '2026-05-18T00:00:03.000Z',
        },
      ]);
      expect(result.metrics.plan).toContain('Rdf3xJoinBGP(2)');
      expect(result.metrics.plan).toContain('Rdf3xPrimaryJoinLimit');
      expect(result.metrics.plan.some((entry) => entry.startsWith('IndexJoin('))).toBe(false);

      const storage = autoEngine.storageStats();
      expect(storage.derivedIndexProfile).toBe('rdf3x');
      expect(storage.facts.quadCount).toBe(4);
      expect(storage.rdf3x).toMatchObject({
        syncedWithFacts: true,
        stats: {
          membershipCount: 4,
          factsDataVersion: autoEngine.index.dataVersion(),
        },
      });
      expect(storage.derivedBytes).toBeGreaterThan(0);
      expect(storage.totalBytes).toBe(storage.factsBytes + storage.derivedBytes);
      expect(storage.totalToFactsRatio).toBeGreaterThan(1);
    } finally {
      await autoEngine.close();
      await rm(autoRoot, { recursive: true, force: true });
    }
  });

  it('keeps file-backed engines on the baseline profile when derived RDF-3X materialization is disabled', async () => {
    const baselineRoot = mkdtempSync(path.join(tmpdir(), 'xpod-solid-rdf-baseline-profile-'));
    const baselineEngine = new SolidRdfEngine({
      index: { path: path.join(baselineRoot, 'rdf.sqlite') },
      derivedIndexProfile: 'baseline',
      autoOpen: true,
    });

    try {
      expect(baselineEngine.derivedIndexProfile).toBe('baseline');
      expect(baselineEngine.rdf3xIndex).toBeUndefined();

      const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
      const type = namedNode(RDF_TYPE);
      const created = namedNode(DCT_CREATED);
      const messageType = namedNode(MEETING_MESSAGE);
      const msg1 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1');

      baselineEngine.put([
        quad(msg1, type, messageType, graph),
        quad(msg1, created, literal('2026-05-18T00:00:01.000Z'), graph),
      ]);

      const result = baselineEngine.query({
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
      expect(result.metrics.plan.some((entry) => entry.startsWith('IndexJoin('))).toBe(true);
      expect(result.metrics.plan.some((entry) => entry.startsWith('Rdf3xJoinBGP('))).toBe(false);

      const storage = baselineEngine.storageStats();
      expect(storage.derivedIndexProfile).toBe('baseline');
      expect(storage.rdf3x).toBeUndefined();
      expect(storage.derivedBytes).toBe(0);
      expect(storage.totalBytes).toBe(storage.factsBytes);
      expect(storage.totalToFactsRatio).toBe(1);
    } finally {
      await baselineEngine.close();
      await rm(baselineRoot, { recursive: true, force: true });
    }
  });

  it('refreshes auto-configured RDF-3X primary after external quad-index writes', async () => {
    const autoRoot = mkdtempSync(path.join(tmpdir(), 'xpod-solid-rdf-auto-external-'));
    const dbPath = path.join(autoRoot, 'rdf.sqlite');
    const autoEngine = new SolidRdfEngine({
      index: { path: dbPath },
      autoOpen: true,
    });
    const externalIndex = new RdfQuadIndex({ path: dbPath });

    try {
      expect(autoEngine.derivedIndexProfile).toBe('rdf3x');
      expect(autoEngine.rdf3xIndex).toBeInstanceOf(Rdf3xTripleIndex);

      const empty = autoEngine.query({
        patterns: [
          {
            subject: { variable: 'message' },
            predicate: namedNode(RDF_TYPE),
            object: namedNode(MEETING_MESSAGE),
          },
        ],
        select: ['message'],
      });
      expect(empty.bindings).toEqual([]);
      expect(empty.metrics.plan.some((entry) => entry.startsWith('Rdf3xPrimaryScan('))).toBe(true);

      externalIndex.open();
      const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
      const message = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_external');
      externalIndex.multiPut([
        quad(message, namedNode(RDF_TYPE), namedNode(MEETING_MESSAGE), graph),
      ]);

      const result = autoEngine.query({
        patterns: [
          {
            subject: { variable: 'message' },
            predicate: namedNode(RDF_TYPE),
            object: namedNode(MEETING_MESSAGE),
          },
        ],
        select: ['message'],
      });

      expect(result.bindings.map((binding) => binding.message.value)).toEqual([
        'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_external',
      ]);
      expect(result.metrics.plan.some((entry) => entry.startsWith('Rdf3xPrimaryScan('))).toBe(true);
      expect(result.metrics.plan.some((entry) => entry.startsWith('IndexScan('))).toBe(false);
    } finally {
      externalIndex.close();
      await autoEngine.close();
      await rm(autoRoot, { recursive: true, force: true });
    }
  });

  it('keeps file-backed engines on the term-id path when RDF-3X primary is disabled', async () => {
    const disabledRoot = mkdtempSync(path.join(tmpdir(), 'xpod-solid-rdf-disabled-'));
    const disabledEngine = new SolidRdfEngine({
      index: { path: path.join(disabledRoot, 'rdf.sqlite') },
      rdf3xPrimary: false,
      autoOpen: true,
    });

    try {
      expect(disabledEngine.derivedIndexProfile).toBe('baseline');
      expect(disabledEngine.rdf3xIndex).toBeUndefined();

      const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
      const type = namedNode(RDF_TYPE);
      const created = namedNode(DCT_CREATED);
      const messageType = namedNode(MEETING_MESSAGE);
      const msg1 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1');

      disabledEngine.put([
        quad(msg1, type, messageType, graph),
        quad(msg1, created, literal('2026-05-18T00:00:01.000Z'), graph),
      ]);

      const result = disabledEngine.query({
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

      expect(result.bindings).toHaveLength(1);
      expect(result.metrics.plan.some((entry) => entry.startsWith('IndexJoin('))).toBe(true);
      expect(result.metrics.plan.some((entry) => entry.startsWith('Rdf3xPrimaryJoin('))).toBe(false);
    } finally {
      await disabledEngine.close();
      await rm(disabledRoot, { recursive: true, force: true });
    }
  });

  it('can opt supported required BGP local queries into RDF-3X primary execution', () => {
    const primaryEngine = new SolidRdfEngine({
      index,
      rdf3xIndex,
      rdf3xPrimary: true,
    });
    const chatGraph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const taskGraph = namedNode('https://pod.example/alice/.data/task/secretary/2026/05/18/runs.ttl');
    const type = namedNode(RDF_TYPE);
    const created = namedNode(DCT_CREATED);
    const messageType = namedNode(MEETING_MESSAGE);
    const msg1 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1');
    const msg2 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2');

    primaryEngine.put([
      quad(msg1, type, messageType, chatGraph),
      quad(msg1, created, literal('2026-05-18T00:00:01.000Z'), chatGraph),
      quad(msg2, type, messageType, chatGraph),
      quad(msg2, created, literal('2026-05-18T00:00:03.000Z'), chatGraph),
      quad(msg2, created, literal('ignored'), taskGraph),
    ]);

    const result = primaryEngine.query({
      patterns: [
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/chat/' },
          subject: { variable: 'message' },
          predicate: type,
          object: messageType,
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/chat/' },
          subject: { variable: 'message' },
          predicate: created,
          object: { variable: 'createdAt' },
        },
      ],
      select: ['message', 'createdAt'],
      orderBy: [{ variable: 'createdAt', direction: 'desc' }],
      limit: 1,
    });

    expect(result.bindings.map((binding) => ({
      message: binding.message.value,
      createdAt: binding.createdAt.value,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        createdAt: '2026-05-18T00:00:03.000Z',
      },
    ]);
    expect(result.metrics.indexChoices[0]).toMatch(/^Rdf3xJoinBGP/);
    expect(result.metrics.plan).toContain('Rdf3xJoinBGP(2)');
    expect(result.metrics.plan).toContain('GraphPrefixMembershipFilter');
    expect(result.metrics.plan).toContain('Rdf3xPrimaryJoinLimit');
    expect(result.metrics.plan.some((entry) => entry.startsWith('IndexJoin('))).toBe(false);
  });

  it('can opt supported single-pattern local scans into RDF-3X primary execution', () => {
    const primaryEngine = new SolidRdfEngine({
      index,
      rdf3xIndex,
      rdf3xPrimary: true,
    });
    const chatGraph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const taskGraph = namedNode('https://pod.example/alice/.data/task/secretary/2026/05/18/runs.ttl');
    const created = namedNode(DCT_CREATED);
    const msg1 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1');
    const msg2 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2');
    const run1 = namedNode('https://pod.example/alice/.data/task/secretary/2026/05/18/runs.ttl#run_1');

    primaryEngine.put([
      quad(msg1, created, literal('2026-05-18T00:00:01.000Z'), chatGraph),
      quad(msg2, created, literal('2026-05-18T00:00:03.000Z'), chatGraph),
      quad(run1, created, literal('2026-05-18T00:00:05.000Z'), taskGraph),
    ]);

    const result = primaryEngine.query({
      patterns: [
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/chat/' },
          subject: { variable: 'message' },
          predicate: created,
          object: { variable: 'createdAt' },
        },
      ],
      select: ['message', 'createdAt'],
      orderBy: [{ variable: 'createdAt', direction: 'desc' }],
      limit: 1,
    });

    expect(result.bindings.map((binding) => ({
      message: binding.message.value,
      createdAt: binding.createdAt.value,
    }))).toEqual([
      {
        message: msg2.value,
        createdAt: '2026-05-18T00:00:03.000Z',
      },
    ]);
    expect(result.metrics.indexChoices[0]).toBe('PSO');
    expect(result.metrics.plan).toContain('Rdf3xPermutationScan(PSO)');
    expect(result.metrics.plan).toContain('GraphPrefixMembershipFilter');
    expect(result.metrics.plan.some((entry) => entry.startsWith('Rdf3xPrimaryScan(graph:op,subject:?message'))).toBe(true);
    expect(result.metrics.plan).toContain('Rdf3xPrimaryOrder(desc:object)');
    expect(result.metrics.plan).toContain('Rdf3xPrimaryLimit');
    expect(result.metrics.plan.some((entry) => entry.startsWith('IndexScan('))).toBe(false);
  });

  it('can opt same-pattern tuple VALUES scans into RDF-3X primary execution', () => {
    const primaryEngine = new SolidRdfEngine({
      index,
      rdf3xIndex,
      rdf3xPrimary: true,
    });
    const chatGraph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const taskGraph = namedNode('https://pod.example/alice/.data/task/secretary/2026/05/18/runs.ttl');
    const created = namedNode(DCT_CREATED);
    const msg1 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1');
    const msg2 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2');
    const run1 = namedNode('https://pod.example/alice/.data/task/secretary/2026/05/18/runs.ttl#run_1');

    primaryEngine.put([
      quad(msg1, created, literal('2026-05-18T00:00:01.000Z'), chatGraph),
      quad(msg2, created, literal('2026-05-18T00:00:03.000Z'), chatGraph),
      quad(run1, created, literal('2026-05-18T00:00:05.000Z'), taskGraph),
    ]);

    const result = primaryEngine.query({
      patterns: [
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/chat/' },
          subject: { variable: 'message' },
          predicate: created,
          object: { variable: 'createdAt' },
        },
      ],
      values: [
        {
          variables: ['message', 'createdAt'],
          rows: [
            { message: msg1, createdAt: literal('2026-05-18T00:00:09.000Z') },
            { message: msg2, createdAt: literal('2026-05-18T00:00:03.000Z') },
            { message: run1, createdAt: literal('2026-05-18T00:00:05.000Z') },
          ],
        },
      ],
      select: ['message', 'createdAt'],
    });

    expect(result.bindings.map((binding) => ({
      message: binding.message.value,
      createdAt: binding.createdAt.value,
    }))).toEqual([
      {
        message: msg2.value,
        createdAt: '2026-05-18T00:00:03.000Z',
      },
    ]);
    expect(result.metrics.plan).toContain('TupleValuesJoin(subject,object)');
    expect(result.metrics.plan.some((entry) => entry.startsWith('Rdf3xPrimaryScan('))).toBe(true);
    expect(result.metrics.plan.some((entry) => entry.startsWith('Values('))).toBe(false);
    expect(result.metrics.plan.some((entry) => entry.startsWith('IndexScan('))).toBe(false);
  });

  it('can opt cross-pattern tuple VALUES joins into RDF-3X primary execution', () => {
    const primaryEngine = new SolidRdfEngine({
      index,
      rdf3xIndex,
      rdf3xPrimary: true,
    });
    const chatGraph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const created = namedNode(DCT_CREATED);
    const status = namedNode(`${UDFS}status`);
    const msg1 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1');
    const msg2 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2');
    const msg3 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3');
    const msg4 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_4');
    const date1 = literal('2026-05-18T00:00:01.000Z');
    const date2 = literal('2026-05-18T00:00:02.000Z');
    const active = literal('active');
    const closed = literal('closed');

    primaryEngine.put([
      quad(msg1, created, date1, chatGraph),
      quad(msg1, status, active, chatGraph),
      quad(msg2, created, date2, chatGraph),
      quad(msg2, status, closed, chatGraph),
      quad(msg3, created, date1, chatGraph),
      quad(msg3, status, closed, chatGraph),
      quad(msg4, created, date2, chatGraph),
      quad(msg4, status, active, chatGraph),
    ]);

    const result = primaryEngine.query({
      patterns: [
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/chat/' },
          subject: { variable: 'message' },
          predicate: created,
          object: { variable: 'createdAt' },
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/chat/' },
          subject: { variable: 'message' },
          predicate: status,
          object: { variable: 'status' },
        },
      ],
      values: [
        {
          variables: ['createdAt', 'status'],
          rows: [
            { createdAt: date1, status: closed },
            { createdAt: date2, status: active },
          ],
        },
      ],
      select: ['message', 'createdAt', 'status'],
      orderBy: [{ variable: 'message' }],
    });

    expect(result.bindings.map((binding) => ({
      message: binding.message.value,
      createdAt: binding.createdAt.value,
      status: binding.status.value,
    }))).toEqual([
      {
        message: msg3.value,
        createdAt: date1.value,
        status: closed.value,
      },
      {
        message: msg4.value,
        createdAt: date2.value,
        status: active.value,
      },
    ]);
    expect(result.metrics.indexChoices[0]).toMatch(/^Rdf3xJoinBGP/);
    expect(result.metrics.plan).toContain('Rdf3xJoinTupleValues(?createdAt,?status)');
    expect(result.metrics.plan.some((entry) => entry.startsWith('Rdf3xPrimaryJoin('))).toBe(true);
    expect(result.metrics.plan.some((entry) => entry.startsWith('Values('))).toBe(false);
    expect(result.metrics.plan.some((entry) => entry.startsWith('IndexJoin('))).toBe(false);
  });

  it('can opt OPTIONAL-local BGP groups into RDF-3X primary execution', () => {
    const primaryEngine = new SolidRdfEngine({
      index,
      rdf3xIndex,
      rdf3xPrimary: true,
    });
    const chatGraph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const type = namedNode(RDF_TYPE);
    const created = namedNode(DCT_CREATED);
    const status = namedNode(`${UDFS}status`);
    const messageType = namedNode(MEETING_MESSAGE);
    const msg1 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1');
    const msg2 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2');

    primaryEngine.put([
      quad(msg1, type, messageType, chatGraph),
      quad(msg1, created, literal('2026-05-18T00:00:01.000Z'), chatGraph),
      quad(msg1, status, literal('active'), chatGraph),
      quad(msg2, type, messageType, chatGraph),
      quad(msg2, created, literal('2026-05-18T00:00:02.000Z'), chatGraph),
    ]);

    const result = primaryEngine.query({
      patterns: [
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/chat/' },
          subject: { variable: 'message' },
          predicate: type,
          object: messageType,
        },
      ],
      optional: [
        {
          patterns: [
            {
              graph: { $startsWith: 'https://pod.example/alice/.data/chat/' },
              subject: { variable: 'message' },
              predicate: created,
              object: { variable: 'createdAt' },
            },
            {
              graph: { $startsWith: 'https://pod.example/alice/.data/chat/' },
              subject: { variable: 'message' },
              predicate: status,
              object: { variable: 'status' },
            },
          ],
        },
      ],
      select: ['message', 'createdAt', 'status'],
      orderBy: [{ variable: 'message' }],
    });

    expect(result.bindings.map((binding) => ({
      message: binding.message.value,
      createdAt: binding.createdAt?.value,
      status: binding.status?.value,
    }))).toEqual([
      {
        message: msg1.value,
        createdAt: '2026-05-18T00:00:01.000Z',
        status: 'active',
      },
      {
        message: msg2.value,
        createdAt: undefined,
        status: undefined,
      },
    ]);
    expect(result.metrics.plan).toContain('OptionalJoin(graph:op,subject:?message,predicate:http://purl.org/dc/terms/created,object:?createdAt,graph:op,subject:?message,predicate:https://undefineds.co/ns#status,object:?status)');
    expect(result.metrics.plan).toContain('Rdf3xJoinBGP(2)');
    expect(result.metrics.plan.some((entry) => entry.startsWith('IndexJoin('))).toBe(false);
  });

  it('can opt UNION branch BGP groups into RDF-3X primary execution', () => {
    const primaryEngine = new SolidRdfEngine({
      index,
      rdf3xIndex,
      rdf3xPrimary: true,
    });
    const chatGraph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const created = namedNode(DCT_CREATED);
    const status = namedNode(`${UDFS}status`);
    const msg1 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1');
    const msg2 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2');
    const msg3 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3');

    primaryEngine.put([
      quad(msg1, created, literal('2026-05-18T00:00:01.000Z'), chatGraph),
      quad(msg1, status, literal('active'), chatGraph),
      quad(msg2, created, literal('2026-05-18T00:00:02.000Z'), chatGraph),
      quad(msg2, status, literal('closed'), chatGraph),
      quad(msg3, created, literal('2026-05-18T00:00:03.000Z'), chatGraph),
      quad(msg3, status, literal('ignored'), chatGraph),
    ]);

    const result = primaryEngine.query({
      patterns: [],
      unions: [
        {
          branches: [
            {
              patterns: [
                {
                  graph: { $startsWith: 'https://pod.example/alice/.data/chat/' },
                  subject: { variable: 'message' },
                  predicate: status,
                  object: literal('active'),
                },
                {
                  graph: { $startsWith: 'https://pod.example/alice/.data/chat/' },
                  subject: { variable: 'message' },
                  predicate: created,
                  object: { variable: 'createdAt' },
                },
              ],
            },
            {
              patterns: [
                {
                  graph: { $startsWith: 'https://pod.example/alice/.data/chat/' },
                  subject: { variable: 'message' },
                  predicate: status,
                  object: literal('closed'),
                },
                {
                  graph: { $startsWith: 'https://pod.example/alice/.data/chat/' },
                  subject: { variable: 'message' },
                  predicate: created,
                  object: { variable: 'createdAt' },
                },
              ],
            },
          ],
        },
      ],
      select: ['message', 'createdAt'],
      orderBy: [{ variable: 'message' }],
    });

    expect(result.bindings.map((binding) => ({
      message: binding.message.value,
      createdAt: binding.createdAt.value,
    }))).toEqual([
      {
        message: msg1.value,
        createdAt: '2026-05-18T00:00:01.000Z',
      },
      {
        message: msg2.value,
        createdAt: '2026-05-18T00:00:02.000Z',
      },
    ]);
    expect(result.metrics.plan.filter((entry) => entry === 'Rdf3xJoinBGP(2)')).toHaveLength(2);
    expect(result.metrics.plan.some((entry) => entry.startsWith('IndexScan('))).toBe(false);
  });

  it('can opt dependent BGP groups into RDF-3X primary execution', () => {
    const primaryEngine = new SolidRdfEngine({
      index,
      rdf3xIndex,
      rdf3xPrimary: true,
    });
    const chatGraph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const type = namedNode(RDF_TYPE);
    const created = namedNode(DCT_CREATED);
    const status = namedNode(`${UDFS}status`);
    const messageType = namedNode(MEETING_MESSAGE);
    const msg1 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1');
    const msg2 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2');
    const msg3 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3');

    primaryEngine.put([
      quad(msg1, type, messageType, chatGraph),
      quad(msg1, status, literal('active'), chatGraph),
      quad(msg1, created, literal('2026-05-18T00:00:01.000Z'), chatGraph),
      quad(msg2, type, messageType, chatGraph),
      quad(msg2, status, literal('closed'), chatGraph),
      quad(msg2, created, literal('2026-05-18T00:00:02.000Z'), chatGraph),
      quad(msg3, type, messageType, chatGraph),
      quad(msg3, status, literal('active'), chatGraph),
    ]);

    const result = primaryEngine.query({
      patterns: [
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/chat/' },
          subject: { variable: 'message' },
          predicate: type,
          object: messageType,
        },
      ],
      minus: [
        {
          patterns: [
            {
              graph: { $startsWith: 'https://pod.example/alice/.data/chat/' },
              subject: { variable: 'message' },
              predicate: status,
              object: literal('closed'),
            },
            {
              graph: { $startsWith: 'https://pod.example/alice/.data/chat/' },
              subject: { variable: 'message' },
              predicate: created,
              object: { variable: 'createdAt' },
            },
          ],
        },
      ],
      exists: [
        {
          patterns: [
            {
              graph: { $startsWith: 'https://pod.example/alice/.data/chat/' },
              subject: { variable: 'message' },
              predicate: status,
              object: literal('active'),
            },
            {
              graph: { $startsWith: 'https://pod.example/alice/.data/chat/' },
              subject: { variable: 'message' },
              predicate: created,
              object: { variable: 'createdAt' },
            },
          ],
        },
      ],
      select: ['message'],
    });

    expect(result.bindings.map((binding) => binding.message.value)).toEqual([msg1.value]);
    expect(result.metrics.plan.filter((entry) => entry === 'Rdf3xJoinBGP(2)').length).toBeGreaterThanOrEqual(2);
    expect(result.metrics.plan).toContain('Minus(graph:op,subject:?message,predicate:https://undefineds.co/ns#status,object:"closed",graph:op,subject:?message,predicate:http://purl.org/dc/terms/created,object:?createdAt)');
    expect(result.metrics.plan).toContain('Exists(graph:op,subject:?message,predicate:https://undefineds.co/ns#status,object:"active",graph:op,subject:?message,predicate:http://purl.org/dc/terms/created,object:?createdAt)');
  });

  it('can opt supported single-pattern count queries into RDF-3X primary execution', () => {
    const primaryEngine = new SolidRdfEngine({
      index,
      rdf3xIndex,
      rdf3xPrimary: true,
    });
    const chatGraph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const taskGraph = namedNode('https://pod.example/alice/.data/task/secretary/2026/05/18/runs.ttl');
    const created = namedNode(DCT_CREATED);
    const msg1 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1');
    const msg2 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2');
    const run1 = namedNode('https://pod.example/alice/.data/task/secretary/2026/05/18/runs.ttl#run_1');

    primaryEngine.put([
      quad(msg1, created, literal('2026-05-18T00:00:01.000Z'), chatGraph),
      quad(msg2, created, literal('2026-05-18T00:00:03.000Z'), chatGraph),
      quad(run1, created, literal('2026-05-18T00:00:05.000Z'), taskGraph),
    ]);

    const result = primaryEngine.query({
      patterns: [
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/chat/' },
          subject: { variable: 'message' },
          predicate: created,
          object: { variable: 'createdAt' },
        },
      ],
      aggregates: [
        {
          type: 'count',
          as: 'messageCount',
        },
      ],
    });

    expect(result.bindings.map((binding) => binding.messageCount.value)).toEqual(['2']);
    expect(result.count).toBe(2);
    expect(result.metrics.indexChoices[0]).toBe('PSO');
    expect(result.metrics.plan).toContain('Rdf3xPermutationScan(PSO)');
    expect(result.metrics.plan).toContain('Rdf3xPrimaryCount(graph:op,subject:?message,predicate:http://purl.org/dc/terms/created,object:?createdAt)');
    expect(result.metrics.plan).toContain('Aggregate(count-rdf3x-primary)');
    expect(result.metrics.plan.some((entry) => entry.startsWith('IndexCount('))).toBe(false);
  });

  it('can opt supported join count local queries into RDF-3X primary execution', () => {
    const primaryEngine = new SolidRdfEngine({
      index,
      rdf3xIndex,
      rdf3xPrimary: true,
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const member = namedNode(SIOC_HAS_MEMBER);
    const type = namedNode(RDF_TYPE);
    const messageType = namedNode(MEETING_MESSAGE);
    const thread = namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_1');
    const msg1 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1');
    const msg2 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2');

    primaryEngine.put([
      quad(thread, member, msg1, graph),
      quad(msg1, type, messageType, graph),
      quad(thread, member, msg2, graph),
      quad(msg2, type, messageType, graph),
    ]);

    const result = primaryEngine.query({
      patterns: [
        {
          subject: thread,
          predicate: member,
          object: { variable: 'message' },
        },
        {
          subject: { variable: 'message' },
          predicate: type,
          object: messageType,
        },
      ],
      aggregates: [
        {
          type: 'count',
          as: 'messageCount',
          variable: 'message',
          distinct: true,
        },
      ],
    });

    expect(result.bindings.map((binding) => binding.messageCount.value)).toEqual(['2']);
    expect(result.count).toBe(2);
    expect(result.metrics.indexChoices[0]).toMatch(/^Rdf3xJoinBGP/);
    expect(result.metrics.plan).toContain('Rdf3xJoinCount(count:DISTINCT(?message))');
    expect(result.metrics.plan.some((entry) => entry.startsWith('Rdf3xPrimaryJoinCount('))).toBe(true);
    expect(result.metrics.plan.some((entry) => entry.startsWith('IndexJoinCount('))).toBe(false);
  });

  it('can opt supported numeric aggregate local queries into RDF-3X primary execution', () => {
    const primaryEngine = new SolidRdfEngine({
      index,
      rdf3xIndex,
      rdf3xPrimary: true,
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const type = namedNode(RDF_TYPE);
    const score = namedNode(`${UDFS}score`);
    const messageType = namedNode(MEETING_MESSAGE);
    const msg1 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1');
    const msg2 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2');
    const msg3 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3');

    primaryEngine.put([
      quad(msg1, type, messageType, graph),
      quad(msg1, score, literal('2', namedNode(XSD_INTEGER)), graph),
      quad(msg2, type, messageType, graph),
      quad(msg2, score, literal('10', namedNode(XSD_INTEGER)), graph),
      quad(msg3, type, messageType, graph),
      quad(msg3, score, literal('not numeric'), graph),
    ]);

    const result = primaryEngine.query({
      patterns: [
        {
          subject: { variable: 'message' },
          predicate: type,
          object: messageType,
        },
        {
          subject: { variable: 'message' },
          predicate: score,
          object: { variable: 'score' },
        },
      ],
      aggregates: [
        {
          type: 'sum',
          as: 'sum',
          variable: 'score',
        },
        {
          type: 'avg',
          as: 'avg',
          variable: 'score',
        },
      ],
    });

    expect(result.bindings.map((binding) => ({
      sum: binding.sum.value,
      avg: binding.avg.value,
    }))).toEqual([
      {
        sum: '12',
        avg: '6',
      },
    ]);
    expect(result.metrics.indexChoices[0]).toMatch(/^Rdf3xJoinBGP/);
    expect(result.metrics.plan).toContain('Rdf3xJoinAggregateNumeric(?score)');
    expect(result.metrics.plan.some((entry) => entry.startsWith('Rdf3xPrimaryJoinAggregate('))).toBe(true);
    expect(result.metrics.plan.some((entry) => entry.startsWith('IndexJoinAggregate('))).toBe(false);
  });

  it('can opt supported grouped count local queries into RDF-3X primary execution', () => {
    const primaryEngine = new SolidRdfEngine({
      index,
      rdf3xIndex,
      rdf3xPrimary: true,
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const member = namedNode(SIOC_HAS_MEMBER);
    const type = namedNode(RDF_TYPE);
    const messageType = namedNode(MEETING_MESSAGE);
    const thread1 = namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_1');
    const thread2 = namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_2');
    const msg1 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1');
    const msg2 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2');
    const msg3 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3');

    primaryEngine.put([
      quad(thread1, member, msg1, graph),
      quad(msg1, type, messageType, graph),
      quad(thread1, member, msg2, graph),
      quad(msg2, type, messageType, graph),
      quad(thread2, member, msg3, graph),
      quad(msg3, type, messageType, graph),
    ]);

    const result = primaryEngine.query({
      patterns: [
        {
          subject: { variable: 'thread' },
          predicate: member,
          object: { variable: 'message' },
        },
        {
          subject: { variable: 'message' },
          predicate: type,
          object: messageType,
        },
      ],
      groupBy: ['thread'],
      aggregates: [
        {
          type: 'count',
          as: 'messageCount',
          variable: 'message',
        },
      ],
      having: [
        {
          variable: 'messageCount',
          operator: '$lt',
          value: 2,
        },
      ],
      orderBy: [
        {
          variable: 'messageCount',
          direction: 'desc',
        },
      ],
      limit: 1,
    });

    expect(result.bindings.map((binding) => ({
      thread: binding.thread.value,
      messageCount: binding.messageCount.value,
    }))).toEqual([
      {
        thread: thread2.value,
        messageCount: '1',
      },
    ]);
    expect(result.metrics.indexChoices[0]).toMatch(/^Rdf3xJoinBGP/);
    expect(result.metrics.plan).toContain('Rdf3xJoinGroupCount(?thread)');
    expect(result.metrics.plan).toContain('Rdf3xPrimaryGroupCountHaving(?messageCount$lt)');
    expect(result.metrics.plan).toContain('Rdf3xPrimaryGroupCountLimit');
    expect(result.metrics.plan.some((entry) => entry.startsWith('IndexGroupCount('))).toBe(false);
  });

  it('can opt supported grouped numeric aggregate local queries into RDF-3X primary execution', () => {
    const primaryEngine = new SolidRdfEngine({
      index,
      rdf3xIndex,
      rdf3xPrimary: true,
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const member = namedNode(SIOC_HAS_MEMBER);
    const score = namedNode(`${UDFS}score`);
    const thread1 = namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_1');
    const thread2 = namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_2');
    const msg1 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1');
    const msg2 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2');
    const msg3 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3');
    const msg4 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_4');

    primaryEngine.put([
      quad(msg1, member, thread1, graph),
      quad(msg1, score, literal('2', namedNode(XSD_INTEGER)), graph),
      quad(msg2, member, thread1, graph),
      quad(msg2, score, literal('10', namedNode(XSD_INTEGER)), graph),
      quad(msg3, member, thread2, graph),
      quad(msg3, score, literal('4', namedNode(XSD_INTEGER)), graph),
      quad(msg4, member, thread2, graph),
      quad(msg4, score, literal('not numeric'), graph),
    ]);

    const result = primaryEngine.query({
      patterns: [
        {
          subject: { variable: 'message' },
          predicate: member,
          object: { variable: 'thread' },
        },
        {
          subject: { variable: 'message' },
          predicate: score,
          object: { variable: 'score' },
        },
      ],
      filters: [
        {
          variable: 'score',
          operator: '$termType',
          value: 'numeric',
        },
      ],
      groupBy: ['thread'],
      aggregates: [
        {
          type: 'count',
          as: 'count',
          variable: 'message',
        },
        {
          type: 'sum',
          as: 'scoreTotal',
          variable: 'score',
        },
        {
          type: 'avg',
          as: 'scoreAvg',
          variable: 'score',
        },
      ],
      having: [
        {
          variable: 'scoreTotal',
          operator: '$gt',
          value: literal('4', namedNode(XSD_INTEGER)),
        },
      ],
      select: ['thread', 'count', 'scoreTotal', 'scoreAvg'],
      orderBy: [{ variable: 'scoreTotal', direction: 'desc' }],
      limit: 1,
    });

    expect(result.bindings.map((binding) => ({
      thread: binding.thread.value,
      count: binding.count.value,
      scoreTotal: binding.scoreTotal.value,
      scoreTotalDatatype: binding.scoreTotal.datatype.value,
      scoreAvg: binding.scoreAvg.value,
    }))).toEqual([
      {
        thread: thread1.value,
        count: '2',
        scoreTotal: '12',
        scoreTotalDatatype: 'http://www.w3.org/2001/XMLSchema#decimal',
        scoreAvg: '6',
      },
    ]);
    expect(result.metrics.indexChoices[0]).toMatch(/^Rdf3xJoinBGP/);
    expect(result.metrics.plan).toContain('Rdf3xJoinGroupAggregateNumeric(?score)');
    expect(result.metrics.plan).toContain('Rdf3xPrimaryGroupAggregateHaving(?scoreTotal$gt)');
    expect(result.metrics.plan).toContain('Rdf3xPrimaryGroupAggregateLimit');
    expect(result.metrics.plan.some((entry) => entry.startsWith('Rdf3xPrimaryGroupAggregate('))).toBe(true);
    expect(result.metrics.plan.some((entry) => entry.startsWith('IndexGroupAggregate('))).toBe(false);
  });

  it('keeps unsupported filters on the default term-id primary path when RDF-3X primary is enabled', () => {
    const primaryEngine = new SolidRdfEngine({
      index,
      rdf3xIndex,
      rdf3xPrimary: true,
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const type = namedNode(RDF_TYPE);
    const content = namedNode(`${UDFS}content`);
    const messageType = namedNode(MEETING_MESSAGE);
    const msg1 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1');
    const msg2 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2');

    primaryEngine.put([
      quad(msg1, type, messageType, graph),
      quad(msg1, content, literal('hello from RDF-3X'), graph),
      quad(msg2, type, messageType, graph),
      quad(msg2, content, literal('other'), graph),
    ]);

    const result = primaryEngine.query({
      patterns: [
        {
          subject: { variable: 'message' },
          predicate: type,
          object: messageType,
        },
        {
          subject: { variable: 'message' },
          predicate: content,
          object: { variable: 'content' },
        },
      ],
      filters: [
        {
          variable: 'content',
          operator: '$contains',
          value: 'RDF-3X',
        },
      ],
      select: ['message', 'content'],
    });

    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0].message.value).toBe(msg1.value);
    expect(result.metrics.plan.some((entry) => entry.startsWith('IndexJoin('))).toBe(true);
    expect(result.metrics.plan.some((entry) => entry.startsWith('Rdf3xPrimaryJoin'))).toBe(false);
  });

  it('exposes a benchmark case list aligned to the spec', () => {
    expect(rdfModelsBenchmarkCaseNames()).toEqual([
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
      'task materialization due time',
      'search message literals',
      'load by exact id',
      'acl graph prefix scoped query',
      'list providers',
      'models by provider',
      'credentials by provider',
      'list agents',
      'list contacts',
      'list favorites',
    ]);
    expect(rdfModelsLocalQueryBenchmarkCaseNames()).toEqual([
      'latest message by thread local query',
      'next queued run by workspace local query',
      'run steps by run local query',
      'task materialization active due local query',
      'message count by thread with having',
      'message score by thread numeric aggregate',
      'message join count distinct',
    ]);
  });

  it('keeps benchmark scale seed targets aligned with the spec', () => {
    expect(rdfModelsBenchmarkScaleTargetQuads('small')).toBeGreaterThanOrEqual(48);
    expect(rdfModelsBenchmarkScaleTargetQuads('medium')).toBe(10_000);
    expect(rdfModelsBenchmarkScaleTargetQuads('large')).toBe(1_000_000);
    expect(defaultSyntheticMessagesForRdfModelsScale('small')).toBe(12);
    expect(estimateRdfModelsSyntheticQuadCount(defaultSyntheticMessagesForRdfModelsScale('medium'))).toBe(10_000);
    expect(estimateRdfModelsSyntheticQuadCount(defaultSyntheticMessagesForRdfModelsScale('large'))).toBe(1_000_000);
    expect(rdfModelsBenchmarkSyntheticPodCount('medium')).toBe(1);
    expect(rdfModelsBenchmarkSyntheticPodCount('large')).toBeGreaterThan(1);
    expect(rdfModelsBenchmarkScaleSatisfied('large', 100_000)).toBe(false);
    expect(rdfModelsBenchmarkScaleSatisfied('large', 1_000_000)).toBe(true);
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
        namedNode(DCT_CREATED),
        literal('2026-05-18T01:00:00.000Z'),
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
        namedNode(`${UDFS}Provider`),
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl#claude-sonnet-4'),
        namedNode(RDF_TYPE),
        namedNode(`${UDFS}Model`),
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl#claude-sonnet-4'),
        namedNode(`${UDFS}isProvidedBy`),
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/settings/credentials.ttl#anthropic-default'),
        namedNode(`${UDFS}provider`),
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
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
        namedNode('https://pod.example/alice/.data/favorites/2026/05/18.ttl#favorite_1'),
        namedNode(RDF_TYPE),
        namedNode(SCHEMA_CREATIVE_WORK),
        namedNode('https://pod.example/alice/.data/favorites/2026/05/18.ttl'),
      ),
    ]);

    const report = runRdfModelsBenchmark(engine, { scale: 'small', iterations: 2 });
    const byName = new Map(report.cases.map((testCase) => [testCase.name, testCase]));

    expect(report.engine).toBe('solid-rdf');
    expect(report.iterations).toBe(2);
    expect(report.cases).toHaveLength(19);
    expect(report.localQueryCases).toHaveLength(7);
    expect(report.planMatched).toBe(true);
    expect(report.failedPlanCases).toEqual([]);
    expect(report.storage.derivedIndexProfile).toBe('rdf3x');
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
    expect(byName.get('list chats')?.indexStats.quadCount).toBe(39);
    expect(byName.get('list chats')?.indexStats.tableBytes).toBeGreaterThan(0);
    expect(byName.get('list chats')?.indexStats.indexBytes).toBeGreaterThan(0);
    expect(byName.get('list chats')?.indexStats.spaceObjects.some((object) => object.kind === 'table')).toBe(true);
    expect(byName.get('list chats')?.indexStats.spaceObjects.some((object) => object.kind === 'index')).toBe(true);
    expect(byName.get('list chats')?.query.pattern).toMatchObject({
      predicate: RDF_TYPE,
      object: 'http://www.w3.org/ns/pim/meeting#LongChat',
      graph: { $startsWith: 'https://pod.example/alice/.data/chat/' },
    });
    const groupedMessages = report.localQueryCases.find((testCase) => testCase.name === 'message count by thread with having');
    const messageScoreByThread = report.localQueryCases.find((testCase) => testCase.name === 'message score by thread numeric aggregate');
    const latestMessageByThread = report.localQueryCases.find((testCase) => testCase.name === 'latest message by thread local query');
    const nextQueuedRun = report.localQueryCases.find((testCase) => testCase.name === 'next queued run by workspace local query');
    const runSteps = report.localQueryCases.find((testCase) => testCase.name === 'run steps by run local query');
    const taskMaterialization = report.localQueryCases.find((testCase) => testCase.name === 'task materialization active due local query');
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
    const joinCount = report.localQueryCases.find((testCase) => testCase.name === 'message join count distinct');
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

  it('runs a shadow benchmark report against the compatibility store', async () => {
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
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
        namedNode(RDF_TYPE),
        namedNode(`${UDFS}Provider`),
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/settings/credentials.ttl#anthropic-default'),
        namedNode(`${UDFS}provider`),
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
        namedNode('https://pod.example/alice/settings/credentials.ttl'),
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
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1'),
        namedNode(SIOC_HAS_MEMBER),
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_1'),
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1'),
        namedNode(DCT_CREATED),
        literal('2026-05-18T01:02:03.000Z'),
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_1'),
        namedNode(DCT_CREATED),
        literal('2026-05-18T01:00:00.000Z'),
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
        namedNode(`${UDFS}run`),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_1'),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl#claude-sonnet-4'),
        namedNode(`${UDFS}isProvidedBy`),
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
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
    ];

    await compatibilityStore.multiPut(quads);
    engine.index.multiPut(quads);

    const report = await runRdfModelsShadowBenchmark(engine, compatibilityStore, {
      scale: 'small',
      iterations: 2,
    });
    const listChats = report.cases.find((testCase) => testCase.name === 'list chats');
    const runningRuns = report.cases.find((testCase) => testCase.name === 'running runs');
    const numericPriority = report.cases.find((testCase) => testCase.name === 'runs by numeric priority');
    const providers = report.cases.find((testCase) => testCase.name === 'list providers');

    expect(report.engine).toBe('shadow');
    expect(report.matched).toBe(true);
    expect(report.orderedMatched).toBe(true);
    expect(report.planMatched).toBe(true);
    expect(report.spaceGateEnforced).toBe(false);
    expect(report.performanceMatched).toBe(true);
    expect(report.spaceMatched).toBe(true);
    expect(report.failedPlanCases).toEqual([]);
    expect(report.failedPerformanceCases).toEqual([]);
    expect(report.failedSpaceCases).toEqual([]);
    expect(listChats).toMatchObject({
      planMatched: true,
      matched: true,
      orderedMatch: true,
      compatibility: { returnedRows: 1 },
      solidRdf: {
        returnedRows: 1,
        scannedRows: 1,
        indexChoice: 'GPOS',
        joinOrder: ['GPOS'],
        fallbackReason: null,
        metrics: { indexChoice: 'GPOS', matchedRows: 1, returnedRows: 1 },
      },
    });
    const compatibilityStats = listChats?.compatibility.storeStats;
    expect(compatibilityStats?.totalCount).toBe(quads.length);
    expect(typeof compatibilityStats?.tableBytes).toBe('number');
    expect(typeof compatibilityStats?.indexBytes).toBe('number');
    expect(compatibilityStats?.tableBytes).toBeGreaterThan(0);
    expect(compatibilityStats?.indexBytes).toBeGreaterThan(0);
    expect(listChats?.solidRdf.physicalPlan.some((entry) => entry.includes('SELECT'))).toBe(true);
    expect(numericPriority).toMatchObject({
      planMatched: true,
      matched: true,
      orderedMatch: true,
      compatibility: { returnedRows: 1 },
      solidRdf: {
        returnedRows: 1,
        metrics: { indexChoice: 'GPOS', matchedRows: 1, returnedRows: 1 },
      },
    });
    expect(numericPriority?.solidRdf.metrics.queryPlan).toContain('NumericRange(object$gt)');
    expect(numericPriority?.solidRdf.metrics.queryPlan?.join('\n')).toContain('JOIN rdf_terms object_id_numeric_range_gt');
    expect(numericPriority?.solidRdf.metrics.queryPlan?.join('\n')).not.toContain('rdf_quads.object_id IN (?,');
    expect(runningRuns).toMatchObject({
      planMatched: true,
      matched: true,
      orderedMatch: true,
      compatibility: { returnedRows: 1 },
      solidRdf: {
        returnedRows: 1,
        metrics: { indexChoice: 'GPOS', matchedRows: 1, returnedRows: 1 },
      },
    });
    expect(providers).toMatchObject({
      matched: true,
      orderedMatch: true,
      compatibility: { returnedRows: 1 },
      solidRdf: {
        returnedRows: 1,
        metrics: { indexChoice: 'GPOS', matchedRows: 1, returnedRows: 1 },
      },
    });
    expect(listChats?.compatibility.checksum).toBe(listChats?.solidRdf.checksum);
    expect(listChats?.compatibility.orderedChecksum).toBe(listChats?.solidRdf.orderedChecksum);
    expect(listChats?.solidRdf.indexStats.tableBytes).toBeGreaterThan(0);
    expect(listChats?.solidRdf.indexStats.indexBytes).toBeGreaterThan(0);
    expect(listChats?.performance).toMatchObject({ matched: true });
    expect(typeof listChats?.performance.p95DeltaMs).toBe('number');
    expect(typeof listChats?.performance.p95Ratio).toBe('number');
    expect(typeof listChats?.space.databaseDeltaBytes).toBe('number');
    expect(typeof listChats?.space.tableDeltaBytes).toBe('number');
    expect(typeof listChats?.space.indexDeltaBytes).toBe('number');
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
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_1'),
        namedNode(`${UDFS}status`),
        literal('queued'),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_1'),
        namedNode(`${UDFS}priority`),
        literal('10', namedNode(XSD_INTEGER)),
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
        namedNode(RDF_TYPE),
        namedNode(`${UDFS}Provider`),
        namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
      ),
    ];
    engine.index.multiPut(quads);

    const report = runRdfModelsRdf3xShadowBenchmark(engine, {
      scale: 'small',
      iterations: 2,
    });
    const listChats = report.cases.find((testCase) => testCase.name === 'list chats');
    const numericPriority = report.cases.find((testCase) => testCase.name === 'runs by numeric priority');
    const latestMessageJoin = report.joinCases.find((testCase) => testCase.name === 'latest message by thread local query');
    const taskMaterializationJoin = report.joinCases.find((testCase) => testCase.name === 'task materialization active due local query');
    const messageCountByThread = report.joinCases.find((testCase) => testCase.name === 'message count by thread with having');
    const messageScoreByThread = report.joinCases.find((testCase) => testCase.name === 'message score by thread numeric aggregate');
    const messageJoinCount = report.joinCases.find((testCase) => testCase.name === 'message join count distinct');

    expect(report.engine).toBe('rdf3x-shadow');
    expect(report.rebuild.scannedQuads).toBe(quads.length);
    expect(report.storage.rdf3x).toMatchObject({
      syncedWithFacts: true,
      stats: {
        membershipCount: quads.length,
        factsDataVersion: engine.index.dataVersion(),
      },
    });
    expect(report.storage.derivedBytes).toBeGreaterThan(0);
    expect(report.storage.totalBytes).toBe(report.storage.factsBytes + report.storage.derivedBytes);
    expect(report.skippedCases).not.toContain('runs by numeric priority');
    expect(report.skippedJoinCases).toEqual([
      'task materialization active due local query',
    ]);
    expect(report.failedJoinCases).toEqual([]);
    expect(numericPriority).toMatchObject({
      supported: true,
      matched: true,
      orderedMatch: true,
      solidRdf: { returnedRows: 1 },
      rdf3x: {
        returnedRows: 1,
        metrics: { indexChoice: 'POS', matchedRows: 1, returnedRows: 1 },
      },
    });
    expect(numericPriority?.unsupportedReason).toBeUndefined();
    expect(numericPriority?.rdf3x?.physicalPlan).toContain('NumericRange(object$gt)');
    expect(numericPriority?.rdf3x?.physicalPlan.join('\n')).toContain('JOIN rdf_terms object_range ON object_range.id = idx.object_id');
    expect(listChats).toMatchObject({
      supported: true,
      matched: true,
      orderedMatch: true,
      solidRdf: { returnedRows: 1 },
      rdf3x: {
        returnedRows: 1,
        metrics: { indexChoice: 'POS', matchedRows: 1, returnedRows: 1 },
      },
    });
    expect(listChats?.rdf3x?.physicalPlan.join('\n')).toContain('GraphPrefixMembershipFilter');
    expect(latestMessageJoin).toMatchObject({
      supported: true,
      matched: true,
      orderedMatch: true,
      solidRdf: { returnedRows: 1 },
      rdf3x: {
        returnedRows: 1,
        metrics: {
          engine: 'solid-rdf3x',
          matchedRows: 1,
          returnedRows: 1,
        },
      },
    });
    expect(latestMessageJoin?.rdf3x?.physicalPlan).toContain('Rdf3xJoinBGP(2)');
    expect(latestMessageJoin?.rdf3x?.physicalPlan).toContain('Rdf3xJoinLimit');
    expect(taskMaterializationJoin).toMatchObject({
      supported: false,
      unsupportedReason: 'unsupported object pattern for RDF-3X shadow',
    });
    expect(messageCountByThread).toMatchObject({
      supported: true,
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
  });
});
