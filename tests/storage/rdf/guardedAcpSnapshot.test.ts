import { describe, expect, it } from 'vitest';
import { DataFactory, type Quad } from 'n3';
import { assertGroundAcpPolicy, digestGroundPolicy, parseGuardedPolicyUpdate,
  GUARDED_POLICY_PROFILE_KIND } from '../../../src/storage/rdf/GuardedPolicySnapshot';
import { guardedPolicyProfileFor } from '../../../src/runtime/bootstrap';

const { namedNode: n, quad: q } = DataFactory;
const acp = 'http://www.w3.org/ns/solid/acp#';
const acl = 'http://www.w3.org/ns/auth/acl#';
const rdfType = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const doc = 'https://x.example/alice/room/.acr';
const resource = 'https://x.example/alice/room/';
const acr = n(`${doc}#acr`);
const access = n(`${doc}#access`);
const policy = n(`${doc}#policy`);
const matcher = n(`${doc}#matcher`);
const agent = n('https://x.example/profile/card#me');
function graph(): Quad[] {
  return [
    q(acr, n(rdfType), n(`${acp}AccessControlResource`)), q(acr, n(`${acp}resource`), n(resource)),
    q(acr, n(`${acp}accessControl`), access),
    q(access, n(rdfType), n(`${acp}AccessControl`)), q(access, n(`${acp}apply`), policy),
    q(policy, n(rdfType), n(`${acp}Policy`)), q(policy, n(`${acp}allow`), n(`${acl}Read`)), q(policy, n(`${acp}anyOf`), matcher),
    q(matcher, n(rdfType), n(`${acp}Matcher`)), q(matcher, n(`${acp}agent`), agent),
  ];
}

