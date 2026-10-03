import { DataFactory, Parser as TurtleParser, Store, Writer } from 'n3';
import { Parser as SparqlParser } from 'sparqljs';
import type { Quad, Term } from '@rdfjs/types';

interface ResourceColumn {
  dataType: string;
  options: { predicate?: string };
}

/** Temporary exact-write adapter; see docs/issues/2026-10-02-approval-conditional-update.md. */
export async function updateConditionalResource<T>(input: {
  iri: string;
  fetch: typeof fetch;
  columns: Record<string, ResourceColumn>;
  serialize(values: Record<string, unknown>): string;
  update(quads: Quad[]): { result: T; values?: Record<string, unknown> };
}): Promise<T> {
  const url = new URL(input.iri);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Run resource must be an HTTP(S) IRI');
  url.hash = '';
  const documentUrl = url.href;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await input.fetch(documentUrl, {
      headers: { accept: 'text/turtle' }, cache: 'no-store', redirect: 'error',
    });
    if (!response.ok) throw new Error(`Run document read failed: HTTP ${response.status}`);
    const etag = response.headers.get('etag');
    const text = await response.text();
    if (!etag || !/^"[^"\r\n]+"$/.test(etag)) throw new Error('Run updates require a strong document ETag');
    if (!response.headers.get('content-type')?.toLowerCase().includes('text/turtle')) throw new Error('Run updates require a Turtle document');
    const quads = new TurtleParser({ baseIRI: documentUrl }).parse(text);
    const update = input.update(quads);
    if (!update.values) return update.result;
    const inserted = insertQuads(input.serialize(update.values), documentUrl, input.iri);
    const changedPredicates = new Set(Object.keys(update.values).map(key => input.columns[key]?.options.predicate).filter(Boolean));
    const inlinePredicates = new Set(Object.keys(update.values)
      .filter(key => ['object', 'json', 'array'].includes(input.columns[key]?.dataType))
      .map(key => input.columns[key]?.options.predicate).filter(Boolean));
    const owned = new Set<string>();
    const keyOf = (term: Term) => `${term.termType}:${term.value}`;
    const isOwned = (term: Term) => term.termType === 'BlankNode'
      || (term.termType === 'NamedNode' && term.value.startsWith(`${input.iri}/`));
    for (const quad of quads) {
      if (quad.subject.value === input.iri && inlinePredicates.has(quad.predicate.value) && isOwned(quad.object)) owned.add(keyOf(quad.object));
    }
    let size = -1;
    while (size !== owned.size) {
      size = owned.size;
      for (const quad of quads) if (owned.has(keyOf(quad.subject)) && isOwned(quad.object)) owned.add(keyOf(quad.object));
    }
    const preserved = quads.filter(quad => !owned.has(keyOf(quad.subject))
      && !(quad.subject.value === input.iri && changedPredicates.has(quad.predicate.value)));
    const store = new Store([...preserved, ...inserted]);
    const body = await new Promise<string>((resolve, reject) => {
      const writer = new Writer({ format: 'Turtle' });
      writer.addQuads(store.getQuads(null, null, null, null));
      writer.end((error, output) => error ? reject(error) : resolve(output));
    });
    const result = await input.fetch(documentUrl, {
      method: 'PUT', headers: { 'content-type': 'text/turtle', 'if-match': etag }, body, redirect: 'error',
    });
    await result.arrayBuffer();
    if (result.status === 412) continue; // Re-read and recompute; never replay stale state.
    if (!result.ok) throw new Error(`Run document update failed: HTTP ${result.status}`);
    return update.result;
  }
  throw new Error('Run document changed repeatedly during conditional update');
}

export function resourceLiteral(quads: Quad[], iri: string, predicate: string): string | undefined {
  const values = quads.filter(quad => quad.subject.termType === 'NamedNode' && quad.subject.value === iri && quad.predicate.value === predicate);
  if (values.length > 1 || values.some(quad => quad.object.termType !== 'Literal')) throw new Error('Ambiguous Run lifecycle state');
  return values[0]?.object.value;
}

function insertQuads(query: string, documentUrl: string, iri: string): Quad[] {
  const parsed = new SparqlParser().parse(query);
  if (parsed.type !== 'update') throw new Error('Expected ORM INSERT serialization');
  const output: Quad[] = [];
  for (const update of parsed.updates) {
    if (!('updateType' in update) || update.updateType !== 'insert') throw new Error('Expected ORM INSERT DATA serialization');
    for (const graph of update.insert) {
      if (graph.type !== 'graph' || graph.name.termType !== 'NamedNode' || graph.name.value !== documentUrl) throw new Error('ORM serialization escaped the Run document');
      for (const triple of graph.triples) {
        if (triple.subject.termType !== 'BlankNode' && (triple.subject.termType !== 'NamedNode'
          || !(triple.subject.value === iri || triple.subject.value.startsWith(`${iri}/`)))) throw new Error('ORM serialization escaped the Run resource');
        if (!('termType' in triple.predicate) || triple.predicate.termType !== 'NamedNode'
          || triple.object.termType === 'Variable') throw new Error('Expected concrete RDF triples');
        output.push(DataFactory.quad(triple.subject, triple.predicate, triple.object));
      }
    }
  }
  return output;
}
