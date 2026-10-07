import { createRequire } from 'node:module';
import { QueryEngine } from '@comunica/query-sparql';
import { messageResource } from '@undefineds.co/models';
import { Parser, Store } from 'n3';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { TripleBuilderImpl } = require('../../node_modules/@undefineds.co/drizzle-solid/dist/core/triple/builder.js');
const { LdpExecutor } = require('../../node_modules/@undefineds.co/drizzle-solid/dist/core/execution/ldp-executor.js');
const document = 'https://pod.example/alice/.data/chat/team/2026/10/03/messages.ttl';
const secondDocument = 'https://pod.example/alice/.data/chat/team/2026/10/04/messages.ttl';

function fixture(rejectedDocument?: string, unreadableSubject?: string) {
  const graphs = new Map<string, Store>();
  const patches: string[] = [];
  const invalidations: string[] = [];
  const builder = new TripleBuilderImpl();
  const engine = new QueryEngine();
  const resourceOf = (subject: string): string => subject.split('#')[0];
  const add = (subject: string): void => {
    const resource = resourceOf(subject);
    const graph = graphs.get(resource) ?? new Store();
    for (const [column, value] of [
      [messageResource.content, `quoted "message" Unicode 中文 😀 ${subject}`],
      [messageResource.metadata, { '@id': `${subject}/metadata`, marker: subject }],
    ] as const) {
      const built = builder.buildInsert(subject, column, value, messageResource);
      graph.addQuads(new Parser({ baseIRI: resource }).parse(builder.toN3Strings([...built.triples, ...(built.childTriples ?? [])]).join('\n')));
    }
    graphs.set(resource, graph);
  };
  const executor = new LdpExecutor({
    queryBindings: async(query: string, resource: string) => {
      if (unreadableSubject && query.includes(`<${unreadableSubject}>`)) throw new Error('Selected subject read failed');
      return await (await engine.queryBindings(query, { sources: [graphs.get(resource)!] })).toArray();
    },
    invalidateHttpCache: async(resource: string) => { invalidations.push(resource); },
  }, async(resource: string, options: RequestInit) => {
    expect(options.method).toBe('PATCH');
    patches.push(resource);
    if (resource === rejectedDocument) return new Response(null, { status: 403 });
    expect(new Headers(options.headers).get('Content-Type')).toBe('application/sparql-update');
    await engine.queryVoid(String(options.body), { sources: [graphs.get(resource)!] });
    return new Response(null, { status: 204 });
  }, { getResourceMode: () => 'document', getResourceUrl: resourceOf });
  const remaining = (subject: string): number => graphs.get(resourceOf(subject))!.getQuads(null, null, null, null)
    .filter(quad => quad.subject.value === subject || quad.subject.value.startsWith(`${subject}/metadata`)).length;
  const snapshot = (subject: string): string[] => graphs.get(resourceOf(subject))!.getQuads(null, null, null, null)
    .filter(quad => quad.subject.value === subject || quad.subject.value.startsWith(`${subject}/metadata`))
    .map(quad => JSON.stringify(quad)).sort();
  return { executor, add, remaining, snapshot, patches, invalidations };
}

describe('shared-document deletion over real RDF', () => {
  it('deletes two selected subjects and inline metadata with one PATCH while preserving another subject', async() => {
    const f = fixture();
    const [a, b, protectedSubject] = ['a', 'b', 'protected'].map(id => `${document}#${id}`);
    for (const subject of [a, b, protectedSubject]) f.add(subject);
    const before = f.snapshot(protectedSubject);
    expect(before.length).toBeGreaterThan(1);
    const result = await f.executor.executeDelete([a, b], messageResource, document);
    expect(f.patches).toEqual([document]);
    expect(f.invalidations).toEqual([document]);
    expect(result).toHaveLength(2); // Existing per-subject afterDelete result count.
    expect(f.remaining(a)).toBe(0);
    expect(f.remaining(b)).toBe(0);
    expect(f.snapshot(protectedSubject)).toEqual(before);
  });

  it('keeps noncontiguous document operations in their original order', async() => {
    const f = fixture();
    const subjects = [`${document}#a`, `${secondDocument}#b`, `${document}#c`];
    subjects.forEach(f.add);
    await f.executor.executeDelete(subjects, messageResource, document);
    expect(f.patches).toEqual([document, secondDocument, document]);
    expect(subjects.map(f.remaining)).toEqual([0, 0, 0]);
  });

  it('rejects a forbidden later document, preserves it and does not touch a following run', async() => {
    const f = fixture(secondDocument);
    const a = `${document}#a`, b = `${secondDocument}#b`, c = `${document}#c`;
    [a, b, c].forEach(f.add);
    const beforeB = f.snapshot(b), beforeC = f.snapshot(c);
    await expect(f.executor.executeDelete([a, b, c], messageResource, document)).rejects.toThrow(/403/);
    expect(f.patches).toEqual([document, secondDocument]);
    expect(f.remaining(a)).toBe(0);
    expect(f.snapshot(b)).toEqual(beforeB);
    expect(f.snapshot(c)).toEqual(beforeC);
  });

  it('does not issue a PATCH for an empty selection or duplicate a selected subject', async() => {
    const f = fixture();
    const a = `${document}#a`;
    f.add(a);
    expect(await f.executor.executeDelete([], messageResource, document)).toEqual([]);
    expect(f.patches).toEqual([]);
    expect(await f.executor.executeDelete([a, a], messageResource, document)).toHaveLength(1);
    expect(f.patches).toEqual([document]);
    expect(f.remaining(a)).toBe(0);
  });

  it('reads a whole document run before writing, so a later read failure publishes no deletion', async() => {
    const a = `${document}#a`, b = `${document}#b`;
    const f = fixture(undefined, b);
    [a, b].forEach(f.add);
    const beforeA = f.snapshot(a), beforeB = f.snapshot(b);
    await expect(f.executor.executeDelete([a, b], messageResource, document)).rejects.toThrow('Selected subject read failed');
    expect(f.patches).toEqual([]);
    expect(f.snapshot(a)).toEqual(beforeA);
    expect(f.snapshot(b)).toEqual(beforeB);
  });
});
