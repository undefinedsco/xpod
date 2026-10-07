// Root-owned wire contract; actual ACP HTTP semantics are verified separately.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DataFactory } from 'n3';
import { digestGroundPolicy, parseGuardedPolicyUpdate } from '../../src/storage/rdf/GuardedPolicySnapshot';

const { namedNode: n, quad: q } = DataFactory;
const acp = 'http://www.w3.org/ns/solid/acp#';
const rdfType = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const iri = 'https://acp-contract.invalid/alice/room/.acr';
const scope = 'https://acp-contract.invalid/alice/room/';
const acr = n(`${iri}#acr`);
const baseline = [q(acr, n(rdfType), n(`${acp}AccessControlResource`)), q(acr, n(`${acp}resource`), n(scope))];
const tuples = baseline.map(value => [value.subject, value.predicate, value.object].map(term => ['NamedNode', term.value]));
tuples.sort((a, b) => Buffer.compare(Buffer.from(JSON.stringify(a)), Buffer.from(JSON.stringify(b))));
const digest = createHash('sha256').update(JSON.stringify(['ground-RDF-v1', iri, 'acp', tuples])).digest('hex');
const envelope = () => ({version: 1, update: `INSERT { GRAPH <${scope}index.ttl> { <urn:s> <urn:p> "v" } } WHERE {}`,
  guard: {profile: 'acp-ground-v1', scope,
    resources: [{iri: scope, container: true, children: [], policyIri: iri}], ancestors: [],
    policies: [{iri, kind: 'acp', state: 'present', digest}],
  }});

describe('independent ACP guarded snapshot wire contract', () => {
  it('accepts the ACP profile with strictly corresponding policy kinds', () => {
    expect(parseGuardedPolicyUpdate(envelope()).guard).toEqual(envelope().guard);
  });
  it('binds the complete ground digest to ACP kind and actual document', () => {
    expect(digestGroundPolicy(iri, 'acp' as never, baseline)).toBe(digest);
    expect(digestGroundPolicy(iri, 'acp' as never, [...baseline].reverse())).toBe(digest);
    expect(digestGroundPolicy(iri, 'acp' as never, baseline.map(value => q(value.subject, value.predicate, value.object, n(iri))))).toBe(digest);
    expect(digestGroundPolicy(iri, 'wac', baseline)).not.toBe(digest);
  });
  it.each(['profile', 'policy kind'])('rejects a mismatched %s instead of weakening the guard', mismatch => {
    const value = envelope();
    if (mismatch === 'profile') value.guard.profile = 'wac-ground-v1';
    else value.guard.policies[0].kind = 'wac';
    expect(() => parseGuardedPolicyUpdate(value)).toThrow();
  });
  it('keeps empty ACR content separate from a missing ACR', () => {
    const value = envelope();
    value.guard.policies[0] = {iri, kind: 'acp', state: 'absent404', digest: null} as never;
    expect(parseGuardedPolicyUpdate(value).guard.policies[0]).toEqual(value.guard.policies[0]);
  });
});
