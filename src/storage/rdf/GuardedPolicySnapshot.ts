import { createHash } from 'node:crypto';
import type { Quad, Term } from '@rdfjs/types';

export const GUARDED_SPARQL_MEDIA_TYPE = 'application/vnd.xpod.guarded-sparql-update+json';
export type GuardedPolicyProfile = 'wac-ground-v1' | 'acp-ground-v1';
export type GuardedPolicyKind = 'wac' | 'acp';
export const GUARDED_POLICY_PROFILE_KIND: Readonly<Record<GuardedPolicyProfile, GuardedPolicyKind>> =
  Object.freeze({ 'wac-ground-v1': 'wac', 'acp-ground-v1': 'acp' });
export interface GuardedPolicyResource { iri: string; container: boolean; children: string[]; policyIri: string }
export interface GuardedPolicyEntry { iri: string; kind: GuardedPolicyKind; state: 'present' | 'present-empty' | 'absent404'; digest: string | null }
export interface GuardedPolicySnapshot {
  profile: GuardedPolicyProfile; scope: string;
  resources: GuardedPolicyResource[];
  ancestors: { iri: string; policyIri: string }[];
  policies: GuardedPolicyEntry[];
}
export interface GuardedPolicyUpdate { version: 1; update: string; guard: GuardedPolicySnapshot }

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new Error('Malformed guarded policy record');
  }
  return value as Record<string, unknown>;
}
export function guardedPolicyIri(value: unknown): string {
  if (typeof value !== 'string' || value.trim() !== value || /%(?:2e|2f|5c|25)/iu.test(value) || /\\/u.test(value)) {
    throw new Error('Unsupported guarded policy IRI');
  }
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search || url.href !== value) {
    throw new Error('Unsupported guarded policy IRI');
  }
  return value;
}
function list<T>(value: unknown, parse: (value: unknown) => T, key: (value: T) => string, limit: number): T[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error('Unsupported guarded policy inventory');
  const result = value.map(parse);
  if (new Set(result.map(key)).size !== result.length) throw new Error('Duplicate guarded policy inventory');
  return result;
}
/**
 * The ONE closed guard-only validator, shared byte-for-byte by the guarded update envelope and the
 * A1 observation response. It never inspects a surrounding envelope (version/update/read rows); it
 * validates only the exact `{profile,scope,resources,ancestors,policies}` shape with the single shared
 * `record`/`list` limits and term rules, so there is no second/drifting guard validator.
 */
export function parseGuardedPolicySnapshot(value: unknown): GuardedPolicySnapshot {
  const guard = record(value, ['profile', 'scope', 'resources', 'ancestors', 'policies']);
  if (guard.profile !== 'wac-ground-v1' && guard.profile !== 'acp-ground-v1') throw new Error('Unsupported guarded policy profile');
  const expectedKind = GUARDED_POLICY_PROFILE_KIND[guard.profile];
  const resources = list(guard.resources, input => {
    const row = record(input, ['iri', 'container', 'children', 'policyIri']);
    if (typeof row.container !== 'boolean') throw new Error('Malformed resource kind');
    const children = list(row.children, guardedPolicyIri, iri => iri, 256);
    if (!row.container && children.length) throw new Error('Non-container has children');
    return { iri: guardedPolicyIri(row.iri), container: row.container, children, policyIri: guardedPolicyIri(row.policyIri) };
  }, row => row.iri, 256);
  const ancestors = list(guard.ancestors, input => {
    const row = record(input, ['iri', 'policyIri']);
    return { iri: guardedPolicyIri(row.iri), policyIri: guardedPolicyIri(row.policyIri) };
  }, row => row.iri, 32);
  const policies = list(guard.policies, input => {
    const row = record(input, ['iri', 'kind', 'state', 'digest']);
    // The envelope profile and every policy kind must agree; a guard cannot pick another engine.
    if (row.kind !== expectedKind || typeof row.state !== 'string' || !['present', 'present-empty', 'absent404'].includes(String(row.state))
      || (row.state === 'absent404' ? row.digest !== null : typeof row.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(row.digest))) {
      throw new Error('Malformed policy state');
    }
    return { iri: guardedPolicyIri(row.iri), kind: row.kind as GuardedPolicyKind,
      state: row.state as GuardedPolicyEntry['state'], digest: row.digest as string | null };
  }, row => row.iri, 512);
  if (!resources.length) throw new Error('Empty guarded resource scope');
  return { profile: guard.profile, scope: guardedPolicyIri(guard.scope), resources, ancestors, policies };
}
export function parseGuardedPolicyUpdate(value: unknown): GuardedPolicyUpdate {
  const envelope = record(value, ['version', 'update', 'guard']);
  if (envelope.version !== 1 || typeof envelope.update !== 'string' || !envelope.update.trim()) throw new Error('Unsupported guarded update version');
  return { version: 1, update: envelope.update, guard: parseGuardedPolicySnapshot(envelope.guard) };
}
function termTuple(term: Term, literal: boolean): string[] {
  if (term.termType === 'NamedNode') return ['NamedNode', term.value];
  if (literal && term.termType === 'Literal') return ['Literal', term.value, term.datatype.value, term.language.toLowerCase()];
  throw new Error('Only ground named-node/literal RDF is supported');
}
/** One lexical tuple representation is shared by digesting and bounded byte accounting. */
export function groundPolicyTripleTuple(quad: Quad): string[][] {
  return [termTuple(quad.subject, false), termTuple(quad.predicate, false), termTuple(quad.object, true)];
}
/**
 * The ONE shared ground-tuple set path: only default-graph or exact-document named-graph quads, each
 * reduced through {@link groundPolicyTripleTuple}, deduplicated by lexical tuple and sorted bytewise.
 * Digesting and bounded byte accounting both reuse this so a second term serializer cannot drift.
 */
