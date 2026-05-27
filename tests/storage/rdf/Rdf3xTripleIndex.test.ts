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
    });
    expect(rebuild.projectionRows).toBeGreaterThan(0);

    const stats = rdf3x.stats();
    expect(stats.membershipCount).toBe(4);
    expect(stats.uniqueTriples).toBe(3);
    expect(stats.graphCount).toBe(2);
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
    expect(scan.metrics.queryPlan?.join('\n')).toContain('JOIN rdf_terms object_numeric ON object_numeric.id = idx.object_id');
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
