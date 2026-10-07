import { describe, expect, it } from 'vitest';
import { DataFactory, type Quad } from 'n3';
import { assertGroundAcpPolicy } from '../../../src/storage/rdf/GuardedPolicySnapshot';

/**
 * B-owned prerequisite lock for the ACP policy-shell admission: exactly one strictly typed,
 * same-document, exact-resource-associated ACR may carry zero accessControl/memberAccessControl links
 * (inherited-only behavior) while all other shape/reachability/role validation is preserved.
 */
const { namedNode: n, quad: q } = DataFactory;
const acp = 'http://www.w3.org/ns/solid/acp#';
const acl = 'http://www.w3.org/ns/auth/acl#';
const rdfType = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const doc = 'https://x.example/alice/room/.acr';
const other = 'https://x.example/alice/other.acr';
const resource = 'https://x.example/alice/room/';
const acr = n(`${doc}#acr`);
const access = n(`${doc}#access`);
const policy = n(`${doc}#policy`);
const matcher = n(`${doc}#matcher`);
const agent = n('https://x.example/profile/card#me');
const shell = (): Quad[] => [
  q(acr, n(rdfType), n(`${acp}AccessControlResource`), n(doc)),
  q(acr, n(`${acp}resource`), n(resource), n(doc)),
];
const full = (): Quad[] => [
  ...shell(),
  q(acr, n(`${acp}accessControl`), access, n(doc)),
  q(access, n(rdfType), n(`${acp}AccessControl`), n(doc)), q(access, n(`${acp}apply`), policy, n(doc)),
  q(policy, n(rdfType), n(`${acp}Policy`), n(doc)), q(policy, n(`${acp}allow`), n(`${acl}Read`), n(doc)),
  q(policy, n(`${acp}anyOf`), matcher, n(doc)),
  q(matcher, n(rdfType), n(`${acp}Matcher`), n(doc)), q(matcher, n(`${acp}agent`), agent, n(doc)),
];

describe('ACP ground policy shell prerequisite (pure)', () => {
  it('admits the exact typed resource-associated ACR shell with no access-control links', () => {
    expect(() => assertGroundAcpPolicy(doc, resource, shell())).not.toThrow();
    // The same shell can also carry inert same-document metadata.
    expect(() => assertGroundAcpPolicy(doc, resource,
      [ ...shell(), q(acr, n('http://purl.org/dc/terms/title'), DataFactory.literal('room'), n(doc)) ])).not.toThrow();
  });

  it('still rejects a shell that is not exactly one same-document resource-associated ACR', () => {
    expect(() => assertGroundAcpPolicy(doc, 'https://x.example/alice/elsewhere/', shell())).toThrow();
    expect(() => assertGroundAcpPolicy(doc, resource, shell().slice(0, 1))).toThrow();
    expect(() => assertGroundAcpPolicy(doc, resource,
      [ ...shell(), q(n(`${doc}#second`), n(`${acp}resource`), n(resource), n(doc)),
        q(n(`${doc}#second`), n(rdfType), n(`${acp}AccessControlResource`), n(doc)) ])).toThrow();
    expect(() => assertGroundAcpPolicy(doc, resource,
      shell().map(value => q(value.subject, value.predicate, value.object, n(other))))).toThrow();
    expect(() => assertGroundAcpPolicy(doc, resource,
      shell().filter(value => !value.predicate.equals(n(rdfType))))).toThrow();
  });

  it('still rejects unsupported ACP predicates on the shell while digesting inert ground metadata', () => {
    expect(() => assertGroundAcpPolicy(doc, resource,
      [ ...shell(), q(acr, n(`${acp}applyMembers`), n(`${doc}#x`), n(doc)) ])).toThrow();
    expect(() => assertGroundAcpPolicy(doc, resource,
      [ ...shell(), q(acr, n(`${acp}owner`), agent, n(doc)) ])).toThrow();
    // A non-ACP predicate is inert same-document metadata (existing behavior), not an ACP semantic.
    expect(() => assertGroundAcpPolicy(doc, resource,
      [ ...shell(), q(acr, n('urn:unknown'), DataFactory.literal('inert'), n(doc)) ])).not.toThrow();
  });

  it('still rejects orphaned semantic nodes that are not reachable from the single ACR', () => {
    const orphaned = [
      ...shell(),
      q(policy, n(rdfType), n(`${acp}Policy`), n(doc)), q(policy, n(`${acp}allow`), n(`${acl}Read`), n(doc)),
      q(policy, n(`${acp}anyOf`), matcher, n(doc)),
      q(matcher, n(rdfType), n(`${acp}Matcher`), n(doc)), q(matcher, n(`${acp}agent`), agent, n(doc)),
    ];
    expect(() => assertGroundAcpPolicy(doc, resource, orphaned)).toThrow();
  });

  it('keeps existing link/policy/matcher validation when access-control links are present', () => {
    expect(() => assertGroundAcpPolicy(doc, resource, full())).not.toThrow();
    expect(() => assertGroundAcpPolicy(doc, resource,
      full().map(value => value.predicate.equals(n(`${acp}agent`)) ? q(matcher, n(`${acp}agentClass`), n(`${acp}PublicAgent`)) : value))).toThrow();
    expect(() => assertGroundAcpPolicy(doc, resource,
      full().map(value => value.predicate.equals(n(`${acp}agent`)) ? q(matcher, n(`${acp}client`), n(`${acp}PublicClient`)) : value))).toThrow();
    expect(() => assertGroundAcpPolicy(doc, resource,
      full().map(value => value.predicate.equals(n(`${acp}allow`)) ? q(value.subject, n(`${acp}allow`), n(`${acp}Read`)) : value))).toThrow();
    expect(() => assertGroundAcpPolicy(doc, resource,
      full().filter(value => !(value.subject.equals(access) && value.predicate.equals(n(`${acp}apply`)))))).toThrow();
  });
});