function sortedGroundTuples(documentIri: string, quads: readonly Quad[]): string[][][] {
  const tuples = new Map<string, string[][]>();
  for (const quad of quads) {
    if (quad.graph.termType !== 'DefaultGraph' && !(quad.graph.termType === 'NamedNode' && quad.graph.value === documentIri)) {
      throw new Error('Foreign policy graph');
    }
    const tuple = groundPolicyTripleTuple(quad);
    tuples.set(JSON.stringify(tuple), tuple);
  }
  const sortedKeys = [ ...tuples.keys() ].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return sortedKeys.map(key => tuples.get(key)!);
}

export function digestGroundPolicy(documentIri: string, kind: GuardedPolicyKind, quads: readonly Quad[]): string {
  guardedPolicyIri(documentIri);
  if (kind !== 'wac' && kind !== 'acp') throw new Error('Unsupported ground policy kind');
  const sorted = sortedGroundTuples(documentIri, quads);
  return createHash('sha256').update(JSON.stringify(['ground-RDF-v1', documentIri, kind, sorted]), 'utf8').digest('hex');
}

export const GROUND_SOURCE_DIGEST_PROFILE = 'ground-source-v1';

/**
 * Full ground source digest. Domain keeps the FULL source IRI (including any fragment) and the
 * physical document IRI, so two fragments sharing one physical document are distinct identities.
 * Only complete sorted-unique ground triples of the physical document are hashed: named-node/literal
 * terms preserve lexical form, datatype and language; blank/RDF-star/foreign-graph input is refused.
 */
