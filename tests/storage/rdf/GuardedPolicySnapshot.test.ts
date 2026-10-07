import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { DataFactory } from 'n3';
import { digestGroundPolicy, parseGuardedPolicyUpdate, sameGuardedPolicySnapshot } from '../../../src/storage/rdf/GuardedPolicySnapshot';
const { namedNode: n, literal: l, quad: q, blankNode: b } = DataFactory;
const iri = 'https://pod.example/room/.acl';
const scope = 'https://pod.example/room/';
const row = q(n(`${iri}#rule`), n('http://www.w3.org/2000/01/rdf-schema#label'), l('Ground'));
const envelope = () => ({version: 1, update: 'INSERT { GRAPH <urn:g> {} } WHERE { GRAPH <urn:g> {} }', guard: {
  profile: 'wac-ground-v1', scope, ancestors: [],
  resources: [{iri: scope, container: true, children: [], policyIri: iri}],
  policies: [{iri, kind: 'wac', state: 'present-empty', digest: digestGroundPolicy(iri, 'wac', [])}],
}});
describe('ground policy snapshot wire contract', () => {
  it('matches an independently encoded UTF8 SHA256 tuple', () => {
    const expected = createHash('sha256').update(JSON.stringify(['ground-RDF-v1', iri, 'wac', [[
      ['NamedNode', `${iri}#rule`], ['NamedNode', row.predicate.value], ['Literal', 'Ground', 'http://www.w3.org/2001/XMLSchema#string', ''],
    ]]])).digest('hex');
    expect(digestGroundPolicy(iri, 'wac', [row])).toBe(expected);
  });
  it('normalizes order, duplicate RDF facts and an exact document graph', () => {
    const other = q(n(`${iri}#other`), row.predicate, l('Other'));
    expect(digestGroundPolicy(iri, 'wac', [row, other, row])).toBe(digestGroundPolicy(iri, 'wac', [other, q(row.subject, row.predicate, row.object, n(iri))]));
  });
  it('retains lexical, datatype, language and document identity', () => {
    const base = digestGroundPolicy(iri, 'wac', [row]);
    for (const object of [l('ground'), l('Ground', 'en'), l('Ground', n('urn:type'))]) {
      expect(digestGroundPolicy(iri, 'wac', [q(row.subject, row.predicate, object)])).not.toBe(base);
    }
    expect(digestGroundPolicy(`${scope}other.acl`, 'wac', [row])).not.toBe(base);
  });
  it('rejects blank nodes and foreign named graphs', () => {
    expect(() => digestGroundPolicy(iri, 'wac', [q(b('a'), row.predicate, row.object)])).toThrow(/ground/);
    expect(() => digestGroundPolicy(iri, 'wac', [q(row.subject, row.predicate, row.object, n('https://elsewhere.example/'))])).toThrow(/Foreign/);
  });
  it('keeps empty-200 and absent404 distinct', () => {
    const empty = parseGuardedPolicyUpdate(envelope());
    const absent = structuredClone(envelope());
    Object.assign(absent.guard.policies[0], {state: 'absent404', digest: null});
    expect(sameGuardedPolicySnapshot(empty.guard, parseGuardedPolicyUpdate(absent).guard)).toBe(false);
  });
  it.each(['version', 'record', 'duplicate', 'iri', 'state'] as const)('rejects malformed %s without accepting partial inventory', variant => {
    const value = envelope();
    if (variant === 'version') value.version = 2;
    if (variant === 'record') Object.assign(value.guard, {unknown: true});
    if (variant === 'duplicate') value.guard.resources.push(value.guard.resources[0]);
    if (variant === 'iri') value.guard.scope += '#fragment';
    if (variant === 'state') value.guard.policies[0].digest = 'not-a-digest';
    expect(() => parseGuardedPolicyUpdate(value)).toThrow();
  });
});
