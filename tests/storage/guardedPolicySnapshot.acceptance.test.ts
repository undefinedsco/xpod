// Independent ground-RDF wire/digest contract; no effective authorization claim.
import { describe, expect, it } from 'vitest';
import { DataFactory } from 'n3';
import type { Quad } from '@rdfjs/types';
import { digestGroundPolicy, parseGuardedPolicyUpdate } from '../../src/storage/rdf/GuardedPolicySnapshot';
import { expectedGroundDigest } from '../helpers/GuardedPolicyClosureFixture';

const { namedNode: n, literal: l, quad: q } = DataFactory;
const iri = 'https://digest.invalid/pod/policy';
const scope = 'https://digest.invalid/pod/room/';
const subject = n(`${iri}#authorization`);
const predicate = n('http://www.w3.org/ns/auth/acl#default');
const baseline = [ q(subject, predicate, n(scope)), q(subject, n('urn:label'), l('名字\u001f[] 😀')) ];
const envelope = () => ({ version: 1, update: 'INSERT { GRAPH <https://digest.invalid/pod/room/index.ttl> { <urn:s> <urn:p> "v" } } WHERE {}',
  guard: { profile: 'wac-ground-v1', scope,
    resources: [ { iri: scope, container: true, children: [], policyIri: iri } ], ancestors: [],
    policies: [ { iri, kind: 'wac', state: 'present', digest: expectedGroundDigest(iri, baseline) } ],
  } });

describe('independent ground policy digest and strict versioned envelope', () => {
  it('matches the independently encoded UTF8/SHA256 contract including Unicode/delimiter literals', () => {
    expect(digestGroundPolicy(iri, 'wac', baseline)).toBe(expectedGroundDigest(iri, baseline));
  });
  it('ignores RDF order and duplicate triples while normalizing only the verified document graph', () => {
    const withNamedGraph = baseline.map(value => q(value.subject, value.predicate, value.object, n(iri)));
    expect(digestGroundPolicy(iri, 'wac', [ ...withNamedGraph.reverse(), ...baseline ])).toBe(expectedGroundDigest(iri, baseline));
  });
  it.each([
    [ 'lexical numeric form', l('01', n('http://www.w3.org/2001/XMLSchema#integer')), l('1', n('http://www.w3.org/2001/XMLSchema#integer')) ],
    [ 'datatype', l('1'), l('1', n('http://www.w3.org/2001/XMLSchema#integer')) ],
    [ 'language', l('value', 'en'), l('value', 'zh') ],
  ])('preserves %s instead of converting RDF literals to JavaScript values', (_label, first, second) => {
    expect(digestGroundPolicy(iri, 'wac', [ q(subject, predicate, first) ])).not.toBe(digestGroundPolicy(iri, 'wac', [ q(subject, predicate, second) ]));
  });
  it('normalizes language tags by the explicitly specified lowercase rule', () => {
    expect(digestGroundPolicy(iri, 'wac', [ q(subject, predicate, l('text', 'EN')) ])).toBe(digestGroundPolicy(iri, 'wac', [ q(subject, predicate, l('text', 'en')) ]));
  });
  it.each([
    [ 'full default', q(subject, predicate, n(`${scope}history/`)) ],
    [ 'authorization type', q(subject, n('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), n('urn:OtherAuthorization')) ],
    [ 'additional label', q(subject, n('http://www.w3.org/2000/01/rdf-schema#label'), l('new')) ],
  ])('includes %s changes in the full policy content digest', (_label, extra) => {
    expect(digestGroundPolicy(iri, 'wac', [ ...baseline, extra ])).not.toBe(expectedGroundDigest(iri, baseline));
  });
  it.each([
    [ 'blank subject', q(DataFactory.blankNode('local'), predicate, n(scope)) ],
    [ 'blank object', q(subject, predicate, DataFactory.blankNode('local')) ],
    [ 'foreign graph', q(subject, predicate, n(scope), n(`${iri}-foreign`)) ],
    [ 'blank graph', q(subject, predicate, n(scope), DataFactory.blankNode('graph')) ],
    [ 'RDF-star', q(subject, predicate, q(subject, predicate, n(scope))) ],
  ])('explicitly refuses unsupported %s', (_label, unsupported) => {
    expect(() => digestGroundPolicy(iri, 'wac', [ unsupported as Quad ])).toThrow();
  });
  it('has a specified empty representation digest while absence remains separately encoded', () => {
    expect(digestGroundPolicy(iri, 'wac', [])).toBe(expectedGroundDigest(iri, []));
    const value = envelope(); value.guard.policies[0] = { iri, kind: 'wac', state: 'absent404', digest: null } as never;
    expect(parseGuardedPolicyUpdate(value).guard.policies[0]).toEqual({ iri, kind: 'wac', state: 'absent404', digest: null });
  });
  it.each([
    [ 'extra envelope field', (value: any) => { value.unguarded = true; } ],
    [ 'unsupported version', (value: any) => { value.version = 2; } ],
    [ 'duplicate resource', (value: any) => { value.guard.resources.push(value.guard.resources[0]); } ],
    [ 'duplicate policy', (value: any) => { value.guard.policies.push(value.guard.policies[0]); } ],
    [ 'non-container children', (value: any) => { value.guard.resources[0].container = false; value.guard.resources[0].children = [`${scope}child`]; } ],
    [ '404 with content digest', (value: any) => { value.guard.policies[0].state = 'absent404'; } ],
    [ 'fragment policy URI', (value: any) => { value.guard.policies[0].iri += '#subject'; } ],
    [ 'non-HTTP scope', (value: any) => { value.guard.scope = 'file:///tmp/room/'; } ],
    [ 'policy kind mismatch', (value: any) => { value.guard.policies[0].kind = 'acp'; } ],
    [ 'budget overrun', (value: any) => { value.guard.resources[0].children = Array.from({ length: 257 }, (_, i) => `${scope}${i}`); } ],
  ])('rejects %s without offering a less guarded envelope', (_label, mutate) => {
    const value = envelope(); mutate(value);
    expect(() => parseGuardedPolicyUpdate(value)).toThrow();
  });
});