export function digestGroundSource(fullSourceIri: string, physicalDocumentIri: string, quads: readonly Quad[]): string {
  guardedPolicyIri(physicalDocumentIri);
  if (fullSourceIri.slice(0, fullSourceIri.indexOf('#') < 0 ? fullSourceIri.length : fullSourceIri.indexOf('#')) !== physicalDocumentIri) {
    throw new Error('Source fragment is not on the physical document');
  }
  const sorted = sortedGroundTuples(physicalDocumentIri, quads);
  return createHash('sha256')
    .update(JSON.stringify([GROUND_SOURCE_DIGEST_PROFILE, fullSourceIri, physicalDocumentIri, sorted]), 'utf8')
    .digest('hex');
}
export function sameGuardedPolicySnapshot(a: GuardedPolicySnapshot, b: GuardedPolicySnapshot): boolean {
  const sort = <T extends { iri: string }>(rows: T[]): T[] => [...rows].sort((x, y) => x.iri.localeCompare(y.iri));
  const normalize = (snapshot: GuardedPolicySnapshot) => ({ ...snapshot,
    resources: sort(snapshot.resources).map(row => ({ ...row, children: [...row.children].sort() })),
    ancestors: sort(snapshot.ancestors), policies: sort(snapshot.policies) });
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

/** Supported profile validation is shared by server closure and client evidence compilation. */
export function assertGroundWacPolicy(quads: readonly Quad[]): void {
  const acl = 'http://www.w3.org/ns/auth/acl#';
  const acp = 'http://www.w3.org/ns/solid/acp#';
  for (const quad of quads) {
    groundPolicyTripleTuple(quad);
    if (quad.predicate.value.startsWith(acp) || quad.object.value.startsWith(acp)) throw new Error('ACP is unsupported in ground WAC profile');
    if (quad.predicate.value.startsWith(acl)) {
      const predicate = quad.predicate.value.slice(acl.length);
      if (!['agent', 'agentClass', 'accessTo', 'default', 'mode'].includes(predicate)
        || quad.object.termType !== 'NamedNode'
        || (predicate === 'agentClass' && quad.object.value !== 'http://xmlns.com/foaf/0.1/Agent')
        || (predicate === 'mode' && !['Read', 'Write', 'Append', 'Control'].some(mode => quad.object.value === acl + mode))) {
        throw new Error('Unsupported WAC matcher or policy extension');
      }
    }
    if (quad.predicate.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' && quad.object.value !== acl + 'Authorization') {
      throw new Error('Unsupported WAC policy class');
    }
  }
}
export function groundPolicyQuadBytes(quad: Quad): number {
  return Buffer.byteLength(JSON.stringify(groundPolicyTripleTuple(quad)), 'utf8');
}

const ACP = 'http://www.w3.org/ns/solid/acp#';
const ACL_NS = 'http://www.w3.org/ns/auth/acl#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
// The installed public ACP engine reads `allow`/`deny` as mode IRIs; the actual CSS/AclPermissionsEngine
// and advertised header use the ACL mode vocabulary (acl:Read/Write/Append/Control), not acp: modes.
const ACP_MODE_VALUES = new Set([ 'Read', 'Write', 'Append', 'Control' ].map(mode => ACL_NS + mode));
// Only the concrete full-WebID criterion and the two installed special agents are admitted. The public
// engine also evaluates client/issuer/vc and Owner/Creator agents, but those are outside the supported
// ground intersection and are refused before any effect.
const ACP_SPECIAL_AGENTS = new Set([ `${ACP}PublicAgent`, `${ACP}AuthenticatedAgent` ]);
const ACP_CLASSES = new Set([ 'AccessControlResource', 'AccessControl', 'Policy', 'Matcher' ]);
// The complete supported ACP predicate surface. `applyMembers`, `agentClass`, `agentGroup`,
// `client`/`issuer`/`vc`/`owner`/`creator`, report/grant/attribute terms and any unknown ACP term are
// deliberately absent and therefore rejected.
const ACP_ACR_PREDICATES = new Set([ 'resource', 'accessControl', 'memberAccessControl' ]);
const ACP_ACCESS_PREDICATES = new Set([ 'apply' ]);
const ACP_POLICY_PREDICATES = new Set([ 'allow', 'deny', 'anyOf', 'allOf', 'noneOf' ]);
const ACP_MATCHER_PREDICATES = new Set([ 'agent' ]);
const ACP_ALL_PREDICATES = new Set([
  ...ACP_ACR_PREDICATES, ...ACP_ACCESS_PREDICATES, ...ACP_POLICY_PREDICATES, ...ACP_MATCHER_PREDICATES,
]);

/**
 * Strict same-document ACP shape validation for the `acp-ground-v1` profile. Every semantic subject
 * must be a ground NamedNode defined in this exact document (`documentIri` or a `#fragment` of it)
 * and typed exactly as its required ACP class; every structural object is a locally defined NamedNode;
 * every ACR -> AccessControl -> Policy -> Matcher reference resolves to such a definition; exactly one
 * resource-associated ACR exists; only the supported agent matcher criterion is admitted. Anything
 * outside the supported intersection (applyMembers, agentClass/agentGroup, client/issuer/VC/Owner/
 * Creator attributes, Literal agents, unknown ACP predicates, cross-document or stray/untyped nodes)
 * is refused BEFORE any snapshot/native effect. The installed public engine discovers ACRs through
 * the `acp:resource` predicate regardless of rdf:type, so resource-associated as well as typed padding
 * is refused. Indexed once; O(nodes+edges), never a per-check full scan.
 */
export function assertGroundAcpPolicy(documentIri: string, resourceIri: string, quads: readonly Quad[]): void {
  const document = guardedPolicyIri(documentIri).split('#')[0];
  guardedPolicyIri(resourceIri);
  // An exact empty RDF set is a supported `present-empty` policy, distinct from an absent (404)
  // policy, and it continues inherited policy evaluation. There is no ACR/AccessControl/Policy/
  // Matcher structure to validate, so it is admitted only after canonical document/resource inputs
  // are proved. Every nonempty graph still runs the strict same-document shape validation below.
  if (!quads.length) return;
  const local = (value: string): boolean => {
    if (value === document) return true;
    if (!value.startsWith(`${document}#`) || value.length <= document.length + 1) return false;
    return value.indexOf('#', document.length + 1) === -1;
  };
  // Single indexed pass: subject -> predicate -> objects, subject -> declared ACP classes, and the
  // set of semantic subjects. No later check rescans the quad array or a shared definition.
  const bySubject = new Map<string, Map<string, string[]>>();
  const types = new Map<string, Set<string>>();
  const semanticSubjects = new Set<string>();
  const addObject = (subject: string, predicate: string, object: string): void => {
    const predicates = bySubject.get(subject) ?? new Map<string, string[]>();
    const objects = predicates.get(predicate) ?? [];
    objects.push(object);
    predicates.set(predicate, objects);
    bySubject.set(subject, predicates);
  };
  const seen = new Set<string>();
  for (const quad of quads) {
    const tuple = groundPolicyTripleTuple(quad);
    if (quad.subject.termType !== 'NamedNode' || quad.predicate.termType !== 'NamedNode') {
      throw new Error('ACP only supports ground named-node subjects and predicates');
    }
    if (quad.graph.termType !== 'DefaultGraph' && !(quad.graph.termType === 'NamedNode' && quad.graph.value === documentIri)) {
      throw new Error('Foreign ACP policy graph');
    }
    // Exact duplicate ground triples are the same RDF set. The ONE shared lexical tuple path (already
    // graph-validated above) deduplicates them before the strict role/value counts below, preserving
    // lexical form, datatype, language and graph constraints; distinct malformed policies still count.
    const key = JSON.stringify(tuple);
    if (seen.has(key)) continue;
    seen.add(key);
    const subject = quad.subject.value;
    if (!local(subject)) throw new Error('ACP definition is not in this document');
    const predicate = quad.predicate.value;
    if (predicate.startsWith(ACP)) {
      const term = predicate.slice(ACP.length);
      if (!ACP_ALL_PREDICATES.has(term)) throw new Error('Unsupported ACP predicate');
      if (quad.object.termType !== 'NamedNode') throw new Error('ACP object must be a ground named node');
      semanticSubjects.add(subject);
      addObject(subject, predicate, quad.object.value);
    } else if (predicate === RDF_TYPE) {
      const object = quad.object.value;
      const suffix = quad.object.termType === 'NamedNode' && object.startsWith(ACP) ? object.slice(ACP.length) : undefined;
      if (suffix === undefined || !ACP_CLASSES.has(suffix)) throw new Error('Unsupported ACP class');
      semanticSubjects.add(subject);
      const declared = types.get(subject) ?? new Set<string>();
      declared.add(suffix);
      types.set(subject, declared);
    } else {
      // Inert ground metadata: digested with the document but never evaluated as ACP semantics.
      addObject(subject, predicate, quad.object.value);
    }
  }
  if (bySubject.size > 65536) throw new Error('ACP policy exceeds the supported structure budget');
  const objectsOf = (subject: string, predicate: string): string[] => bySubject.get(subject)?.get(predicate) ?? [];
  const typesOf = (subject: string): Set<string> => types.get(subject) ?? new Set<string>();
  // The public engine discovers every ACR through its `acp:resource` predicate regardless of rdf:type.
  const acrs = [ ...bySubject.keys() ].filter(subject => bySubject.get(subject)?.has(`${ACP}resource`) ?? false);
  if (acrs.length !== 1) throw new Error('ACP policy must define exactly one resource-associated AccessControlResource');
  const acr = acrs[0];
  const associated = objectsOf(acr, `${ACP}resource`);
  if (associated.length !== 1 || associated[0] !== resourceIri) throw new Error('ACP ACR must associate the exact resource');
  const roles = new Map<string, string>();
  const enter = (iri: string, role: string): boolean => {
    const previous = roles.get(iri);
    if (previous !== undefined) {
      if (previous !== role) throw new Error('ACP node is used in incompatible roles');
      return false;
    }
    roles.set(iri, role);
    if (roles.size > 4096) throw new Error('ACP policy exceeds the supported structure budget');
    return true;
  };
  const requireRole = (iri: string, role: string, allowed: ReadonlySet<string>): void => {
    const predicates = bySubject.get(iri);
    if (!predicates) throw new Error(`ACP ${role} is not defined in this document`);
    for (const predicate of predicates.keys()) {
      if (predicate.startsWith(ACP) && !allowed.has(predicate.slice(ACP.length))) {
        throw new Error(`Unsupported ACP predicate on ${role}`);
      }
    }
    const declared = typesOf(iri);
    if (declared.size !== 1 || !declared.has(role)) throw new Error(`ACP ${role} must be typed exactly as ${role}`);
  };
  const validateMatcher = (iri: string, depth: number): void => {
    if (depth > 16) throw new Error('ACP definition depth exceeded');
    if (!enter(iri, 'Matcher')) return;
    requireRole(iri, 'Matcher', ACP_MATCHER_PREDICATES);
    const agents = objectsOf(iri, `${ACP}agent`);
    if (!agents.length) throw new Error('ACP matcher has no supported agent criterion');
    for (const agent of agents) {
      if (ACP_SPECIAL_AGENTS.has(agent)) continue;
      // A full HTTP(S) WebID is admitted; any ACP-namespace value is not a concrete agent.
      if (!/^https?:\/\//u.test(agent) || agent.startsWith(ACP)) throw new Error('Unsupported ACP agent matcher value');
    }
  };
  const validatePolicy = (iri: string, depth: number): void => {
    if (depth > 16) throw new Error('ACP definition depth exceeded');
    if (!enter(iri, 'Policy')) return;
    requireRole(iri, 'Policy', ACP_POLICY_PREDICATES);
    for (const mode of [ ...objectsOf(iri, `${ACP}allow`), ...objectsOf(iri, `${ACP}deny`) ]) {
      if (!ACP_MODE_VALUES.has(mode)) throw new Error('Unsupported ACP allow/deny mode');
    }
    const anyOf = objectsOf(iri, `${ACP}anyOf`);
    if (!anyOf.length) throw new Error('Unsupported ACP policy structural profile');
    for (const matcher of [ ...anyOf, ...objectsOf(iri, `${ACP}allOf`), ...objectsOf(iri, `${ACP}noneOf`) ]) {
      validateMatcher(matcher, depth + 1);
    }
  };
  const validateAccess = (iri: string, depth: number): void => {
    if (depth > 16) throw new Error('ACP definition depth exceeded');
    if (!enter(iri, 'AccessControl')) return;
    requireRole(iri, 'AccessControl', ACP_ACCESS_PREDICATES);
    const applies = objectsOf(iri, `${ACP}apply`);
    if (!applies.length) throw new Error('ACP access has no apply');
    for (const policy of applies) validatePolicy(policy, depth + 1);
  };
  enter(acr, 'AccessControlResource');
  requireRole(acr, 'AccessControlResource', ACP_ACR_PREDICATES);
  // A strictly-typed, same-document, exact-resource-associated ACR may legitimately carry ZERO
  // access-control links: the maintained engine then contributes no local policy and evaluation
  // continues through ancestor `memberAccessControl` (inherited-only behavior). This is NOT an
  // early return: the exact type/predicate/resource checks above still ran, and the reachability pass
  // below still rejects any orphaned/untyped/stray semantic node. When links DO exist they are
  // validated unchanged (no controls/policies/matchers are relaxed).
  const controls = [ ...objectsOf(acr, `${ACP}accessControl`), ...objectsOf(acr, `${ACP}memberAccessControl`) ];
  for (const control of controls) validateAccess(control, 1);
  // Every ACP-typed or ACP-predicated node must be part of the single validated graph. This refuses an
  // untyped/stray second ACR or orphaned definition the public engine would otherwise read.
  for (const subject of semanticSubjects) {
    if (!roles.has(subject)) throw new Error('ACP semantic node is not reachable from the single AccessControlResource');
  }
}
