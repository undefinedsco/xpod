import { DataFactory, termToId, type Term } from 'n3';
import { Generator } from 'sparqljs';
import type { CanonicalRoomSnapshot } from './canonicalRoomSource';
import { MatrixError } from './MatrixError';

const namedNode = DataFactory.namedNode;
const variable = DataFactory.variable;
const unsupported = (message: string): MatrixError => new MatrixError(415, 'M_UNSUPPORTED', message);

/** Term-aware SPARQL AST term: named nodes stay exact; literals retain datatype and language. */
function fenceObject(term: Term): unknown {
  if (term.termType === 'NamedNode') return namedNode(term.value);
  if (term.termType === 'Literal') {
    return term.language ? DataFactory.literal(term.value, term.language)
      : DataFactory.literal(term.value, namedNode(term.datatype.value));
  }
  throw unsupported('Canonical source fence object must be a named node or literal');
}
const notSameTerm = (left: unknown, right: unknown): unknown => ({
  type: 'operation', operator: '!', args: [ { type: 'operation', operator: 'sameterm', args: [ left, right ] } ],
});
const allOf = (conditions: readonly unknown[]): unknown => conditions.length === 1 ? conditions[0]
  : conditions.reduce((left, right) => ({ type: 'operation', operator: '&&', args: [ left, right ] }));
const rejectExtra = (document: string, patterns: unknown[]): unknown => ({
  type: 'filter', expression: { type: 'operation', operator: 'notexists',
    args: [ { type: 'graph', name: namedNode(document), patterns } ] },
});

/**
 * Exact whole current canonical raw state under the same server dependency locks, as shared sparqljs
 * WHERE patterns. Every sealed quad is validated up front (named-node subject/predicate, named-node
 * or literal object, and the admitted physical source document graph; blank nodes, RDF-star terms and
 * foreign graphs are refused rather than coerced) and must still be present with full term identity.
 * Term-identity anti-extra guards then reject any new subject, a new predicate on a sealed subject,
 * or a changed/added object for a sealed subject+predicate. The private guarded transport checks the
 * source before send, but only this native fence stops a change that lands after that precheck and
 * before execution. Object identities are deduplicated by RDF term identity, not by AST object.
 */
export function canonicalSourceFencePatterns(snapshot: CanonicalRoomSnapshot): unknown[] {
  const document = snapshot.facts.sourceIri.split('#')[0];
  if (!snapshot.quads.length) throw unsupported('Canonical source fence requires sealed raw quads');
  const predicatesBySubject = new Map<string, Set<string>>();
  const objectsBySubjectPredicate = new Map<string, Map<string, Map<string, unknown>>>();
  const positive: unknown[] = [];
  for (const quad of snapshot.quads) {
    if (quad.subject.termType !== 'NamedNode' || quad.predicate.termType !== 'NamedNode') {
      throw unsupported('Canonical source fence only supports named-node subjects and predicates');
    }
    if (quad.object.termType !== 'NamedNode' && quad.object.termType !== 'Literal') {
      throw unsupported('Canonical source fence object must be a named node or literal');
    }
    const graph = quad.graph;
    if (graph.termType !== 'DefaultGraph' && !(graph.termType === 'NamedNode' && graph.value === document)) {
      throw unsupported('Canonical source fence quad is not in the physical source document');
    }
    const subject = quad.subject.value;
    const predicate = quad.predicate.value;
    positive.push({ subject: namedNode(subject), predicate: namedNode(predicate), object: fenceObject(quad.object) });
    const predicates = predicatesBySubject.get(subject) ?? new Set<string>();
    predicates.add(predicate);
    predicatesBySubject.set(subject, predicates);
    const byPredicate = objectsBySubjectPredicate.get(subject) ?? new Map<string, Map<string, unknown>>();
    const objects = byPredicate.get(predicate) ?? new Map<string, unknown>();
    objects.set(termToId(quad.object), fenceObject(quad.object));
    byPredicate.set(predicate, objects);
    objectsBySubjectPredicate.set(subject, byPredicate);
  }
  const patterns: unknown[] = [
    { type: 'graph', name: namedNode(document), patterns: [ { type: 'bgp', triples: positive } ] },
  ];
  let index = 0;
  for (const [ subject, predicates ] of predicatesBySubject) {
    const predicateVar = variable(`sealedPredicate${index}`);
    const objectVar = variable(`sealedObject${index}`);
    patterns.push(rejectExtra(document, [
      { type: 'bgp', triples: [ { subject: namedNode(subject), predicate: predicateVar, object: objectVar } ] },
      { type: 'filter', expression: allOf([...predicates].map(predicate => notSameTerm(predicateVar, namedNode(predicate)))) },
    ]));
    for (const [ predicate, objects ] of objectsBySubjectPredicate.get(subject)!) {
      patterns.push(rejectExtra(document, [
        { type: 'bgp', triples: [ { subject: namedNode(subject), predicate: namedNode(predicate), object: objectVar } ] },
        { type: 'filter', expression: allOf([...objects.values()].map(object => notSameTerm(objectVar, object))) },
      ]));
    }
    index += 1;
  }
  const anySubject = variable(`sealedAnySubject${index}`);
  patterns.push(rejectExtra(document, [
    { type: 'bgp', triples: [ { subject: anySubject, predicate: variable(`sealedAnyPredicate${index}`),
      object: variable(`sealedAnyObject${index}`) } ] },
    { type: 'filter', expression: allOf([...predicatesBySubject.keys()].map(subject => notSameTerm(anySubject, namedNode(subject)))) },
  ]));
  return patterns;
}

/** Serialize the shared fence patterns into a SPARQL fragment for the string-built ACL delta. */
export function canonicalSourceFenceSparql(snapshot: CanonicalRoomSnapshot): string {
  const patterns = canonicalSourceFencePatterns(snapshot);
  const text = new Generator().stringify({ type: 'query', queryType: 'SELECT',
    variables: [ { termType: 'Wildcard', value: '*' } ], where: patterns } as never);
  return text.slice(text.indexOf('{') + 1, text.lastIndexOf('}')).trim();
}