describe('ACP ground profile server contract (pure)', () => {
  it('derives the profile from the actual authMode branch', () => {
    expect(guardedPolicyProfileFor('acl' as never)).toBe('wac-ground-v1');
    expect(guardedPolicyProfileFor('acp' as never)).toBe('acp-ground-v1');
    expect(guardedPolicyProfileFor('allow-all' as never)).toBe('unsupported');
    expect(GUARDED_POLICY_PROFILE_KIND['acp-ground-v1']).toBe('acp');
  });
  it('accepts a complete same-document ACP shape and rejects incomplete/foreign/unsupported ones', () => {
    expect(() => assertGroundAcpPolicy(doc, resource, graph())).not.toThrow();
    expect(() => assertGroundAcpPolicy(doc, 'https://x.example/other/', graph())).toThrow();
    expect(() => assertGroundAcpPolicy(doc, resource, graph().filter(value => !value.subject.equals(matcher)))).toThrow();
    expect(() => assertGroundAcpPolicy(doc, resource, graph().map(value =>
      value.subject.equals(acr) ? q(value.subject, value.predicate, value.object, n('https://foreign.example/')) : value))).toThrow();
    const blank = q(DataFactory.blankNode(), n(rdfType), n(`${acp}Matcher`));
    expect(() => assertGroundAcpPolicy(doc, resource, [ ...graph(), blank ])).toThrow();
  });
  it('accepts an exact empty RDF set as present-empty but still refuses inert-only and partial graphs', () => {
    expect(() => assertGroundAcpPolicy(doc, resource, [])).not.toThrow();
    const empty = digestGroundPolicy(doc, 'acp', []);
    expect(empty).toMatch(/^[a-f0-9]{64}$/u);
    expect(empty).not.toBe(digestGroundPolicy(doc, 'acp', graph()));
    expect(() => assertGroundAcpPolicy('not a url', resource, [])).toThrow();
    expect(() => assertGroundAcpPolicy(doc, 'not a url', [])).toThrow();
    expect(() => assertGroundAcpPolicy(doc, resource,
      [ q(n(resource), n('https://x.example/inert'), n('https://x.example/value')) ])).toThrow();
    expect(() => assertGroundAcpPolicy(doc, resource,
      graph().filter(value => !(value.subject.equals(acr) && value.predicate.equals(n(`${acp}resource`)))))).toThrow();
  });
  it('treats exact duplicate ground policy triples as the same RDF set', () => {
    expect(() => assertGroundAcpPolicy(doc, resource, [ ...graph(), ...graph() ])).not.toThrow();
    expect(digestGroundPolicy(doc, 'acp', [ ...graph(), ...graph() ])).toBe(digestGroundPolicy(doc, 'acp', graph()));
  });
  it('accepts the installed special agents through acp:agent only', () => {
    for (const special of ['PublicAgent', 'AuthenticatedAgent'] as const) {
      const withSpecial = graph().map(value => value.subject.equals(matcher) && value.predicate.equals(n(`${acp}agent`))
        ? q(matcher, n(`${acp}agent`), n(`${acp}${special}`)) : value);
      expect(() => assertGroundAcpPolicy(doc, resource, withSpecial)).not.toThrow();
      const inventedClass = [ ...withSpecial, q(matcher, n(`${acp}agentClass`), n(`${acp}${special}`)) ];
      expect(() => assertGroundAcpPolicy(doc, resource, inventedClass)).toThrow();
    }
  });
  it('refuses the unsupported ACP intersection before any effect', () => {
    const replacePredicate = (from: string, to: string) => graph().map(value =>
      value.predicate.equals(n(`${acp}${from}`)) ? q(value.subject, n(`${acp}${to}`), value.object) : value);
    expect(() => assertGroundAcpPolicy(doc, resource, replacePredicate('apply', 'applyMembers'))).toThrow();
    expect(() => assertGroundAcpPolicy(doc, resource,
      [ ...graph(), q(matcher, n(`${acp}client`), n(`${acp}PublicClient`)) ])).toThrow();
    expect(() => assertGroundAcpPolicy(doc, resource,
      graph().map(value => value.predicate.equals(n(`${acp}agent`)) ? q(matcher, n(`${acp}agent`), DataFactory.literal(agent.value)) : value))).toThrow();
    expect(() => assertGroundAcpPolicy(doc, resource,
      [ ...graph(), q(matcher, n(`${acp}unsupportedCondition`), n('https://x.example/value')) ])).toThrow();
    expect(() => assertGroundAcpPolicy(doc, resource,
      [ ...graph(), q(n(`${doc}#second`), n(`${acp}resource`), n(resource)), q(n(`${doc}#second`), n(`${acp}accessControl`), access) ])).toThrow();
    expect(() => assertGroundAcpPolicy(doc, resource, graph().map(value =>
      value.subject.equals(matcher) ? q(n('https://foreign.example/other.acr#m'), value.predicate, value.object) : value))).toThrow();
    expect(() => assertGroundAcpPolicy(doc, resource, graph().map(value =>
      value.predicate.equals(n(`${acp}allow`)) ? q(value.subject, n(`${acp}allow`), n(`${acp}Read`)) : value))).toThrow();
  });
  it('rejects noneOf-only / allOf-only profiles the supported subset cannot evaluate', () => {
    const noneOfOnly = graph().filter(value => !value.predicate.equals(n(`${acp}anyOf`)))
      .concat(q(policy, n(`${acp}noneOf`), matcher));
    expect(() => assertGroundAcpPolicy(doc, resource, noneOfOnly)).toThrow();
  });
  it('digests ACP ground content independent of order and graph normalization', () => {
    const baseline = digestGroundPolicy(doc, 'acp', graph());
    expect(digestGroundPolicy(doc, 'acp', [ ...graph() ].reverse())).toBe(baseline);
    expect(digestGroundPolicy(doc, 'acp', graph().map(value => q(value.subject, value.predicate, value.object, n(doc))))).toBe(baseline);
    expect(digestGroundPolicy(doc, 'wac', graph())).not.toBe(baseline);
  });
  it('rejects an envelope whose profile and policy kinds disagree', () => {
    const guard = { profile: 'acp-ground-v1', scope: resource,
      resources: [{ iri: resource, container: true, children: [], policyIri: doc }], ancestors: [],
      policies: [{ iri: doc, kind: 'acp', state: 'absent404', digest: null }] };
    expect(parseGuardedPolicyUpdate({ version: 1, update: 'INSERT { GRAPH <urn:g> { <urn:s> <urn:p> "v" } } WHERE {}', guard }).guard.profile).toBe('acp-ground-v1');
    expect(() => parseGuardedPolicyUpdate({ version: 1, update: 'INSERT { GRAPH <urn:g> { <urn:s> <urn:p> "v" } } WHERE {}',
      guard: { ...guard, policies: [{ iri: doc, kind: 'wac', state: 'absent404', digest: null }] } })).toThrow();
  });
});
