import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Quad } from '@rdfjs/types';
import { DataFactory } from 'n3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Rdf3xTripleIndex, RdfQuadIndex } from '../../../src/storage/rdf';

const { namedNode, literal, quad } = DataFactory;

describe('Rdf3xTripleIndex', () => {
  let root: string;
  let quadIndex: RdfQuadIndex;
  let rdf3x: Rdf3xTripleIndex;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'xpod-rdf3x-'));
    const dbPath = path.join(root, 'rdf.sqlite');
    quadIndex = new RdfQuadIndex({ path: dbPath });
    rdf3x = new Rdf3xTripleIndex({ path: dbPath });
    quadIndex.open();
    rdf3x.open();
  });

  afterEach(async () => {
    rdf3x.close();
    quadIndex.close();
    await rm(root, { recursive: true, force: true });
  });

  it('rebuilds independent RDF-3X permutation tables from the current quad baseline', () => {
    const status = namedNode('https://undefineds.co/ns#status');
    const rdfType = namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
    const messageType = namedNode('https://type/Message');
    const open = literal('open');
    const chatGraph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const taskGraph = namedNode('https://pod.example/alice/.data/task/secretary/2026/05/18/runs.ttl');
    const message1 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#m1');
    const message2 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#m2');

    quadIndex.multiPut([
      quad(message1, status, open, chatGraph),
      quad(message1, status, open, taskGraph),
      quad(message2, status, open, chatGraph),
      quad(message1, rdfType, messageType, chatGraph),
    ]);

    const rebuild = rdf3x.rebuildFromCurrentQuads();

    expect(rebuild).toMatchObject({
      scannedQuads: 4,
      uniqueTriples: 3,
      memberships: 4,
      factsDataVersion: quadIndex.dataVersion(),
    });
    expect(rebuild.projectionRows).toBeGreaterThan(0);
    expect(rdf3x.factsDataVersion()).toBe(quadIndex.dataVersion());
    expect(rdf3x.isSyncedWithCurrentQuads()).toBe(true);

    const stats = rdf3x.stats();
    expect(stats.membershipCount).toBe(4);
    expect(stats.uniqueTriples).toBe(3);
    expect(stats.graphCount).toBe(2);
    expect(stats.factsDataVersion).toBe(quadIndex.dataVersion());
    expect(stats.permutationRows).toEqual({
      SPO: 3,
      SOP: 3,
      PSO: 3,
      POS: 3,
      OSP: 3,
      OPS: 3,
    });
    expect(stats.pairProjectionRows.PO).toBe(2);
    expect(stats.termProjectionRows.P).toBe(2);

    quadIndex.multiPut([
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#m3'),
        status,
        open,
        chatGraph,
      ),
    ]);
    expect(rdf3x.factsDataVersion()).not.toBe(quadIndex.dataVersion());
    expect(rdf3x.isSyncedWithCurrentQuads()).toBe(false);
  });

  it('matches baseline scans while keeping graph membership outside the triple core', () => {
    const status = namedNode('https://undefineds.co/ns#status');
    const open = literal('open');
    const closed = literal('closed');
    const chatGraph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const taskGraph = namedNode('https://pod.example/alice/.data/task/secretary/2026/05/18/runs.ttl');
    const message1 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#m1');
    const message2 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#m2');

    quadIndex.multiPut([
      quad(message1, status, open, chatGraph),
      quad(message1, status, open, taskGraph),
      quad(message2, status, open, chatGraph),
      quad(message2, status, closed, taskGraph),
    ]);
    rdf3x.rebuildFromCurrentQuads();

    const baseline = quadIndex.scan({ predicate: status, object: open });
    const scan = rdf3x.scan({ predicate: status, object: open });

    expect(quadKeys(scan.quads)).toEqual(quadKeys(baseline.quads));
    expect(scan.metrics.indexChoice).toBe('POS');
    expect(scan.metrics.matchedRows).toBe(3);
    expect(scan.metrics.queryPlan?.join('\n')).toContain('Rdf3xPermutationScan(POS)');

    const graphBaseline = quadIndex.scan({ graph: chatGraph, predicate: status, object: open });
    const graphScan = rdf3x.scan({ graph: chatGraph, predicate: status, object: open });
    expect(quadKeys(graphScan.quads)).toEqual(quadKeys(graphBaseline.quads));
    expect(graphScan.metrics.queryPlan).toContain('GraphMembershipFilter');
  });

  it('uses numeric semantics for typed literal range scans', () => {
    const xsdInteger = namedNode('http://www.w3.org/2001/XMLSchema#integer');
    const priority = namedNode('https://undefineds.co/ns#priority');
    const graph = namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl');
    quadIndex.multiPut([
      quad(namedNode('https://run/2'), priority, literal('2', xsdInteger), graph),
      quad(namedNode('https://run/10'), priority, literal('10', xsdInteger), graph),
      quad(namedNode('https://run/lexical'), priority, literal('9'), graph),
    ]);
    rdf3x.rebuildFromCurrentQuads();

    const baseline = quadIndex.scan({
      graph: { $startsWith: 'https://pod.example/alice/.data/task/' },
      predicate: priority,
      object: { $gt: literal('9', xsdInteger) },
    }, { order: ['subject'] });
    const scan = rdf3x.scan({
      graph: { $startsWith: 'https://pod.example/alice/.data/task/' },
      predicate: priority,
      object: { $gt: literal('9', xsdInteger) },
    }, { order: ['subject'] });

    expect(quadKeys(scan.quads)).toEqual(quadKeys(baseline.quads));
    expect(scan.quads.map((q) => q.subject.value)).toEqual(['https://run/10']);
    expect(scan.metrics.indexChoice).toBe('POS');
    expect(scan.metrics.queryPlan).toContain('NumericRange(object$gt)');
    expect(scan.metrics.queryPlan?.join('\n')).toContain('JOIN rdf_terms object_range ON object_range.id = idx.object_id');
    expect(scan.metrics.queryPlan?.join('\n')).not.toContain('idx.object_id = ?');
    expect(rdf3x.estimateCardinality({
      graph: { $startsWith: 'https://pod.example/alice/.data/task/' },
      predicate: priority,
      object: { $gt: literal('9', xsdInteger) },
    })).toMatchObject({
      uniqueTriples: 1,
      matchingQuads: 1,
      source: 'exact-membership',
      indexChoice: 'source-membership',
    });
  });

  it('uses lexical semantics for non-numeric object range scans', () => {
    const nextRunAt = namedNode('https://undefineds.co/ns#nextRunAt');
    const graph = namedNode('https://pod.example/alice/.data/task/default/2026/05/18/schedules.ttl');
    quadIndex.multiPut([
      quad(namedNode('https://schedule/due'), nextRunAt, literal('2026-05-18T01:00:00.000Z'), graph),
      quad(namedNode('https://schedule/later'), nextRunAt, literal('2026-05-18T02:00:00.000Z'), graph),
    ]);
    rdf3x.rebuildFromCurrentQuads();

    const baseline = quadIndex.scan({
      graph: { $startsWith: 'https://pod.example/alice/.data/task/default/' },
      predicate: nextRunAt,
      object: { $lte: literal('2026-05-18T01:30:00.000Z') },
    }, { order: ['subject'] });
    const scan = rdf3x.scan({
      graph: { $startsWith: 'https://pod.example/alice/.data/task/default/' },
      predicate: nextRunAt,
      object: { $lte: literal('2026-05-18T01:30:00.000Z') },
    }, { order: ['subject'] });

    expect(quadKeys(scan.quads)).toEqual(quadKeys(baseline.quads));
    expect(scan.quads.map((q) => q.subject.value)).toEqual(['https://schedule/due']);
    expect(scan.metrics.indexChoice).toBe('POS');
    expect(scan.metrics.queryPlan).toContain('LexicalRange(object$lte)');
    expect(scan.metrics.queryPlan?.join('\n')).toContain('JOIN rdf_terms object_range ON object_range.id = idx.object_id');
  });

  it('uses projection stats for exact triple-pattern cardinality estimates', () => {
    const status = namedNode('https://undefineds.co/ns#status');
    const open = literal('open');
    const closed = literal('closed');
    const chatGraph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const taskGraph = namedNode('https://pod.example/alice/.data/task/secretary/2026/05/18/runs.ttl');
    const message1 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#m1');
    const message2 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#m2');

    quadIndex.multiPut([
      quad(message1, status, open, chatGraph),
      quad(message1, status, open, taskGraph),
      quad(message2, status, open, chatGraph),
      quad(message2, status, closed, taskGraph),
    ]);
    rdf3x.rebuildFromCurrentQuads();

    expect(rdf3x.estimateCardinality({ predicate: status, object: open })).toMatchObject({
      uniqueTriples: 2,
      matchingQuads: 3,
      source: 'projection-stat',
      indexChoice: 'POS',
    });
    expect(rdf3x.estimateCardinality({ graph: chatGraph, predicate: status, object: open })).toMatchObject({
      uniqueTriples: 2,
      matchingQuads: 2,
      source: 'exact-membership',
      indexChoice: 'source-membership',
    });
    expect(rdf3x.estimateCardinality({
      graph: { $startsWith: 'https://pod.example/alice/.data/chat/' },
      predicate: status,
      object: open,
    })).toMatchObject({
      uniqueTriples: 2,
      matchingQuads: 2,
      source: 'exact-membership',
      indexChoice: 'source-membership',
    });
  });

  it('counts distinct pattern slots through RDF-3X permutation scans', () => {
    const graphA = namedNode('https://pod.example/alice/.data/chat/a/messages.ttl');
    const graphB = namedNode('https://pod.example/alice/.data/chat/b/messages.ttl');
    const graphC = namedNode('https://pod.example/alice/.data/task/secretary/runs.ttl');
    const created = namedNode('https://p/created');
    const msg1 = namedNode('https://message/1');
    const msg2 = namedNode('https://message/2');
    const run1 = namedNode('https://run/1');

    quadIndex.multiPut([
      quad(msg1, created, literal('2026-05-18T00:00:01.000Z'), graphA),
      quad(msg1, created, literal('2026-05-18T00:00:01.000Z'), graphB),
      quad(msg2, created, literal('2026-05-18T00:00:02.000Z'), graphB),
      quad(run1, created, literal('2026-05-18T00:00:03.000Z'), graphC),
    ]);
    rdf3x.rebuildFromCurrentQuads();

    const result = rdf3x.countDistinct({
      graph: { $startsWith: 'https://pod.example/alice/.data/chat/' },
      predicate: created,
    }, 'subject');

    expect(result.count).toBe(2);
    expect(result.metrics.indexChoice).toBe('PSO');
    expect(result.metrics.queryPlan).toContain('Rdf3xPermutationScan(PSO)');
    expect(result.metrics.queryPlan).toContain('GraphPrefixMembershipFilter');
    expect(result.metrics.queryPlan).toContain('Rdf3xDistinctCount(?subject)');
    expect(result.metrics.queryPlan?.join('\n')).toContain('COUNT(DISTINCT idx.subject_id)');
  });

  it('matches baseline scans for graph prefix membership filters without dropping triple constraints', () => {
    const status = namedNode('https://undefineds.co/ns#status');
    const open = literal('open');
    const chatGraph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const taskGraph = namedNode('https://pod.example/alice/.data/task/secretary/2026/05/18/runs.ttl');
    const message1 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#m1');
    const message2 = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#m2');

    quadIndex.multiPut([
      quad(message1, status, open, chatGraph),
      quad(message1, status, open, taskGraph),
      quad(message2, status, open, chatGraph),
    ]);
    rdf3x.rebuildFromCurrentQuads();

    const prefix = 'https://pod.example/alice/.data/chat/';
    const baseline = quadIndex.scan({ graph: { $startsWith: prefix }, predicate: status, object: open });
    const scan = rdf3x.scan({ graph: { $startsWith: prefix }, predicate: status, object: open });

    expect(quadKeys(scan.quads)).toEqual(quadKeys(baseline.quads));
    expect(scan.metrics.queryPlan?.join('\n')).toContain('GraphPrefixMembershipFilter');
    expect(scan.metrics.queryPlan?.join('\n')).toContain('Rdf3xPermutationScan(POS)');
    expect(rdf3x.estimateCardinality({ graph: { $startsWith: prefix }, predicate: status, object: open })).toMatchObject({
      source: 'exact-membership',
      indexChoice: 'source-membership',
    });
  });

  it('executes connected BGP joins from RDF-3X permutation scans', () => {
    const graph = namedNode('https://g');
    const type = namedNode('https://p/type');
    const content = namedNode('https://p/content');
    const messageType = namedNode('https://type/Message');
    const msg1 = namedNode('https://message/1');
    const msg2 = namedNode('https://message/2');
    quadIndex.multiPut([
      quad(msg1, type, messageType, graph),
      quad(msg1, content, literal('hello'), graph),
      quad(msg2, type, messageType, graph),
    ]);
    rdf3x.rebuildFromCurrentQuads();

    const patterns = [
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
    ];

    const baseline = quadIndex.joinPatterns(patterns);
    const result = rdf3x.joinPatterns(patterns);

    expect(bindingKeys(result.bindings)).toEqual(bindingKeys(baseline.bindings));
    expect(result.bindings.map((binding) => ({
      message: binding.message.value,
      content: binding.content.value,
    }))).toEqual([
      {
        message: 'https://message/1',
        content: 'hello',
      },
    ]);
    expect(result.metrics.indexChoice).toBe('Rdf3xJoinBGP(PSO>POS)');
    expect(result.metrics.queryPlan?.join('\n')).toContain('Rdf3xJoinBGP(2)');
    expect(result.metrics.queryPlan?.join('\n')).toContain('Rdf3xPermutationScan(POS)');
    expect(result.metrics.queryPlan).toContain('Rdf3xMergeJoin(?message)');
    expect(result.metrics.queryPlan?.join('\n')).toContain('JOIN rdf3x_pos q0\n          ON q1.subject_id = q0.subject_id');
  });

  it('pushes correlated tuple VALUES into RDF-3X BGP joins', () => {
    const graph = namedNode('https://g');
    const created = namedNode('https://p/created');
    const status = namedNode('https://p/status');
    const msg1 = namedNode('https://message/1');
    const msg2 = namedNode('https://message/2');
    const msg3 = namedNode('https://message/3');
    const msg4 = namedNode('https://message/4');
    const date1 = literal('2026-05-18T00:00:01.000Z');
    const date2 = literal('2026-05-18T00:00:02.000Z');
    const active = literal('active');
    const closed = literal('closed');

    quadIndex.multiPut([
      quad(msg1, created, date1, graph),
      quad(msg1, status, active, graph),
      quad(msg2, created, date2, graph),
      quad(msg2, status, closed, graph),
      quad(msg3, created, date1, graph),
      quad(msg3, status, closed, graph),
      quad(msg4, created, date2, graph),
      quad(msg4, status, active, graph),
    ]);
    rdf3x.rebuildFromCurrentQuads();

    const result = rdf3x.joinPatterns([
      {
        pattern: {
          graph,
          predicate: created,
        },
        variables: {
          subject: 'message',
          object: 'createdAt',
        },
      },
      {
        pattern: {
          graph,
          predicate: status,
        },
        variables: {
          subject: 'message',
          object: 'status',
        },
      },
    ], {
      values: [
        {
          variables: ['createdAt', 'status'],
          rows: [
            { createdAt: date1, status: closed },
            { createdAt: date2, status: active },
          ],
        },
      ],
    });

    expect(result.bindings.map((binding) => binding.message.value).sort()).toEqual([
      msg3.value,
      msg4.value,
    ]);
    expect(result.metrics.indexChoice).toMatch(/^Rdf3xJoinBGP/);
    expect(result.metrics.queryPlan).toContain('Rdf3xJoinTupleValues(?createdAt,?status)');
  });

  it('uses RDF-3X cardinality stats to start joins from the narrowest pattern', () => {
    const graph = namedNode('https://g');
    const type = namedNode('https://p/type');
    const created = namedNode('https://p/created');
    const flag = namedNode('https://p/flag');
    const messageType = namedNode('https://type/Message');
    const msg1 = namedNode('https://message/1');
    const msg2 = namedNode('https://message/2');
    const msg3 = namedNode('https://message/3');
    quadIndex.multiPut([
      quad(msg1, type, messageType, graph),
      quad(msg1, created, literal('2026-05-18T00:00:01.000Z'), graph),
      quad(msg1, flag, literal('selected'), graph),
      quad(msg2, type, messageType, graph),
      quad(msg2, created, literal('2026-05-18T00:00:03.000Z'), graph),
      quad(msg3, type, messageType, graph),
      quad(msg3, created, literal('2026-05-18T00:00:02.000Z'), graph),
    ]);
    rdf3x.rebuildFromCurrentQuads();

    const result = rdf3x.joinPatterns([
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
          predicate: created,
        },
        variables: {
          subject: 'message',
          object: 'createdAt',
        },
      },
      {
        pattern: {
          predicate: flag,
          object: literal('selected'),
        },
        variables: {
          subject: 'message',
        },
      },
    ], {
      orderBy: [{ variable: 'createdAt', direction: 'desc' }],
      limit: 1,
    });

    expect(result.bindings.map((binding) => ({
      message: binding.message.value,
      createdAt: binding.createdAt.value,
    }))).toEqual([
      {
        message: 'https://message/1',
        createdAt: '2026-05-18T00:00:01.000Z',
      },
    ]);
    expect(result.metrics.matchedRows).toBe(1);
    expect(result.metrics.returnedRows).toBe(1);
    expect(result.metrics.queryPlan).toContain('Rdf3xJoinOrder(?2:POS>?0:POS>?1:PSO)');
    expect(result.metrics.queryPlan).toContain('Rdf3xJoinOrderBy(desc:createdAt)');
    expect(result.metrics.queryPlan).toContain('Rdf3xJoinLimit');
  });

  it('keeps RDF-3X join order connected after the narrowest start pattern', () => {
    const graph = namedNode('https://g');
    const created = namedNode('https://p/created');
    const flag = namedNode('https://p/flag');
    const tag = namedNode('https://p/tag');
    const msg1 = namedNode('https://message/1');
    const msg2 = namedNode('https://message/2');
    const msg3 = namedNode('https://message/3');
    const msg4 = namedNode('https://message/4');
    const other1 = namedNode('https://other/1');
    const other2 = namedNode('https://other/2');
    quadIndex.multiPut([
      quad(msg1, created, literal('2026-05-18T00:00:01.000Z'), graph),
      quad(msg2, created, literal('2026-05-18T00:00:02.000Z'), graph),
      quad(msg3, created, literal('2026-05-18T00:00:03.000Z'), graph),
      quad(msg4, created, literal('2026-05-18T00:00:04.000Z'), graph),
      quad(msg1, flag, literal('selected'), graph),
      quad(other1, tag, literal('noise'), graph),
      quad(other2, tag, literal('noise'), graph),
    ]);
    rdf3x.rebuildFromCurrentQuads();

    const result = rdf3x.joinPatterns([
      {
        pattern: {
          predicate: tag,
          object: literal('noise'),
        },
        variables: {},
      },
      {
        pattern: {
          predicate: created,
        },
        variables: {
          subject: 'message',
          object: 'createdAt',
        },
      },
      {
        pattern: {
          predicate: flag,
          object: literal('selected'),
        },
        variables: {
          subject: 'message',
        },
      },
    ], {
      project: ['message', 'createdAt'],
      distinct: true,
    });

    expect(result.bindings.map((binding) => ({
      message: binding.message.value,
      createdAt: binding.createdAt.value,
    }))).toEqual([
      {
        message: 'https://message/1',
        createdAt: '2026-05-18T00:00:01.000Z',
      },
    ]);
    expect(result.metrics.queryPlan).toContain('Rdf3xJoinOrder(?2:POS>?1:PSO>?0:POS)');
    expect(result.metrics.queryPlan).toContain('Rdf3xJoinDistinct(?message,?createdAt)');
  });

  it('uses bound-slot fanout estimates when choosing between connected RDF-3X joins', () => {
    const graph = namedNode('https://g');
    const flag = namedNode('https://p/flag');
    const owner = namedNode('https://p/owner');
    const title = namedNode('https://p/title');
    const selected = literal('selected');
    const msg1 = namedNode('https://message/1');
    const rows: Quad[] = [
      quad(msg1, flag, selected, graph),
    ];

    for (let index = 1; index <= 100; index += 1) {
      rows.push(quad(
        namedNode(`https://message/${index}`),
        title,
        literal(`title-${index}`),
        graph,
      ));
    }
    for (let index = 1; index <= 30; index += 1) {
      rows.push(quad(
        msg1,
        owner,
        namedNode(`https://owner/${index}`),
        graph,
      ));
    }

    quadIndex.multiPut(rows);
    rdf3x.rebuildFromCurrentQuads();

    const result = rdf3x.joinPatterns([
      {
        pattern: {
          predicate: flag,
          object: selected,
        },
        variables: {
          subject: 'message',
        },
      },
      {
        pattern: {
          predicate: owner,
        },
        variables: {
          subject: 'message',
          object: 'owner',
        },
      },
      {
        pattern: {
          predicate: title,
        },
        variables: {
          subject: 'message',
          object: 'title',
        },
      },
    ], {
      project: ['message', 'title'],
      distinct: true,
    });

    expect(result.bindings.map((binding) => ({
      message: binding.message.value,
      title: binding.title.value,
    }))).toEqual([
      {
        message: 'https://message/1',
        title: 'title-1',
      },
    ]);
    expect(result.metrics.queryPlan).toContain('Rdf3xJoinOrder(?0:POS>?2:PSO>?1:PSO)');
    expect(result.metrics.queryPlan?.filter((step) => step === 'Rdf3xMergeJoin(?message)')).toHaveLength(2);
  });

  it('uses index-only RDF-3X joins for DISTINCT term projections without graph semantics', () => {
    const graphA = namedNode('https://g/a');
    const graphB = namedNode('https://g/b');
    const type = namedNode('https://p/type');
    const title = namedNode('https://p/title');
    const messageType = namedNode('https://type/Message');
    const msg1 = namedNode('https://message/1');
    const msg2 = namedNode('https://message/2');
    quadIndex.multiPut([
      quad(msg1, type, messageType, graphA),
      quad(msg1, type, messageType, graphB),
      quad(msg1, title, literal('hello'), graphA),
      quad(msg1, title, literal('hello'), graphB),
      quad(msg2, type, messageType, graphA),
    ]);
    rdf3x.rebuildFromCurrentQuads();

    const patterns = [
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
          predicate: title,
        },
        variables: {
          subject: 'message',
          object: 'title',
        },
      },
    ];
    const baseline = quadIndex.joinPatterns(patterns, {
      project: ['message', 'title'],
      distinct: true,
    });
    const result = rdf3x.joinPatterns(patterns, {
      project: ['message', 'title'],
      distinct: true,
    });

    expect(bindingKeys(result.bindings)).toEqual(bindingKeys(baseline.bindings));
    expect(result.bindings.map((binding) => ({
      message: binding.message.value,
      title: binding.title.value,
    }))).toEqual([
      {
        message: 'https://message/1',
        title: 'hello',
      },
    ]);
    expect(result.metrics.queryPlan).toContain('Rdf3xIndexOnlyJoin');
    expect(result.metrics.queryPlan).toContain('Rdf3xMergeJoin(?message)');
    expect(result.metrics.queryPlan?.join('\n')).not.toContain('rdf3x_triple_membership');
  });

  it('counts connected BGP joins inside RDF-3X SQL', () => {
    const graph = namedNode('https://g');
    const member = namedNode('https://p/member');
    const status = namedNode('https://p/status');
    const thread1 = namedNode('https://thread/1');
    const thread2 = namedNode('https://thread/2');
    const msg1 = namedNode('https://message/1');
    const msg2 = namedNode('https://message/2');
    const msg3 = namedNode('https://message/3');
    quadIndex.multiPut([
      quad(msg1, member, thread1, graph),
      quad(msg1, status, literal('open'), graph),
      quad(msg2, member, thread1, graph),
      quad(msg2, status, literal('open'), graph),
      quad(msg3, member, thread2, graph),
      quad(msg3, status, literal('open'), graph),
    ]);
    rdf3x.rebuildFromCurrentQuads();

    const patterns = [
      {
        pattern: {
          predicate: member,
        },
        variables: {
          subject: 'message',
          object: 'thread',
        },
      },
      {
        pattern: {
          predicate: status,
          object: literal('open'),
        },
        variables: {
          subject: 'message',
        },
      },
    ];
    const baseline = quadIndex.countJoinPatterns(patterns, {
      aggregates: [
        {
          type: 'count',
          as: 'messageCount',
          variable: 'message',
        },
        {
          type: 'count',
          as: 'distinctMessageCount',
          variable: 'message',
          distinct: true,
        },
      ],
    });
    const result = rdf3x.countJoinPatterns(patterns, {
      aggregates: [
        {
          type: 'count',
          as: 'messageCount',
          variable: 'message',
        },
        {
          type: 'count',
          as: 'distinctMessageCount',
          variable: 'message',
          distinct: true,
        },
      ],
    });

    expect(result.bindings.map((binding) => ({
      messageCount: binding.messageCount.value,
      distinctMessageCount: binding.distinctMessageCount.value,
    }))).toEqual(baseline.bindings.map((binding) => ({
      messageCount: binding.messageCount.value,
      distinctMessageCount: binding.distinctMessageCount.value,
    })));
    expect(result.metrics.indexChoice).toMatch(/^Rdf3xJoinBGP/);
    expect(result.metrics.matchedRows).toBe(3);
    expect(result.metrics.returnedRows).toBe(1);
    expect(result.metrics.queryPlan).toContain('Rdf3xJoinCount(count(?message),count:DISTINCT(?message))');
    expect(result.metrics.queryPlan?.join('\n')).toContain('COUNT(q0.subject_id) AS a0');
    expect(result.metrics.queryPlan?.join('\n')).toContain('COUNT(DISTINCT q0.subject_id) AS a1');
  });

  it('groups connected BGP joins and applies HAVING/order/limit inside RDF-3X SQL', () => {
    const graph = namedNode('https://g');
    const member = namedNode('https://p/member');
    const status = namedNode('https://p/status');
    const thread1 = namedNode('https://thread/1');
    const thread2 = namedNode('https://thread/2');
    const msg1 = namedNode('https://message/1');
    const msg2 = namedNode('https://message/2');
    const msg3 = namedNode('https://message/3');
    quadIndex.multiPut([
      quad(msg1, member, thread1, graph),
      quad(msg1, status, literal('open'), graph),
      quad(msg2, member, thread1, graph),
      quad(msg2, status, literal('open'), graph),
      quad(msg3, member, thread2, graph),
      quad(msg3, status, literal('open'), graph),
    ]);
    rdf3x.rebuildFromCurrentQuads();

    const result = rdf3x.groupCountJoinPatterns([
      {
        pattern: {
          predicate: member,
        },
        variables: {
          subject: 'message',
          object: 'thread',
        },
      },
      {
        pattern: {
          predicate: status,
          object: literal('open'),
        },
        variables: {
          subject: 'message',
        },
      },
    ], {
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
          aggregate: 'messageCount',
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
        thread: 'https://thread/2',
        messageCount: '1',
      },
    ]);
    expect(result.metrics.indexChoice).toMatch(/^Rdf3xJoinBGP/);
    expect(result.metrics.matchedRows).toBe(3);
    expect(result.metrics.returnedRows).toBe(1);
    expect(result.metrics.queryPlan).toContain('Rdf3xJoinGroupCount(?thread)');
    expect(result.metrics.queryPlan).toContain('Rdf3xJoinGroupCountHaving(messageCount$lt)');
    expect(result.metrics.queryPlan).toContain('Rdf3xJoinGroupCountOrder(desc:messageCount)');
    expect(result.metrics.queryPlan).toContain('Rdf3xJoinGroupCountLimit');
    expect(result.metrics.queryPlan?.join('\n')).toContain('GROUP BY q0.object_id HAVING a0 < ? ORDER BY a0 DESC LIMIT ?');
  });

  it('pushes numeric aggregates into RDF-3X SQL over BGP joins', () => {
    const graph = namedNode('https://g');
    const type = namedNode('https://p/type');
    const score = namedNode('https://p/score');
    const messageType = namedNode('https://type/Message');
    const xsdInteger = namedNode('http://www.w3.org/2001/XMLSchema#integer');
    const msg1 = namedNode('https://message/1');
    const msg2 = namedNode('https://message/2');
    const msg3 = namedNode('https://message/3');
    quadIndex.multiPut([
      quad(msg1, type, messageType, graph),
      quad(msg1, score, literal('2', xsdInteger), graph),
      quad(msg2, type, messageType, graph),
      quad(msg2, score, literal('10', xsdInteger), graph),
      quad(msg3, type, messageType, graph),
      quad(msg3, score, literal('not numeric'), graph),
    ]);
    rdf3x.rebuildFromCurrentQuads();

    const result = rdf3x.aggregateJoinPatterns([
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
          predicate: score,
        },
        variables: {
          subject: 'message',
          object: 'score',
        },
      },
    ], {
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
        {
          type: 'min',
          as: 'min',
          variable: 'score',
        },
        {
          type: 'max',
          as: 'max',
          variable: 'score',
        },
      ],
    });

    expect(result.bindings.map((binding) => ({
      sum: binding.sum.value,
      sumDatatype: binding.sum.datatype.value,
      avg: binding.avg.value,
      min: binding.min.value,
      max: binding.max.value,
    }))).toEqual([
      {
        sum: '12',
        sumDatatype: 'http://www.w3.org/2001/XMLSchema#decimal',
        avg: '6',
        min: '2',
        max: '10',
      },
    ]);
    expect(result.metrics.matchedRows).toBe(2);
    expect(result.metrics.queryPlan).toContain('Rdf3xJoinAggregateNumeric(?score)');
    expect(result.metrics.queryPlan?.join('\n')).toContain('COALESCE(SUM(rdf3x_agg_numeric_t0.numeric_value), 0) AS a0');
  });

  it('groups numeric aggregates inside RDF-3X SQL over BGP joins', () => {
    const graph = namedNode('https://g');
    const member = namedNode('https://p/member');
    const score = namedNode('https://p/score');
    const xsdInteger = namedNode('http://www.w3.org/2001/XMLSchema#integer');
    const thread1 = namedNode('https://thread/1');
    const thread2 = namedNode('https://thread/2');
    const msg1 = namedNode('https://message/1');
    const msg2 = namedNode('https://message/2');
    const msg3 = namedNode('https://message/3');
    const msg4 = namedNode('https://message/4');
    quadIndex.multiPut([
      quad(msg1, member, thread1, graph),
      quad(msg1, score, literal('2', xsdInteger), graph),
      quad(msg2, member, thread1, graph),
      quad(msg2, score, literal('10', xsdInteger), graph),
      quad(msg3, member, thread2, graph),
      quad(msg3, score, literal('4', xsdInteger), graph),
      quad(msg4, member, thread2, graph),
      quad(msg4, score, literal('not numeric'), graph),
    ]);
    rdf3x.rebuildFromCurrentQuads();

    const result = rdf3x.groupAggregateJoinPatterns([
      {
        pattern: {
          predicate: member,
        },
        variables: {
          subject: 'message',
          object: 'thread',
        },
      },
      {
        pattern: {
          predicate: score,
        },
        variables: {
          subject: 'message',
          object: 'score',
        },
      },
    ], {
      groupBy: ['thread'],
      aggregates: [
        {
          type: 'count',
          as: 'messageCount',
          variable: 'message',
        },
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
        {
          type: 'min',
          as: 'min',
          variable: 'score',
        },
        {
          type: 'max',
          as: 'max',
          variable: 'score',
        },
      ],
      having: [
        {
          aggregate: 'sum',
          operator: '$gte',
          value: 4,
        },
      ],
      orderBy: [
        {
          variable: 'sum',
          direction: 'desc',
        },
      ],
    });

    expect(result.bindings.map((binding) => ({
      thread: binding.thread.value,
      count: binding.messageCount.value,
      sum: binding.sum.value,
      sumDatatype: binding.sum.datatype.value,
      avg: binding.avg.value,
      min: binding.min.value,
      max: binding.max.value,
    }))).toEqual([
      {
        thread: 'https://thread/1',
        count: '2',
        sum: '12',
        sumDatatype: 'http://www.w3.org/2001/XMLSchema#decimal',
        avg: '6',
        min: '2',
        max: '10',
      },
      {
        thread: 'https://thread/2',
        count: '1',
        sum: '4',
        sumDatatype: 'http://www.w3.org/2001/XMLSchema#decimal',
        avg: '4',
        min: '4',
        max: '4',
      },
    ]);
    expect(result.metrics.matchedRows).toBe(3);
    expect(result.metrics.queryPlan).toContain('Rdf3xJoinGroupAggregateNumeric(?score)');
    expect(result.metrics.queryPlan).toContain('Rdf3xJoinGroupAggregateHaving(sum$gte)');
    expect(result.metrics.queryPlan).toContain('Rdf3xJoinGroupAggregateOrder(desc:sum)');
    expect(result.metrics.queryPlan?.join('\n')).toContain('GROUP BY q0.object_id HAVING a1 >= ? ORDER BY a1 DESC');
  });
});

function quadKeys(quads: Quad[]): string[] {
  return quads.map((item) => [
    item.graph.termType,
    item.graph.value,
    item.subject.value,
    item.predicate.value,
    item.object.termType,
    item.object.value,
    item.object.termType === 'Literal' ? item.object.datatype.value : '',
    item.object.termType === 'Literal' ? item.object.language : '',
  ].join('\u001f')).sort();
}

function bindingKeys(bindings: Array<Record<string, { value: string; termType: string }>>): string[] {
  return bindings.map((binding) => Object.keys(binding).sort().map((key) => (
    `${key}:${binding[key].termType}:${binding[key].value}`
  )).join('\u001f')).sort();
}
