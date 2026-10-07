import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { parseLinkHeader } from '@solid/community-server';
import { DataFactory, Parser, Store, type Quad } from 'n3';
import { AgentAccessChecker, AgentClassAccessChecker, ACL as WacVocabulary, ManagedWacRepository,
  UnionAccessChecker, WacPolicyEngine, type AuthorizationManager } from '@solidlab/policy-engine';
import { copyImmutableCanonicalRoomSnapshot, type CanonicalRoomSnapshot,
  type MembershipAuthorityBinding } from './canonicalRoomSource';
import type { CanonicalRoomChanges } from './canonicalRoomCas';
import { canonicalSourceFenceSparql } from './canonicalSourceFence';
import { assertGroundAcpPolicy, assertGroundWacPolicy, digestGroundPolicy, digestGroundSource, groundPolicyQuadBytes, guardedPolicyIri,
  parseGuardedPolicyUpdate, type GuardedPolicyResource, type GuardedPolicySnapshot } from '../../storage/rdf/GuardedPolicySnapshot';
import { grantAuthorizationIri, type MembershipReadGrant } from './membershipReadGrant';
import { MatrixError } from './MatrixError';
import type { MatrixStoreContext } from './types';
import { openMembershipObservationAccess, executeObservationGuard, executeObservationPolicyUpdate,
  negotiateMembershipAccess, observeMembershipAccess, recheckObservationAuthority,
  assertMembershipOperationState, snapshotRoles, isMembershipWebId,
  type MembershipSourceAccessOptions, type MembershipObservationAccess,
  type MembershipProtocolProbeLimits } from './membershipSourceAccess';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const LDP = 'http://www.w3.org/ns/ldp#';
const ACL = 'http://www.w3.org/ns/auth/acl#';
const ACP = 'http://www.w3.org/ns/solid/acp#';
const ACP_REFERENCES = new Set(['accessControl', 'memberAccessControl', 'apply', 'applyMembers', 'allOf', 'anyOf', 'noneOf']);
const ACL_FIELDS = new Set(['accessTo', 'default', 'defaultForNew', 'agent', 'agentClass', 'agentGroup', 'mode', 'origin', 'owner']);
const ACP_FIELDS = new Set([...ACP_REFERENCES, 'resource', 'allow', 'deny', 'agent', 'client', 'issuer', 'vc', 'creator', 'owner']);
export type MembershipPolicyState = 'present' | 'present-empty' | 'absent404' | 'unknown';
export interface MembershipObservedPolicy {
  readonly iri: string;
  readonly state: MembershipPolicyState;
  readonly kind: 'wac' | 'acp' | 'unknown';
  readonly quads: readonly Quad[];
  readonly discoveredFrom: readonly string[];
}
export interface MembershipObservedResource {
  readonly iri: string;
  readonly container: boolean;
  readonly children: readonly string[];
  readonly policyIri?: string;
  readonly policyState: MembershipPolicyState;
  readonly wacInheritance?: 'direct' | 'ancestor' | 'unresolved';
}
export interface MembershipPolicyObservation {
  readonly scope: Readonly<{ sourceIri: string; sourceRoot: string; roomContainer: string; actorWebId: string; kind: 'join' | 'leave' }>;
  readonly coverage: 'complete' | 'incomplete';
  readonly effectiveRead: 'not-proved';
  readonly policies: readonly MembershipObservedPolicy[];
  readonly resources: readonly MembershipObservedResource[];
  readonly dependencies: readonly string[];
  readonly issues: readonly Readonly<{ code: string; resource: string }>[];
  /**
   * Honest observer resource/protocol probe count: HEAD/GET traversal plus the actual negotiation and
   * A1 observation POSTs. It explicitly excludes resolver/setup and sealed canonical bookend reads (and
   * is therefore NOT a claim of all physical network requests).
   */
  readonly counts: Readonly<{ requests: number; bytes: number; resources: number }>;
}
/** One ordinary room resource's actual ACP (agent-only) Read decision. Never WAC provenance. */
export interface MembershipAcpResourceRead { readonly iri: string; readonly container: boolean; readonly read: boolean }
/**
 * Tagged ACP observation. Keeps the same completeness-facing fields as the WAC observation so a
 * consumer cannot read an ACP absence as success, plus the qualified source-bound server guard.
 */
export interface MembershipAcpObservation {
  readonly profile: 'acp-observation-v1';
  readonly scope: MembershipPolicyObservation['scope'];
  readonly coverage: 'complete' | 'incomplete';
  readonly effectiveRead: 'not-proved';
  readonly requesterWebId: string;
  readonly targetWebId: string;
  readonly sourceIri: string;
  readonly sourceDigest: string;
  readonly guard: GuardedPolicySnapshot;
  readonly resources: readonly MembershipAcpResourceRead[];
  readonly issues: readonly Readonly<{ code: string; resource: string }>[];
  readonly counts: Readonly<{ requests: number; bytes: number; resources: number }>;
}
export type MembershipRoomObservation = MembershipPolicyObservation | MembershipAcpObservation;
/** Narrow a room observation to its tagged ACP branch; WAC observations carry no `profile` tag. */
export const isMembershipAcpObservation = (value: MembershipRoomObservation): value is MembershipAcpObservation =>
  'profile' in value && (value as MembershipAcpObservation).profile === 'acp-observation-v1';
const isAcpObservation = isMembershipAcpObservation;
export interface MembershipObservationLimits {
  requests: number; bytes: number; resources: number; depth: number; requestTimeoutMs: number; totalTimeoutMs: number;
}
export interface MembershipPolicyObserverOptions extends MembershipSourceAccessOptions {
  limits?: Partial<MembershipObservationLimits>;
}
const DEFAULT_LIMITS: MembershipObservationLimits = {
  requests: 512, bytes: 8 * 1024 * 1024, resources: 256, depth: 32, requestTimeoutMs: 5000, totalTimeoutMs: 60000,
};
class ObservationFailure extends Error {
  public constructor(public readonly code: string) { super(code); }
}
/**
 * Strict client-side ACP inventory validator over the parsed server guard. The physical source must be
 * an ordinary member; the inventory must be a connected tree rooted at the exact room scope with
 * direct-child topology and no extras/duplicates; every resource/ancestor policy reference must
 * resolve; the ancestors must be one contiguous parent chain. The terminal server-root closure is the
 * qualified network producer's guarantee, not inferred here from origin/issuer/suffix (so this
 * validator never guesses a root and never rejects a valid path-rooted deployment).
 */
function assertAcpInventory(guard: GuardedPolicySnapshot, scope: string, physicalDocument: string): void {
  if (guard.profile !== 'acp-ground-v1' || guard.scope !== scope) throw new Error('unsupported ACP guard scope');
  const byIri = new Map<string, GuardedPolicyResource>();
  for (const resource of guard.resources) {
    if (byIri.has(resource.iri) || resource.container !== resource.iri.endsWith('/') || !resource.iri.startsWith(scope)) {
      throw new Error('unsupported ACP inventory topology');
    }
    byIri.set(resource.iri, resource);
  }
  if (byIri.get(scope)?.container !== true || !byIri.has(physicalDocument)) throw new Error('unsupported ACP inventory members');
  const childOf = new Map<string, string>();
  for (const resource of guard.resources) {
    const seen = new Set<string>();
    for (const child of resource.children) {
      const relative = child.startsWith(resource.iri) ? child.slice(resource.iri.length) : '';
      if (seen.has(child) || !relative || relative.replace(/\/$/u, '').includes('/') || !byIri.has(child) || childOf.has(child)) {
        throw new Error('unsupported ACP child topology');
      }
      seen.add(child); childOf.set(child, resource.iri);
    }
  }
  for (const resource of guard.resources) {
    if (resource.iri !== scope && !childOf.has(resource.iri)) throw new Error('disconnected ACP member');
  }
  const policyIris = new Set<string>();
  for (const policy of guard.policies) {
    if (policyIris.has(policy.iri)) throw new Error('duplicate ACP policy'); policyIris.add(policy.iri);
  }
  for (const resource of guard.resources) if (!policyIris.has(resource.policyIri)) throw new Error('missing ACP resource policy');
  const ancestors = [ ...guard.ancestors ].sort((a, b) => b.iri.length - a.iri.length);
  let child = scope;
  for (const ancestor of ancestors) {
    if (!ancestor.iri.endsWith('/') || !policyIris.has(ancestor.policyIri) || ancestor.iri !== new URL('../', child).href) {
      throw new Error('unsupported ACP ancestor chain');
    }
    child = ancestor.iri;
  }
}
interface ObservationContext {
  readonly access: MembershipObservationAccess;
  readonly initial: ReturnType<typeof copyImmutableCanonicalRoomSnapshot>;
  readonly timeoutMs: number;
  readonly profile: 'wac-ground-v1' | 'acp-ground-v1';
  /** ACP only: the qualified server guard plus its truthful source provenance. */
  readonly guard?: GuardedPolicySnapshot;
  readonly sourceDigest?: string;
  readonly requesterWebId?: string;
  readonly targetWebId?: string;
  /** Trusted per-physical-request bound for the asynchronous Read bookend. */
  readonly requestTimeoutMs: number;
  /** Trusted monotonic expiry from the successful complete observation; no renewal on use. */
  readonly expiresAtNs: bigint;
}
const observationContexts = new WeakMap<object, Readonly<ObservationContext>>();
const GUARD_TTL_NS = 5000n * 1000000n;
const trustedNow = (): bigint => process.hrtime.bigint();
/**
 * TTL is min(remaining total deadline, internal 5000ms) measured from the successful complete
 * observation. The total deadline starts BEFORE access setup, so sealing never grants a fresh
 * lifetime: an observation that consumed its total budget expires immediately.
 */
const sealExpiry = (totalDeadlineNs: bigint): bigint => {
  const now = trustedNow();
  const remaining = totalDeadlineNs - now;
  const bound = remaining < GUARD_TTL_NS ? remaining : GUARD_TTL_NS;
  return now + (bound > 0n ? bound : 0n);
};
function assertObservationFresh(opened: { readonly expiresAtNs: bigint }): void {
  if (trustedNow() > opened.expiresAtNs) throw new MatrixError(409, 'M_CONFLICT', 'Sealed observation evidence has expired');
}
/** HTTP-time observations only. No evaluator, topology commit token, ACL write or phase mark. */
export class MembershipPolicyObserver {
  private readonly limits: MembershipObservationLimits;
  public constructor(private readonly options: MembershipPolicyObserverOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    if (Object.values(this.limits).some(value => !Number.isSafeInteger(value) || value <= 0)) {
      throw new MatrixError(400, 'M_INVALID_PARAM', 'Observation limits must be positive safe integers');
    }
  }
  public async observe(roomId: string, incoming: MatrixStoreContext, kind: 'join' | 'leave'): Promise<MembershipRoomObservation> {
    if (kind !== 'join' && kind !== 'leave') throw new MatrixError(400, 'M_INVALID_PARAM', 'Unknown membership observation kind');
    const total = new AbortController();
    // Total elapsed starts BEFORE access setup; the sealed TTL derives from this same deadline.
    const totalDeadlineNs = trustedNow() + BigInt(this.limits.totalTimeoutMs) * 1000000n;
    const timer = setTimeout(() => total.abort(new ObservationFailure('total-deadline')), this.limits.totalTimeoutMs);
    try { return await this.observeWithin(roomId, incoming, kind, total, totalDeadlineNs); }
    catch (error) {
      if (total.signal.aborted) throw new MatrixError(503, 'M_UNAVAILABLE', 'Policy observation exceeded its total deadline');
      throw error;
    } finally { clearTimeout(timer); total.abort(); }
  }
  private async observeWithin(roomId: string, incoming: MatrixStoreContext, kind: 'join' | 'leave', total: AbortController, totalDeadlineNs: bigint)
    : Promise<MembershipRoomObservation> {
    const access = await openMembershipObservationAccess(this.options, roomId, incoming, kind, total.signal);
    const initial = access.initial;
    const { facts } = initial;
    const operation = facts.membershipOperation;
    if (operation && operation.phase !== 'complete') {
      assertMembershipOperationState(initial, operation.operationId, kind, access.actor, access.binding);
    } else if (kind === 'join') {
      if (facts.participants.includes(access.actor.webId) || Object.prototype.hasOwnProperty.call(snapshotRoles(initial) ?? {}, access.actor.webId)
        || !facts.membershipInvitations?.[access.actor.webId]) throw new MatrixError(403, 'M_FORBIDDEN', 'Current canonical invitation is required');
    } else if (!facts.participants.includes(access.actor.webId) || facts.authorWebId === access.actor.webId) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'Current non-author participant is required');
    }
    const counts = { requests: 0, bytes: 0, resources: 0 };
    const issues: Array<{ code: string; resource: string }> = [];
    const resources = new Map<string, MembershipObservedResource>();
    const policies = new Map<string, MembershipObservedPolicy>();
    const policyKinds = new Map<string, Set<'wac' | 'acp'>>();
    const headCache = new Map<string, { links: ReturnType<typeof parseLinkHeader>; state: MembershipPolicyState }>();
    let stopped = false;
    const seal = (result: MembershipPolicyObservation): MembershipPolicyObservation => {
      const immutable = Object.freeze({ ...result,
      scope: Object.freeze(result.scope), counts: Object.freeze(result.counts),
      issues: Object.freeze(result.issues.map(entry => Object.freeze(entry))),
      resources: Object.freeze(result.resources.map(entry => Object.freeze({ ...entry, children: Object.freeze([...entry.children]) }))),
      dependencies: Object.freeze([...result.dependencies]),
      policies: Object.freeze(result.policies.map(entry => Object.freeze({ ...entry,
        discoveredFrom: Object.freeze([...entry.discoveredFrom]),
        quads: copyImmutableCanonicalRoomSnapshot({ ...initial, quads: [...entry.quads] }).quads }))),
    });
      observationContexts.set(immutable, Object.freeze({ access, initial: copyImmutableCanonicalRoomSnapshot(initial),
        timeoutMs: Math.min(this.limits.totalTimeoutMs, 60000), profile: 'wac-ground-v1',
        requestTimeoutMs: this.limits.requestTimeoutMs, expiresAtNs: sealExpiry(totalDeadlineNs) }));
      return immutable;
    };
    const sealAcp = (result: Omit<MembershipAcpObservation, 'profile'>): MembershipAcpObservation => {
      const guard = Object.freeze({ ...result.guard,
        resources: Object.freeze(result.guard.resources.map(row => Object.freeze({ ...row, children: Object.freeze([...row.children]) }))),
        ancestors: Object.freeze(result.guard.ancestors.map(row => Object.freeze({ ...row }))),
        policies: Object.freeze(result.guard.policies.map(row => Object.freeze({ ...row }))) }) as unknown as GuardedPolicySnapshot;
      const immutable = Object.freeze({ profile: 'acp-observation-v1' as const, ...result,
        scope: Object.freeze(result.scope), counts: Object.freeze(result.counts),
        issues: Object.freeze(result.issues.map(entry => Object.freeze(entry))),
        resources: Object.freeze(result.resources.map(entry => Object.freeze({ ...entry }))),
        guard }) as MembershipAcpObservation;
      observationContexts.set(immutable, Object.freeze({ access, initial: copyImmutableCanonicalRoomSnapshot(initial),
        timeoutMs: Math.min(this.limits.totalTimeoutMs, 60000), profile: 'acp-ground-v1', guard: immutable.guard,
        sourceDigest: result.sourceDigest, requesterWebId: result.requesterWebId, targetWebId: result.targetWebId,
        requestTimeoutMs: this.limits.requestTimeoutMs, expiresAtNs: sealExpiry(totalDeadlineNs) }));
      return immutable;
    };
    const issue = (code: string, resource: string): void => { if (!issues.some(entry => entry.code === code && entry.resource === resource)) issues.push({ code, resource }); };
    const request = async(iri: string, method: 'HEAD' | 'GET'): Promise<{ links: ReturnType<typeof parseLinkHeader>; state: MembershipPolicyState; quads: readonly Quad[] }> => {
      if (stopped || total.signal.aborted) throw new ObservationFailure('observation-stopped');
      if (counts.requests >= this.limits.requests) { stopped = true; throw new ObservationFailure('request-budget'); }
      const controller = new AbortController();
      const abort = (): void => controller.abort(total.signal.reason);
      total.signal.addEventListener('abort', abort, { once: true });
      const deadline = setTimeout(() => controller.abort(new ObservationFailure('request-deadline')), this.limits.requestTimeoutMs);
      let response: Response | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        counts.requests++;
        response = await access.readResource(iri, method, controller.signal);
        if (response.redirected || response.url !== iri) throw new ObservationFailure('redirect-or-response-url');
        const links = parseLinkHeader(response.headers.get('link') ?? undefined);
        if (response.status === 404) return { links, state: 'absent404', quads: [] };
        if (response.status !== 200) throw new ObservationFailure(`http-${response.status}`);
        if (method === 'HEAD') return { links, state: 'present', quads: [] };
        if (!response.headers.get('content-type')?.split(';')[0].trim().match(/^(?:text\/turtle|application\/n-triples)$/iu)) {
          throw new ObservationFailure('unsupported-rdf-media');
        }
        let text = '';
        if (response.body) {
          reader = response.body.getReader();
          const decoder = new TextDecoder();
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            counts.bytes += chunk.value.byteLength;
            if (counts.bytes > this.limits.bytes) { stopped = true; controller.abort(); throw new ObservationFailure('byte-budget'); }
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
        }
        if (controller.signal.aborted) throw new ObservationFailure('request-deadline');
        let quads: Quad[];
        try { quads = new Parser({ baseIRI: iri, format: 'Turtle' }).parse(text); }
        catch { throw new ObservationFailure('malformed-rdf'); }
        return { links, state: quads.length ? 'present' : 'present-empty', quads };
      } catch (error) {
        const code = controller.signal.aborted ? 'request-deadline' : error instanceof ObservationFailure ? error.code : 'request-failed';
        if (controller.signal.aborted || total.signal.aborted || code.endsWith('budget')) stopped = true;
        throw new ObservationFailure(code);
      } finally {
        clearTimeout(deadline); total.signal.removeEventListener('abort', abort);
        if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        else if (response?.body) await response.body.cancel().catch(() => {});
      }
    };
    const head = async(iri: string) => {
      const hit = headCache.get(iri); if (hit) return hit;
      const result = await request(iri, 'HEAD'); headCache.set(iri, result); return result;
    };
    const policy = async(iri: string, from: string, expectedKind: MembershipObservedPolicy['kind'] = 'unknown', depth = 0): Promise<MembershipObservedPolicy> => {
      const kinds = policyKinds.get(iri) ?? new Set<'wac' | 'acp'>();
      policyKinds.set(iri, kinds);
      if (expectedKind !== 'unknown') kinds.add(expectedKind);
      const hit = policies.get(iri);
      if (hit) {
        if (hit.kind !== 'unknown') kinds.add(hit.kind);
        if (kinds.size > 1) issue('ambiguous-policy-kind', iri);
        const updated = { ...hit, kind: kinds.size === 1 ? [...kinds][0] : 'unknown' as const,
          discoveredFrom: [...new Set([...hit.discoveredFrom, from])] };
        policies.set(iri, updated); return updated;
      }
      if (depth > this.limits.depth) { issue('policy-depth-budget', iri); stopped = true; return { iri, kind: 'unknown', state: 'unknown', quads: [], discoveredFrom: [from] }; }
      let result: MembershipObservedPolicy;
      try {
        const representation = await request(iri, 'GET');
        const advertisedTypes = representation.links.filter(link => link.parameters.rel?.split(/\s+/u).includes('type'))
          .map(link => new URL(link.target, iri).href);
        const rdfAcp = representation.quads.some(q => q.predicate.value === `${RDF}type` && q.object.value === `${ACP}AccessControlResource`);
        const rdfWac = representation.quads.some(q => q.predicate.value.startsWith(ACL) || q.object.value === `${ACL}Authorization`);
        if (rdfAcp || advertisedTypes.includes(`${ACP}AccessControlResource`)) kinds.add('acp');
        if (rdfWac || advertisedTypes.includes(`${ACL}Authorization`)) kinds.add('wac');
        const kindValue = kinds.size === 1 ? [...kinds][0] : 'unknown';
        if (kinds.size > 1) issue('ambiguous-policy-kind', iri);
        if (representation.state !== 'absent404' && representation.state !== 'present-empty' && kindValue === 'unknown') issue('unknown-policy-kind', iri);
        result = { iri, state: representation.state, kind: kindValue, quads: representation.quads, discoveredFrom: [from] };
        policies.set(iri, result); // Visit before following references: document cycles cannot loop.
        for (const quad of representation.quads) {
          const predicate = quad.predicate.value;
          const known = predicate === `${RDF}type` || (predicate.startsWith(ACL) && ACL_FIELDS.has(predicate.slice(ACL.length)))
            || (predicate.startsWith(ACP) && ACP_FIELDS.has(predicate.slice(ACP.length)))
            || predicate === 'http://www.w3.org/2000/01/rdf-schema#label' || predicate === 'http://purl.org/dc/terms/title';
          if (!known) issue('unsupported-policy-extension', iri);
          if (predicate === `${ACL}agentGroup`) issue('unsupported-agent-group-dependency', iri);
          if (predicate.startsWith(ACP) && ACP_REFERENCES.has(predicate.slice(ACP.length)) && quad.object.termType !== 'NamedNode') {
            if (quad.object.termType !== 'BlankNode' || !representation.quads.some(q => q.subject.equals(quad.object))) issue('missing-policy-reference', iri);
          }
          if (predicate.startsWith(ACP) && ACP_REFERENCES.has(predicate.slice(ACP.length)) && quad.object.termType === 'NamedNode') {
            const reference = quad.object.value;
            const referenceDocument = reference.split('#')[0];
            // A local named node with no definition is not silently treated as an inline matcher.
            if (referenceDocument === iri) {
              if (!representation.quads.some(q => q.subject.termType === 'NamedNode' && q.subject.value === reference)) issue('missing-policy-reference', reference);
              continue;
            }
            try {
              const target = access.allowReference(iri, reference);
              const dependency = await policy(target, iri, 'acp', depth + 1);
              if (dependency.state === 'absent404' || dependency.state === 'unknown') issue('missing-policy-reference', reference);
            } catch { issue('unsupported-policy-reference', reference); }
          }
        }
      } catch (error) {
        issue(error instanceof ObservationFailure ? error.code : 'policy-read-failed', iri);
        result = { iri, state: 'unknown', kind: expectedKind, quads: [], discoveredFrom: [from] };
      }
      result = { ...result, discoveredFrom: [...new Set([...(policies.get(iri)?.discoveredFrom ?? []), ...result.discoveredFrom])] };
      policies.set(iri, result); return result;
    };
    const inspect = async(iri: string, container: boolean): Promise<MembershipObservedResource> => {
      const hit = resources.get(iri); if (hit) return hit;
      if (counts.resources >= this.limits.resources) { stopped = true; throw new ObservationFailure('resource-budget'); }
      counts.resources++;
      let record: MembershipObservedResource = { iri, container, children: [], policyState: 'unknown' };
      try {
        const response = await head(iri);
        if (response.state === 'absent404') { issue('resource-absent404', iri); resources.set(iri, record); return record; }
        const aclLinks = response.links.filter(link => link.parameters.rel?.split(/\s+/u).includes('acl'));
        if (aclLinks.length !== 1) throw new ObservationFailure(aclLinks.length ? 'ambiguous-policy-link' : 'missing-policy-link');
        let policyIri: string;
        const advertised = aclLinks[0].target;
        try { policyIri = access.allowPolicy(iri, advertised); }
        catch { throw new ObservationFailure('unsupported-policy-url'); }
        const types = response.links.filter(link => link.parameters.rel?.split(/\s+/u).includes('type')).map(link => new URL(link.target, iri).href);
        const advertisedKind = types.includes(`${ACP}AccessControlResource`) ? 'acp' : 'unknown';
        const observed = await policy(policyIri, iri, advertisedKind);
        record = { iri, container, children: [], policyIri, policyState: observed.state,
          ...((observed.kind === 'wac' && observed.state !== 'absent404')
            || (observed.kind !== 'acp' && observed.state === 'present-empty') ? { wacInheritance: 'direct' as const } : {}) };
      } catch (error) { issue(error instanceof ObservationFailure ? error.code : 'resource-read-failed', iri); }
      resources.set(iri, record); return record;
    };
    const list = async(iri: string, depth: number): Promise<void> => {
      if (depth > this.limits.depth) { issue('containment-depth-budget', iri); stopped = true; return; }
      await inspect(iri, true);
      if (stopped) return;
      try {
        const representation = await request(iri, 'GET');
        if (representation.state === 'absent404') throw new ObservationFailure('container-absent404');
        const isContainer = representation.quads.some(q => q.subject.value === iri && q.predicate.value === `${RDF}type`
          && [`${LDP}Container`, `${LDP}BasicContainer`].includes(q.object.value));
        if (!isContainer) throw new ObservationFailure('unproven-container');
        const children: string[] = [];
        for (const containment of representation.quads.filter(q => q.subject.value === iri && q.predicate.value === `${LDP}contains`)) {
          if (stopped) break;
          if (depth + 1 > this.limits.depth) { issue('containment-depth-budget', iri); stopped = true; break; }
          if (containment.object.termType !== 'NamedNode') { issue('invalid-containment', iri); continue; }
          let child: string;
          try { child = access.allowContained(iri, containment.object.value); }
          catch { issue('unsupported-containment', containment.object.value); continue; }
          children.push(child);
          if (resources.has(child)) { issue('containment-cycle-or-duplicate', child); continue; }
          if (child.endsWith('/')) await list(child, depth + 1); else await inspect(child, false);
        }
        resources.set(iri, { ...resources.get(iri)!, children: [...new Set(children)].sort() });
      } catch (error) { issue(error instanceof ObservationFailure ? error.code : 'container-read-failed', iri); }
    };
    const probeLimits = (): MembershipProtocolProbeLimits => {
      const requests = this.limits.requests - counts.requests;
      const bytes = this.limits.bytes - counts.bytes;
      if (stopped || total.signal.aborted) throw new ObservationFailure('observation-stopped');
      if (!Number.isSafeInteger(requests) || requests < 1 || bytes < 0) throw new ObservationFailure('request-budget');
      return { requests, bytes, requestTimeoutMs: this.limits.requestTimeoutMs };
    };
    // The A1 ACP observation branch: one closed POST whose qualified guard/read rows ARE the evidence.
    // No WAC HEAD/GET traversal runs, and the sealed server guard fences the existing generic source CAS.
    const observeAcp = async(): Promise<MembershipAcpObservation> => {
      const probe = await observeMembershipAccess(access, probeLimits(), total.signal);
      counts.requests += probe.requests; counts.bytes += probe.bytes;
      const response = probe.response;
      const physicalDocument = facts.sourceIri.split('#')[0];
      try { assertAcpInventory(response.guard, access.roomContainer, physicalDocument); }
      catch { throw new MatrixError(503, 'M_UNAVAILABLE', 'Authorization observation inventory is not a qualified ACP closure'); }
      if (!total.signal.aborted) {
        const current = await access.readCanonical(total.signal);
        if (!isDeepStrictEqual(current.facts, initial.facts) || current.metadataIri !== initial.metadataIri
          || digestGroundSource(facts.sourceIri, physicalDocument, current.quads) !== access.expectedSourceDigest) {
          throw new MatrixError(409, 'M_CONFLICT', 'Canonical source changed during ACP observation');
        }
      }
      const readByIri = new Map(response.read.map(row => [ row.iri, row.allowed ]));
      const resources: MembershipAcpResourceRead[] = response.guard.resources.map(resource => ({
        iri: resource.iri, container: resource.container, read: readByIri.get(resource.iri) === true }));
      return sealAcp({ scope: { sourceIri: facts.sourceIri, sourceRoot: facts.sourcePodUrl, roomContainer: access.roomContainer,
        actorWebId: access.actor.webId, kind }, coverage: 'complete', effectiveRead: 'not-proved',
        requesterWebId: response.requesterWebId, targetWebId: response.targetWebId, sourceIri: response.sourceIri,
        sourceDigest: response.sourceDigest, guard: response.guard, resources, issues: [], counts });
    };
    let negotiatedProfile: 'wac-ground-v1' | 'acp-ground-v1' | undefined;
    try {
      // A2N qualification ALWAYS precedes traversal: a bare/non-declaration response is a hard negative
      // and never a WAC signal. The same trusted request/byte/time domain as HEAD/GET covers the POST.
      const negotiated = await negotiateMembershipAccess(access, probeLimits(), total.signal);
      counts.requests += negotiated.requests; counts.bytes += negotiated.bytes;
      negotiatedProfile = negotiated.declaration.guardedPolicyProfile;
      if (negotiatedProfile === 'acp-ground-v1') return await observeAcp();
      await list(access.roomContainer, 0);
      const canonicalDocument = facts.sourceIri.split('#')[0];
      if (!resources.has(canonicalDocument)) { issue('canonical-document-not-listed', canonicalDocument); await inspect(canonicalDocument, false); }
      // Resolve WAC missing direct representations without merging through a present direct ACL.
      for (const resource of [...resources.values()]) {
        if (stopped || resource.policyState !== 'absent404') continue;
        const parentUrls: string[] = [];
        let parent = new URL('.', resource.iri).href;
        if (resource.container) parent = new URL('../', resource.iri).href;
        while (parent.startsWith(access.roomContainer)) {
          parentUrls.push(parent); if (parent === access.roomContainer) break; parent = new URL('../', parent).href;
        }
        parentUrls.push(...access.ancestors.filter(ancestor => !parentUrls.includes(ancestor)));
        let found = false;
        for (const ancestor of parentUrls) {
          if (stopped) break;
          const record = await inspect(ancestor, true);
          const observed = record.policyIri ? policies.get(record.policyIri) : undefined;
          if (observed?.kind === 'acp') break;
          if (observed && ['present', 'present-empty'].includes(observed.state)) {
            resources.set(resource.iri, { ...resource, wacInheritance: 'ancestor' }); found = true; break;
          }
          if (record.policyState === 'unknown') break;
        }
        if (!found && !stopped) issue('unresolved-ancestor-policy', resource.iri);
      }
      // ACP member policies from every same-Pod ancestor remain relevant even with a direct ACR.
      if ([...policies.values()].some(value => value.kind === 'acp')) {
        for (const ancestor of access.ancestors) { if (stopped) break; await inspect(ancestor, true); }
        issue('unsupported-ancestry-beyond-pod-root', facts.sourcePodUrl);
      }
      if (stopped || total.signal.aborted) issue('observation-incomplete', access.roomContainer);
      // Timeout must not open another privileged request. Otherwise re-prove the entire source.
      if (!stopped && !total.signal.aborted) {
        const current = await access.readCanonical(total.signal);
        if (!isDeepStrictEqual(current.facts, initial.facts) || !isDeepStrictEqual(current.protocols, initial.protocols)
          || !isDeepStrictEqual(snapshotRoles(current), snapshotRoles(initial)) || current.metadataIri !== initial.metadataIri) {
          throw new MatrixError(409, 'M_CONFLICT', 'Canonical membership changed during policy observation');
        }
      }
      return seal({ scope: { sourceIri: facts.sourceIri, sourceRoot: facts.sourcePodUrl, roomContainer: access.roomContainer,
        actorWebId: access.actor.webId, kind }, coverage: issues.length ? 'incomplete' : 'complete', effectiveRead: 'not-proved',
        resources: [...resources.values()], policies: [...policies.values()],
        dependencies: [...policies.keys()], issues, counts });
    } catch (error) {
      if (error instanceof MatrixError && !total.signal.aborted) throw error;
      issue(total.signal.aborted ? 'total-deadline' : error instanceof ObservationFailure ? error.code : 'observation-failed', access.roomContainer);
      // Once ACP is negotiated the qualified guard is the only valid evidence shape: a partial ACP
      // observation cannot be represented as a WAC observation (that would fabricate a WAC absence).
      // Fail closed as unknown instead of returning a WAC-shaped result for an ACP room.
      if (negotiatedProfile === 'acp-ground-v1') {
        throw new MatrixError(503, 'M_UNAVAILABLE', 'ACP authorization observation is incomplete');
      }
      return seal({ scope: { sourceIri: facts.sourceIri, sourceRoot: facts.sourcePodUrl, roomContainer: access.roomContainer,
        actorWebId: access.actor.webId, kind }, coverage: 'incomplete', effectiveRead: 'not-proved', resources: [...resources.values()],
        policies: [...policies.values()], dependencies: [...policies.keys()], issues, counts });
    }
  }
}

/** A current HTTP observation, not effective Read or a server commit receipt. */
export interface MembershipPolicyGuard { readonly profile: 'wac-ground-v1' | 'acp-ground-v1'; readonly scope: string }
interface Evidence { access: MembershipObservationAccess; initial: CanonicalRoomSnapshot; timeoutMs: number; requestTimeoutMs: number; guard: GuardedPolicySnapshot; expiresAtNs: bigint }
const guards = new WeakMap<object, Evidence>();
const unsupported = (): MatrixError => new MatrixError(415, 'M_UNSUPPORTED', 'Observation is not a supported complete WAC closure');
const conflict = (): MatrixError => new MatrixError(409, 'M_CONFLICT', 'Guarded source evidence is not current');

export function compileMembershipPolicyGuard(observation: MembershipRoomObservation): MembershipPolicyGuard {
  const opened = observationContexts.get(observation);
  if (!opened || observation.coverage !== 'complete' || observation.issues.length) throw unsupported();
  assertObservationFresh(opened);
  // ACP: the qualified server guard IS the closure; seal it as opaque evidence for the existing generic
  // canonical source CAS. It is not re-derived locally and never fabricates a WAC policy shape.
  if (isAcpObservation(observation)) {
    if (opened.profile !== 'acp-ground-v1' || !opened.guard) throw unsupported();
    const evidence = Object.freeze({ profile: 'acp-ground-v1' as const, scope: opened.guard.scope });
    guards.set(evidence, { access: opened.access, initial: opened.initial, timeoutMs: opened.timeoutMs,
      requestTimeoutMs: opened.requestTimeoutMs, guard: opened.guard, expiresAtNs: opened.expiresAtNs });
    return evidence;
  }
  if (opened.profile !== 'wac-ground-v1') throw unsupported();
  const scope = guardedPolicyIri(observation.scope.roomContainer);
  const allResources = new Map(observation.resources.map(row => [row.iri, row]));
  const allPolicies = new Map(observation.policies.map(row => [row.iri, row]));
  const resources: GuardedPolicySnapshot['resources'] = [];
  const ancestors = new Map<string, { iri: string; policyIri: string }>();
  const policies = new Map<string, GuardedPolicySnapshot['policies'][number]>();
  let bytes = 0; let quads = 0;
  const policy = (iri: string) => {
    const hit = policies.get(iri); if (hit) return hit;
    const row = allPolicies.get(iri);
    if (!row || row.state === 'unknown' || row.kind === 'acp'
      || (row.state === 'present' && row.kind !== 'wac')) throw unsupported();
    guardedPolicyIri(iri);
    if (row.state === 'absent404' && row.quads.length) throw unsupported();
    if (row.quads.length > 100000 - quads || policies.size >= 512) throw unsupported();
    for (const quad of row.quads) {
      bytes += groundPolicyQuadBytes(quad); quads++;
      if (bytes > 8 * 1024 * 1024) throw unsupported();
    }
    assertGroundWacPolicy(row.quads);
    const entry = { iri, kind: 'wac' as const, state: row.state,
      digest: row.state === 'absent404' ? null : digestGroundPolicy(iri, 'wac', row.quads) };
    if ((row.state === 'present-empty') !== (row.state !== 'absent404' && row.quads.length === 0)) throw unsupported();
    policies.set(iri, entry); return entry;
  };
  const visited = new Set<string>();
  const visit = (iri: string, depth: number): void => {
    const row = allResources.get(iri);
    if (!row || !iri.startsWith(scope) || depth > 32 || visited.has(iri) || visited.size >= 256
      || !row.policyIri || row.container !== iri.endsWith('/')) throw unsupported();
    visited.add(iri); guardedPolicyIri(iri);
    if (!row.container && row.children.length) throw unsupported();
    if (new Set(row.children).size !== row.children.length || row.children.length > 256) throw unsupported();
    resources.push({ iri, container: row.container, children: [...row.children].sort(), policyIri: row.policyIri });
    let current = iri; let entry = policy(row.policyIri); let inheritanceDepth = 0;
    while (entry.state === 'absent404') {
      if (++inheritanceDepth > 32 || current === opened.initial.facts.sourcePodUrl) throw unsupported();
      current = new URL(current.endsWith('/') ? '../' : '.', current).href;
      const parent = allResources.get(current);
      if (!parent?.container || !parent.policyIri || !current.startsWith(opened.initial.facts.sourcePodUrl)) throw unsupported();
      if (!current.startsWith(scope)) ancestors.set(current, { iri: current, policyIri: parent.policyIri });
      entry = policy(parent.policyIri);
    }
    for (const child of row.children) {
      const relative = child.slice(iri.length);
      if (!child.startsWith(iri) || !relative || relative.replace(/\/$/u, '').includes('/')) throw unsupported();
      visit(child, depth + 1);
    }
  };
  try {
    visit(scope, 0);
    if (!resources[0]?.container || observation.resources.some(row => row.iri.startsWith(scope) && !visited.has(row.iri))) throw unsupported();
    const guard = parseGuardedPolicyUpdate({ version: 1, update: 'sealed', guard: {
      profile: 'wac-ground-v1', scope, resources, ancestors: [...ancestors.values()], policies: [...policies.values()],
    } }).guard;
    const evidence = Object.freeze({ profile: 'wac-ground-v1' as const, scope });
    guards.set(evidence, { ...opened, guard }); return evidence;
  } catch { throw unsupported(); }
}
/** Only the exact opened transport can consume this guard. No public guard object is accepted. */
export function membershipGuardForAccess(evidence: unknown, access: MembershipObservationAccess): { guard: GuardedPolicySnapshot; timeoutMs: number; requestTimeoutMs: number; expiresAtNs: bigint } {
  const sealed = evidence && typeof evidence === 'object' ? guards.get(evidence) : undefined;
  if (!sealed || sealed.access !== access) throw conflict();
  assertObservationFresh(sealed);
  return { guard: structuredClone(sealed.guard), timeoutMs: sealed.timeoutMs, requestTimeoutMs: sealed.requestTimeoutMs, expiresAtNs: sealed.expiresAtNs };
}

export async function executeMembershipGuardedCas(evidence: MembershipPolicyGuard, changes: CanonicalRoomChanges): Promise<CanonicalRoomSnapshot> {
  const sealed = guards.get(evidence); if (!sealed) throw conflict();
  assertObservationFresh(sealed);
  return await executeObservationGuard(sealed.access, evidence, changes);
}

/** One ordinary room resource's supported WAC Read result. Not an authorization capability. */
export interface MembershipResourceRead {
  readonly iri: string;
  readonly container: boolean;
  readonly read: boolean;
  readonly policyIri: string;
  /** The resource itself for a direct accessTo match, else the selected ancestor for default. */
  readonly inheritedFrom: string;
}
export interface MembershipEffectiveReadProof {
  readonly profile: 'wac-effective-read-v1';
  readonly actorWebId: string;
  readonly resources: readonly MembershipResourceRead[];
  readonly allRead: boolean;
  readonly noneRead: boolean;
}
/** Tagged ACP effective Read proof over the qualified server guard's agent-only read rows. */
export interface MembershipAcpEffectiveReadProof {
  readonly profile: 'acp-effective-read-v1';
  readonly actorWebId: string;
  readonly requesterWebId: string;
  readonly sourceIri: string;
  readonly sourceDigest: string;
  readonly guard: GuardedPolicySnapshot;
  readonly resources: readonly MembershipAcpResourceRead[];
  readonly allRead: boolean;
  readonly noneRead: boolean;
}
export type MembershipAgentReadProof = MembershipEffectiveReadProof | MembershipAcpEffectiveReadProof;
function supportedPolicy(row: MembershipObservedPolicy): void {
  if (row.state === 'unknown' || row.kind === 'acp') throw unsupported();
  if (row.state !== 'present') return;
  if (row.kind !== 'wac') throw unsupported();
  try { assertGroundWacPolicy(row.quads); } catch { throw unsupported(); }
  // Proof-level explicit class: the generic server ground profile deliberately does not require
  // rdf:type, but the supported membership proof only accepts explicitly typed authorizations.
  const typed = new Set<string>();
  const authorizationSubjects = new Set<string>();
  for (const quad of row.quads) {
    if (quad.predicate.value === `${RDF}type` && quad.object.value === `${ACL}Authorization`) typed.add(quad.subject.value);
    if (quad.predicate.value.startsWith(ACL)) authorizationSubjects.add(quad.subject.value);
  }
  for (const subject of authorizationSubjects) if (!typed.has(subject)) throw unsupported();
}
function effectiveAcl(resources: ReadonlyMap<string, MembershipObservedResource>,
  policies: ReadonlyMap<string, MembershipObservedPolicy>, parentOf: ReadonlyMap<string, string>, iri: string)
  : { subject: string; policy: MembershipObservedPolicy } {
  let current = iri;
  for (let depth = 0; depth <= 64; depth++) {
    const row = resources.get(current);
    const policy = row?.policyIri ? policies.get(row.policyIri) : undefined;
    if (!row || !policy || policy.state === 'unknown' || policy.kind === 'acp') throw unsupported();
    if (policy.state !== 'absent404') return { subject: current, policy };
    const parent = parentOf.get(current);
    if (!parent) throw unsupported();
    current = parent;
  }
  throw unsupported();
}

/**
 * ONE private async proof-freshness path shared by BOTH profiles. It is bounded by the trusted
 * per-request limit and the constant remaining TTL of the sealed observation (never a renewed/fresh
 * budget). It rechecks the fresh exact named owner lease (readonly, no transport) and the full ground
 * source SET before AND after any asynchronous engine/network evaluation. A revoked/rotated/foreign
 * lease is refused 403 with ZERO further privileged transport; any raw source addition/removal/lexical
 * change is refused 409. No caller-provided authority, fetch or proof seal is accepted.
 */
async function assertProofFresh(opened: Readonly<ObservationContext>, signal: AbortSignal): Promise<void> {
  // Lease first: a stale/revoked lease fails before any physical source transport.
  await recheckObservationAuthority(opened.access, signal);
  const physicalDocument = opened.access.initial.facts.sourceIri.split('#')[0];
  const current = await opened.access.readCanonical(signal);
  if (!isDeepStrictEqual(current.facts, opened.access.initial.facts) || current.metadataIri !== opened.access.initial.metadataIri
    || digestGroundSource(opened.access.initial.facts.sourceIri, physicalDocument, current.quads) !== opened.access.expectedSourceDigest) {
    throw new MatrixError(409, 'M_CONFLICT', 'Membership source changed before the proof');
  }
  // Lease AND expiry again AFTER the awaited source response: a revocation or expiry that lands
  // during the physical bookend cannot mint a proof. Expiry uses the sealed monotonic TTL, not only
  // the wall-clock timer.
  await recheckObservationAuthority(opened.access, signal);
  assertObservationFresh(opened);
}
/**
 * Runs the asynchronous proof body under the constant trusted bound `min(request limit, remaining
 * original TTL)`. The bound really aborts the physical request (socket cancelled/drained) and any
 * non-Matrix failure becomes an explicit 503 unknown, never a partial/successful proof.
 */
async function withProofDeadline<T>(opened: Readonly<ObservationContext>, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  assertObservationFresh(opened);
  const remainingMs = (opened.expiresAtNs - trustedNow()) / 1000000n;
  const bound = Math.max(1, Math.min(opened.requestTimeoutMs, remainingMs > 0n ? Number(remainingMs) : 1));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new MatrixError(503, 'M_UNAVAILABLE', 'Membership proof exceeded its deadline')), bound);
  try {
    const result = await run(controller.signal);
    // The timer can be delayed by microtasks/parsing, so re-check the monotonic sealed TTL and the
    // abort signal at final return: a success that lands past expiry is never a proof.
    assertObservationFresh(opened);
    if (controller.signal.aborted) throw new MatrixError(503, 'M_UNAVAILABLE', 'Membership proof request was cancelled');
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw new MatrixError(503, 'M_UNAVAILABLE', 'Membership proof request was cancelled');
    throw error instanceof MatrixError ? error : new MatrixError(503, 'M_UNAVAILABLE', 'Membership proof request failed');
  } finally { clearTimeout(timer); controller.abort(); }
}

/**
 * Supported WAC effective Read over a sealed complete observation. Reuses the installed public
 * policy engine over the sealed resource/policy dataset; unknown/group/origin/ACP/missing
 * dependencies are unsupported (415), never denied. Control/Write/Append never imply Read.
 */
export async function proveMembershipEffectiveRead(observation: MembershipRoomObservation,
  actorWebId: string): Promise<MembershipAgentReadProof> {
  const opened = observationContexts.get(observation);
  if (!opened || observation.coverage !== 'complete' || observation.issues.length) throw unsupported();
  assertObservationFresh(opened);
  if (!isMembershipWebId(actorWebId)) throw new MatrixError(400, 'M_INVALID_PARAM', 'An exact full WebID is required');
  // Exact actor equals the opened access actor for BOTH profiles; no proving another WebID even if the
  // raw WAC policy RDF would allow it.
  if (actorWebId !== opened.access.actor.webId) throw unsupported();
  if (isAcpObservation(observation)) {
    if (opened.profile !== 'acp-ground-v1' || !opened.guard) throw unsupported();
    const readByIri = new Map(observation.resources.map(row => [ row.iri, row.read ]));
    const rows: MembershipAcpResourceRead[] = opened.guard.resources.map(resource => Object.freeze({
      iri: resource.iri, container: resource.container, read: readByIri.get(resource.iri) === true }));
    if (rows.length !== observation.resources.length) throw unsupported();
    await withProofDeadline(opened, async signal => {
      await assertProofFresh(opened, signal);
      await assertProofFresh(opened, signal);
    });
    return Object.freeze({ profile: 'acp-effective-read-v1' as const, actorWebId,
      requesterWebId: observation.requesterWebId, sourceIri: observation.sourceIri, sourceDigest: observation.sourceDigest,
      guard: opened.guard, resources: Object.freeze(rows),
      allRead: rows.every(row => row.read), noneRead: rows.every(row => !row.read) });
  }
  const resources = new Map(observation.resources.map(row => [row.iri, row]));
  const policies = new Map(observation.policies.map(row => [row.iri, row]));
  for (const row of observation.policies) supportedPolicy(row);
  const parentOf = new Map<string, string>();
  for (const row of observation.resources) {
    if (!row.container) continue;
    for (const child of row.children) parentOf.set(child, row.iri);
  }
  const ancestors = opened.access.ancestors;
  if (!parentOf.has(opened.access.roomContainer) && ancestors[0]) parentOf.set(opened.access.roomContainer, ancestors[0]);
  for (let index = 0; index < ancestors.length; index++) {
    if (!parentOf.has(ancestors[index])) parentOf.set(ancestors[index], ancestors[index + 1] ?? opened.initial.facts.sourcePodUrl);
  }
  // Index each observed policy once; the async engine may re-query the same policy many times.
  const policyStores = new Map<string, Store>();
  const manager: AuthorizationManager = {
    getParent: (id: string) => parentOf.get(id),
    getAuthorizationData: async(id: string) => {
      const row = resources.get(id);
      const policy = row?.policyIri ? policies.get(row.policyIri) : undefined;
      if (!row || !policy || policy.state === 'unknown' || policy.kind === 'acp') throw unsupported();
      if (policy.state === 'absent404') return undefined;
      // A present-empty representation stops inheritance with no authorizations; its kind is unknown.
      if (policy.kind !== 'wac' && policy.state !== 'present-empty') throw unsupported();
      const cached = policyStores.get(policy.iri);
      if (cached) return cached;
      const store = new Store([...policy.quads]);
      policyStores.set(policy.iri, store);
      return store;
    },
  };
  const engine = new WacPolicyEngine(new UnionAccessChecker([ new AgentAccessChecker(), new AgentClassAccessChecker() ]),
    new ManagedWacRepository(manager));
  const scope = observation.scope.roomContainer;
  const targets = observation.resources.filter(row => row.iri.startsWith(scope) && !policies.has(row.iri));
  // Same shared freshness lifecycle as ACP: fresh lease + full ground source SET before AND after the
  // asynchronous WAC engine evaluation, under the constant trusted bound.
  const results = await withProofDeadline(opened, async signal => {
    await assertProofFresh(opened, signal);
    const collected: MembershipResourceRead[] = [];
    for (const resource of targets) {
      const effective = effectiveAcl(resources, policies, parentOf, resource.iri);
      let read = false;
      try {
        const permissions = await engine.getPermissions(resource.iri, { agent: actorWebId }, [ WacVocabulary.Read ]);
        read = permissions[WacVocabulary.Read] === true;
      } catch { throw unsupported(); }
      // Provenance is the *selected effective* policy, not the resource's absent direct policy.
      collected.push(Object.freeze({ iri: resource.iri, container: resource.container, read,
        policyIri: effective.policy.iri, inheritedFrom: effective.subject }));
    }
    await assertProofFresh(opened, signal);
    return collected;
  });
  if (!results.length) throw unsupported();
  return Object.freeze({ profile: 'wac-effective-read-v1' as const, actorWebId,
    resources: Object.freeze(results), allRead: results.every(row => row.read), noneRead: results.every(row => !row.read) });
}

export interface MembershipReadDeltaIntent { readonly operationId: string; readonly kind: 'join' | 'leave' }
interface ReadDeltaEvidence {
  kind: 'join' | 'leave'; operationId: string; actorWebId: string; targetWebId: string;
  binding: MembershipAuthorityBinding; sourceIri: string; sourcePodId: string; sourceRoot: string;
  snapshot: CanonicalRoomSnapshot; proof: MembershipAgentReadProof; postGuard: MembershipPolicyGuard;
  authorizationIri: string; policyIri: string; readProfile: 'wac-ground-v1' | 'acp-ground-v1';
}
const readDeltas = new WeakMap<object, ReadDeltaEvidence>();
/** Rebase applicable inherited authorizations onto the room; exact direct accessTo/default scope. */
const rebasedInherited = (quads: readonly Quad[], room: string): string[][] => {
  const tuples: string[][] = [];
  const subjects = new Set<string>();
  for (const quad of quads) {
    if (quad.subject.termType === 'NamedNode' && quad.predicate.value === `${RDF}type`
      && quad.object.value === `${ACL}Authorization`) subjects.add(quad.subject.value);
  }
  for (const subject of [...subjects].sort()) {
    const own = quads.filter(quad => quad.subject.termType === 'NamedNode' && quad.subject.value === subject);
    const accessTo = own.some(quad => quad.predicate.value === `${ACL}accessTo`);
    const isDefault = own.some(quad => quad.predicate.value === `${ACL}default`);
    if (!accessTo && !isDefault) continue;
    const rebased = `${room}#membership-inherited-${createHash('sha256').update(subject).digest('hex').slice(0, 32)}`;
    tuples.push([ rebased, `${RDF}type`, `${ACL}Authorization` ]);
    if (accessTo) tuples.push([ rebased, `${ACL}accessTo`, room ]);
    if (isDefault) tuples.push([ rebased, `${ACL}default`, room ]);
    for (const quad of own) {
      if ([`${RDF}type`, `${ACL}accessTo`, `${ACL}default`].includes(quad.predicate.value)) continue;
      if (quad.object.termType !== 'NamedNode') throw unsupported();
      tuples.push([ rebased, quad.predicate.value, quad.object.value ]);
    }
  }
  return tuples;
};
const tripleLine = (tuple: readonly string[]): string => `<${tuple[0]}> <${tuple[1]}> <${tuple[2]}> .`;
const namedTupleKey = (tuple: readonly string[]): string => JSON.stringify([tuple[0], tuple[1], 'NamedNode', tuple[2]]);
/** Full ground term identity, including literal datatype and language, for retained comparison. */
const quadTupleKey = (quad: Quad): string => quad.object.termType === 'Literal'
  ? JSON.stringify([quad.subject.value, quad.predicate.value, 'Literal', quad.object.value,
    quad.object.datatype.value, quad.object.language.toLowerCase()])
  : JSON.stringify([quad.subject.value, quad.predicate.value, quad.object.termType, quad.object.value]);
const retainedTuples = (quads: readonly Quad[], grant: string): string[] => quads
  .filter(quad => !(quad.subject.termType === 'NamedNode' && quad.subject.value === grant))
  .map(quadTupleKey).sort();
/**
 * Only an exact-shape operation-owned grant may be removed. Any extra value on the deterministic
 * node (additional mode/agent/accessTo/default/type, duplicate or foreign term) means the node also
 * carries another party's rights, so it is unsupported before any policy POST and left untouched.
 */
/** Removal requires this actor's durable INSTALLED receipt for the exact selected policy. */
const assertInstalledGrant = (reservation: MembershipReadGrant | undefined, target: string, policyIri: string): void => {
  if (!reservation || reservation.state !== 'installed' || reservation.actorWebId !== target
    || !reservation.policyIri || reservation.policyIri !== policyIri
    || !reservation.authorizationIri) throw unsupported();
};
const assertOwnedGrant = (quads: readonly Quad[], grant: string, target: string, room: string): void => {
  const own = quads.filter(quad => quad.subject.termType === 'NamedNode' && quad.subject.value === grant);
  if (!own.length) return;
  const allowed = new Set([`${RDF}type`, `${ACL}agent`, `${ACL}accessTo`, `${ACL}default`, `${ACL}mode`]);
  if (own.some(quad => !allowed.has(quad.predicate.value) || quad.object.termType !== 'NamedNode')) throw unsupported();
  const exact = (predicate: string, object: string): boolean => {
    const rows = own.filter(quad => quad.predicate.value === predicate);
    return rows.length === 1 && rows[0].object.value === object;
  };
  if (!exact(`${RDF}type`, `${ACL}Authorization`) || !exact(`${ACL}agent`, target)
    || !exact(`${ACL}accessTo`, room) || !exact(`${ACL}default`, room)
    || !exact(`${ACL}mode`, `${ACL}Read`)) throw unsupported();
};
const POLICY_READBACK_TIMEOUT_MS = 1500;
const POLICY_READBACK_BYTE_BUDGET = 8 * 1024 * 1024;
const SUPPORTED_POLICY_MEDIA = /^(?:text\/turtle|application\/n-triples)$/iu;
const unavailable = (message: string): MatrixError => new MatrixError(503, 'M_UNAVAILABLE', message);
type PolicyReadExpectation = 'absent404' | 'present-empty' | 'present' | '200';
interface PolicyReadResult { readonly state: 'absent404' | 'present-empty' | 'present'; readonly text: string; readonly quads: readonly Quad[] }
function parsePolicyQuads(text: string, policy: string): Quad[] {
  let quads: Quad[];
  try { quads = new Parser({ baseIRI: policy, format: 'Turtle' }).parse(text); }
  catch { throw unavailable('Guarded policy body is malformed'); }
  if (!quads.length) throw unavailable('Guarded policy body is malformed');
  return quads;
}
/**
 * ONE finite private policy reader. It admits ONLY the exact same-Pod policy resource through the sealed
 * access, then applies the exact URL/redirect/media/bounded-body/remaining-deadline/current-lease
 * contract with real cancel/drain. `expectation` is narrowly typed (`absent404` requires 404,
 * `present-empty`/`present` require a 200 with/without quads, `200` accepts either) so there is no
 * generic fetch framework and no 'any 404 as empty' bypass. Non-200/redirect/wrong-URL/media/oversize/
 * deadline are explicit 503, never a receipt or raw transport error.
 */
async function readPolicy(access: MembershipObservationAccess, room: string, policy: string,
  expectation: PolicyReadExpectation, boundMs: number, byteBudget: number): Promise<PolicyReadResult> {
  access.allowPolicy(room, policy);
  const policyOrigin = new URL(policy).origin;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, boundMs);
  function fail(message: string): never { throw unavailable(message); }
  try {
    const response = await access.readResource(policy, 'GET', controller.signal);
    if (timedOut || controller.signal.aborted) fail('Guarded policy read exceeded its deadline');
    if (response.redirected) fail('Guarded policy read was redirected');
    // The named transport pins the exact resource; a rewritten URL is not the same resource.
    try { if (new URL(response.url, policyOrigin).href !== policy) fail('Guarded policy read URL differs'); }
    catch (error) { if (error instanceof MatrixError) throw error; fail('Guarded policy read URL is invalid'); }
    if (response.status === 404) {
      if (response.body) await response.body.cancel().catch(() => {});
      if (expectation !== 'absent404') fail('Guarded policy state disagrees with the qualified guard');
      return { state: 'absent404', text: '', quads: [] };
    }
    if (response.status !== 200) fail('Guarded policy read was not a 200 or 404 response');
    const mediaType = response.headers.get('content-type')?.split(';')[0].trim() ?? '';
    if (!SUPPORTED_POLICY_MEDIA.test(mediaType)) fail('Guarded policy read media is unsupported');
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let text = ''; let bytes = 0;
    if (reader) {
      try {
        while (true) {
          if (timedOut || controller.signal.aborted) fail('Guarded policy read exceeded its deadline');
          const chunk = await reader.read();
          if (chunk.done) break;
          if (chunk.value.byteLength) {
            bytes += chunk.value.byteLength;
            // Enforce the bounded whole body before decoding/retaining/parsing anything.
            if (bytes > byteBudget) { await reader.cancel().catch(() => {}); fail('Guarded policy read exceeded its byte budget'); }
            text += decoder.decode(chunk.value, { stream: true });
          }
        }
        text += decoder.decode();
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
    const state: 'present-empty' | 'present' = text.trim().length ? 'present' : 'present-empty';
    if (expectation !== '200' && expectation !== state) fail('Guarded policy state disagrees with the qualified guard');
    return { state, text, quads: state === 'present' ? parsePolicyQuads(text, policy) : [] };
  } catch (error) {
    if (error instanceof MatrixError) throw error;
    if (timedOut || controller.signal.aborted) {
      // Real cancellation/draining: let the aborted physical request's socket teardown settle
      // before reporting the unavailable outcome, so the caller never reads it as a receipt.
      await new Promise(resolve => setTimeout(resolve, 0));
      fail('Guarded policy read was cancelled');
    }
    fail('Guarded policy read failed');
  } finally { clearTimeout(timer); controller.abort(); }
}

const acpQuad = (tuple: readonly string[]): Quad =>
  DataFactory.quad(DataFactory.namedNode(tuple[0]), DataFactory.namedNode(tuple[1]), DataFactory.namedNode(tuple[2]));
interface AcpGrantLayout { readonly acr: string; readonly control: string; readonly policy: string; readonly matcher: string }
/** Deterministic same-document layout: the durable root IS the AccessControl; children never add a second `#`. */
function acpGrantLayout(acr: string, control: string): AcpGrantLayout {
  return { acr, control, policy: `${control}-policy`, matcher: `${control}-matcher` };
}
const acpShellTriples = (room: string, acr: string): string[][] =>
  [ [ acr, `${RDF}type`, `${ACP}AccessControlResource` ], [ acr, `${ACP}resource`, room ] ];
const acpOwnedTriples = (layout: AcpGrantLayout, actorWebId: string): string[][] => [
  [ layout.control, `${RDF}type`, `${ACP}AccessControl` ],
  [ layout.control, `${ACP}apply`, layout.policy ],
  [ layout.policy, `${RDF}type`, `${ACP}Policy` ],
  [ layout.policy, `${ACP}allow`, `${ACL}Read` ],
  [ layout.policy, `${ACP}anyOf`, layout.matcher ],
  [ layout.matcher, `${RDF}type`, `${ACP}Matcher` ],
  [ layout.matcher, `${ACP}agent`, actorWebId ],
  [ layout.acr, `${ACP}accessControl`, layout.control ],
  [ layout.acr, `${ACP}memberAccessControl`, layout.control ],
];
/** The single actual ACR subject, derived from the exact `acp:resource <room>` triple; never the document IRI. */
function deriveAcpAcrSubject(quads: readonly Quad[], room: string): string {
  const subjects = [ ...new Set(quads.filter(quad => quad.subject.termType === 'NamedNode'
    && quad.predicate.value === `${ACP}resource` && quad.object.value === room).map(quad => quad.subject.value)) ];
  if (subjects.length !== 1) throw unsupported();
  return subjects[0];
}
/**
 * Complete incoming AND outgoing subgraph check for the three owned nodes and the two actual-ACR links,
 * using RDF-set + full lexical term identity. Any extra outgoing value on an owned node, or any foreign
 * reference (ANY subject/predicate) pointing at an owned node, is refused 415 before any delete/adopt.
 */
function assertExactAcpOwned(quads: readonly Quad[], layout: AcpGrantLayout, actorWebId: string): void {
  const keyOf = (quad: Quad): string => `${quad.predicate.value}\u0000${quad.object.termType}\u0000${quad.object.value}`;
  const exact = (subject: string, expected: readonly string[][]): void => {
    const own = quads.filter(quad => quad.subject.termType === 'NamedNode' && quad.subject.value === subject);
    const have = new Set(own.map(keyOf));
    if (own.length !== expected.length || have.size !== expected.length
      || expected.some(([ predicate, object ]) => !have.has(`${predicate}\u0000NamedNode\u0000${object}`))) throw unsupported();
  };
  exact(layout.control, [ [ `${RDF}type`, `${ACP}AccessControl` ], [ `${ACP}apply`, layout.policy ] ]);
  exact(layout.policy, [ [ `${RDF}type`, `${ACP}Policy` ], [ `${ACP}allow`, `${ACL}Read` ], [ `${ACP}anyOf`, layout.matcher ] ]);
  exact(layout.matcher, [ [ `${RDF}type`, `${ACP}Matcher` ], [ `${ACP}agent`, actorWebId ] ]);
  const linkCount = (predicate: string): number => quads.filter(quad => quad.subject.termType === 'NamedNode'
    && quad.subject.value === layout.acr && quad.predicate.value === predicate && quad.object.value === layout.control).length;
  if (linkCount(`${ACP}accessControl`) !== 1 || linkCount(`${ACP}memberAccessControl`) !== 1) throw unsupported();
  // Complete incoming reference set: the only references to the owned nodes are the two ACR links to the
  // control, the control's apply to the policy, and the policy's anyOf to the matcher. Any other subject
  // or predicate referencing an owned node is a foreign reference and refuses before dispatch.
  const incoming = (iri: string): number => quads.filter(quad => quad.object.termType === 'NamedNode' && quad.object.value === iri).length;
  if (incoming(layout.control) !== 2 || incoming(layout.policy) !== 1 || incoming(layout.matcher) !== 1) throw unsupported();
}
/** Profile-specific delta plan; only pure preparation and the exact readback validation differ. */
interface DeltaPlanBase {
  readonly room: string;
  readonly roomPolicy: string;
  readonly guard?: MembershipPolicyGuard;
  readonly authorizationIri: string;
  readonly update?: string;
}
interface WacDeltaPlan extends DeltaPlanBase { readonly profile: 'wac'; readonly grant: string; readonly expectedRetained: readonly string[] }
interface AcpDeltaPlan extends DeltaPlanBase {
  readonly profile: 'acp';
  readonly layout: AcpGrantLayout;
  readonly ownedQuads: readonly Quad[];
  readonly shellQuads: readonly Quad[];
  readonly currentQuads: readonly Quad[];
}
type DeltaPlan = WacDeltaPlan | AcpDeltaPlan;

/** Pure WAC preparation over the sealed observation (no engine, no transport). */
function prepareWacDelta(opened: Readonly<ObservationContext>, observation: MembershipPolicyObservation,
  intent: MembershipReadDeltaIntent, target: string, reservation: MembershipReadGrant | undefined,
  creationMatches: boolean): WacDeltaPlan {
  const facts = opened.initial.facts;
  const room = observation.scope.roomContainer;
  const roomResource = observation.resources.find(row => row.iri === room);
  if (!roomResource?.policyIri) throw unsupported();
  const roomPolicy = roomResource.policyIri;
  const resources = new Map(observation.resources.map(row => [row.iri, row]));
  const policies = new Map(observation.policies.map(row => [row.iri, row]));
  const parentOf = new Map<string, string>();
  for (const row of observation.resources) {
    if (!row.container) continue;
    for (const child of row.children) parentOf.set(child, row.iri);
  }
  const ancestors = opened.access.ancestors;
  if (!parentOf.has(room) && ancestors[0]) parentOf.set(room, ancestors[0]);
  for (let index = 0; index < ancestors.length; index++) {
    if (!parentOf.has(ancestors[index])) parentOf.set(ancestors[index], ancestors[index + 1] ?? facts.sourcePodUrl);
  }
  const effective = effectiveAcl(resources, policies, parentOf, room);
  const directQuads = effective.subject === room ? effective.policy.quads : [];
  // A pre-existing member may have no durable receipt; then leave owns no node and only proves the
  // postcondition (fails closed if unrelated rights retain Read). The installed pointer must equal the
  // recorded ORIGINAL join tuple + the current discovered policy.
  const owned = intent.kind === 'leave' && creationMatches && reservation!.state === 'installed'
    && reservation!.authorizationIri ? reservation : undefined;
  if (owned && (owned.policyIri !== roomPolicy
    || owned.authorizationIri !== grantAuthorizationIri(roomPolicy, target, owned.joinOperationId, facts.sourceIri))) throw conflict();
  const grant = owned?.authorizationIri ?? grantAuthorizationIri(roomPolicy, target, intent.operationId, facts.sourceIri);
  const fence = canonicalSourceFenceSparql(opened.initial);
  let update: string | undefined;
  let expectedRetained: string[] = [];
  if (intent.kind === 'join') {
    const tuples = [ [grant, `${RDF}type`, `${ACL}Authorization`], [grant, `${ACL}agent`, target],
      [grant, `${ACL}accessTo`, room], [grant, `${ACL}default`, room], [grant, `${ACL}mode`, `${ACL}Read`] ];
    // A first direct room ACL would stop inheritance; materialize the applicable inherited authorizations
    // onto the room before adding the target grant so owner/public rights survive.
    if (effective.subject !== room) {
      const inherited = rebasedInherited(effective.policy.quads, room);
      tuples.push(...inherited);
      expectedRetained = inherited.map(namedTupleKey).sort();
    } else {
      expectedRetained = retainedTuples(directQuads, grant);
    }
    const where = effective.subject === room ? roomPolicy : effective.policy.iri;
    update = `INSERT { GRAPH <${roomPolicy}> { ${tuples.map(tripleLine).join('\n')} } } WHERE { GRAPH <${where}> { ?s ?p ?o } ${fence} }`;
  } else if (owned) {
    if (effective.subject !== room) throw unsupported();
    // Any extra value on the deterministic node is another party's right: 415 BEFORE any POST.
    assertOwnedGrant(directQuads, grant, target, room);
    assertInstalledGrant(owned, target, roomPolicy);
    if (!directQuads.some(quad => quad.subject.value === grant)) throw unsupported();
    expectedRetained = retainedTuples(directQuads, grant);
    update = `DELETE { GRAPH <${roomPolicy}> { <${grant}> ?p ?o } } WHERE { GRAPH <${roomPolicy}> { <${grant}> ?p ?o } ${fence} }`;
  }
  return { profile: 'wac', room, roomPolicy, guard: update ? compileMembershipPolicyGuard(observation) : undefined,
    authorizationIri: grant, update, grant, expectedRetained };
}

/**
 * ACP preparation: pure owned-graph layout plus the ONE narrow initial direct-policy acquisition through
 * `readPolicy` (the only physical read that differs from WAC). No observer/transport/business context.
 */
async function prepareAcpDelta(opened: Readonly<ObservationContext>, observation: MembershipAcpObservation,
  intent: MembershipReadDeltaIntent, target: string, reservation: MembershipReadGrant | undefined,
  creationMatches: boolean, limits: MembershipObservationLimits, bound: number): Promise<AcpDeltaPlan> {
  const facts = opened.initial.facts;
  const room = observation.scope.roomContainer;
  const roomRow = observation.guard.resources.find(row => row.iri === room);
  if (!roomRow?.policyIri) throw unsupported();
  const roomPolicy = roomRow.policyIri;
  const guardPolicy = observation.guard.policies.find(row => row.iri === roomPolicy);
  if (!guardPolicy || (guardPolicy.state !== 'absent404' && guardPolicy.state !== 'present-empty' && guardPolicy.state !== 'present')) {
    throw unsupported();
  }
  const current = (await readPolicy(opened.access, room, roomPolicy, guardPolicy.state, bound, limits.bytes)).quads;
  if (current.length) {
    assertGroundAcpPolicy(roomPolicy, room, current);
    if (digestGroundPolicy(roomPolicy, 'acp', current) !== guardPolicy.digest) {
      throw new MatrixError(409, 'M_CONFLICT', 'Direct room ACP policy changed during observation');
    }
  } else if (guardPolicy.state === 'present-empty' && guardPolicy.digest !== null
    && digestGroundPolicy(roomPolicy, 'acp', []) !== guardPolicy.digest) {
    throw new MatrixError(409, 'M_CONFLICT', 'Direct room ACP policy changed during observation');
  }
  const owned = intent.kind === 'leave' && creationMatches && reservation!.state === 'installed' ? reservation : undefined;
  const acr = current.length ? deriveAcpAcrSubject(current, room) : `${roomPolicy}#acr`;
  // The durable root is RECOMPUTED from the exact installed tuple (current qualified policy, full actor
  // WebID, the ORIGINAL join operation id, and the FULL source IRI incl. fragment). The stored pointer is
  // trusted only after it equals this recomputation; a foreign/same-shape pointer is refused before any
  // write. Ownership is never derived from the current LEAVE operation id or from 'same shape'.
  const control = intent.kind === 'join'
    ? grantAuthorizationIri(roomPolicy, target, intent.operationId, facts.sourceIri)
    : owned ? grantAuthorizationIri(roomPolicy, target, owned.joinOperationId, facts.sourceIri) : '';
  if (intent.kind === 'leave' && (!owned || owned.readProfile !== 'acp-ground-v1'
    || owned.policyIri !== roomPolicy || owned.authorizationIri !== control)) throw conflict();
  const layout = acpGrantLayout(acr, control);
  const shell = current.length ? [] : acpShellTriples(room, acr);
  const ownedTriples = acpOwnedTriples(layout, target);
  if (intent.kind === 'join') {
    // Any pre-existing node/reference using our deterministic IRIs (even byte-identical) is a collision
    // created by someone else: 415 before any policy POST. A reservation is not creation proof.
    const ownedIris = new Set([ layout.control, layout.policy, layout.matcher ]);
    if (current.some(quad => (quad.subject.termType === 'NamedNode' && ownedIris.has(quad.subject.value))
      || (quad.object.termType === 'NamedNode' && ownedIris.has(quad.object.value)))) throw unsupported();
  } else {
    assertExactAcpOwned(current, layout, target);
  }
  const fence = canonicalSourceFenceSparql(opened.initial);
  const update = intent.kind === 'join'
    ? `INSERT { GRAPH <${roomPolicy}> { ${[ ...shell, ...ownedTriples ].map(tripleLine).join('\n')} } } WHERE { ${fence} }`
    : `DELETE { GRAPH <${roomPolicy}> { ${ownedTriples.map(tripleLine).join('\n')} } } WHERE { ${fence} }`;
  return { profile: 'acp', room, roomPolicy, guard: compileMembershipPolicyGuard(observation),
    authorizationIri: layout.control, update, layout, ownedQuads: ownedTriples.map(acpQuad),
    shellQuads: shell.map(acpQuad), currentQuads: current };
}

/** The only profile-specific readback difference: exact expected-graph validation. */
function validateDeltaReadback(plan: DeltaPlan, afterQuads: readonly Quad[], intent: MembershipReadDeltaIntent, target: string): void {
  if (plan.profile === 'wac') {
    if (intent.kind === 'join') {
      const own = afterQuads.filter(quad => quad.subject.value === plan.grant);
      const has = (predicate: string, object: string): boolean => own.some(quad => quad.predicate.value === predicate && quad.object.value === object);
      if (!has(`${RDF}type`, `${ACL}Authorization`) || !has(`${ACL}agent`, target) || !has(`${ACL}accessTo`, plan.room)
        || !has(`${ACL}default`, plan.room) || !has(`${ACL}mode`, `${ACL}Read`)
        || !isDeepStrictEqual(plan.expectedRetained, retainedTuples(afterQuads, plan.grant))) {
        throw new MatrixError(503, 'M_UNAVAILABLE', 'Guarded policy readback did not confirm the exact grant');
      }
    } else if (afterQuads.some(quad => quad.subject.value === plan.grant)
      || !isDeepStrictEqual(plan.expectedRetained, retainedTuples(afterQuads, plan.grant))) {
      throw new MatrixError(503, 'M_UNAVAILABLE', 'Guarded policy readback did not confirm the exact removal');
    }
    return;
  }
  assertGroundAcpPolicy(plan.roomPolicy, plan.room, afterQuads);
  const expectedAfter = intent.kind === 'join'
    ? [ ...plan.currentQuads, ...plan.shellQuads, ...plan.ownedQuads ]
    : plan.currentQuads.filter(quad => !plan.ownedQuads.some(ownedQuad => ownedQuad.equals(quad)));
  if (digestGroundPolicy(plan.roomPolicy, 'acp', afterQuads) !== digestGroundPolicy(plan.roomPolicy, 'acp', expectedAfter)) {
    throw new MatrixError(503, 'M_UNAVAILABLE', 'Guarded ACP readback did not confirm the exact policy');
  }
  if (intent.kind === 'join') assertExactAcpOwned(afterQuads, plan.layout, target);
}

/**
 * The ONE bounded actual room Read-delta lifecycle. It shares the operation/reservation/current-tuple
 * check, the opaque guarded policy write, the finite policy readback, the genuinely NEW complete
 * observation + effective Read proof/postcondition, the post-delta guard and the private receipt. The
 * profiles differ ONLY in pure plan preparation (`prepareWacDelta`/`prepareAcpDelta`) and exact readback
 * validation. The returned opaque evidence is required by the hardened source phase marks.
 */
export async function applyMembershipReadDelta(options: MembershipPolicyObserverOptions, roomId: string,
  incoming: MatrixStoreContext, intent: MembershipReadDeltaIntent): Promise<object> {
  if (!intent || (intent.kind !== 'join' && intent.kind !== 'leave') || typeof intent.operationId !== 'string') {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'Invalid membership Read delta intent');
  }
  const observer = new MembershipPolicyObserver(options);
  const observation = await observer.observe(roomId, incoming, intent.kind);
  const opened = observationContexts.get(observation);
  if (!opened) throw unsupported();
  const facts = opened.initial.facts;
  const operation = facts.membershipOperation;
  const target = observation.scope.actorWebId;
  const expectedPhase = intent.kind === 'join' ? 'join-read-pending' : 'leave-read-pending';
  if (!operation || operation.operationId !== intent.operationId || operation.kind !== intent.kind
    || operation.targetWebId !== target || operation.actor.webId !== target || operation.phase !== expectedPhase) throw conflict();
  // Shared reservation/operation identity check (both profiles): actor/op/time/author/source/binding
  // must match the sealed canonical source before any policy POST, and a reserved tuple never carries a
  // profile (the successful guarded Read mark installs it atomically).
  const reservation = facts.membershipReadGrants?.[target];
  const creationMatches = reservation !== undefined
    && reservation.actorWebId === target && reservation.sourceIri === facts.sourceIri
    && reservation.authorPodUrl.webId === facts.authorWebId && reservation.authorPodUrl.podUrl === facts.sourcePodUrl
    && isDeepStrictEqual(reservation.binding, opened.access.binding);
  if (intent.kind === 'join') {
    if (!creationMatches || reservation!.joinOperationId !== intent.operationId
      || reservation!.createdAt !== operation.event.createdAt || reservation!.state !== 'reserved'
      || reservation!.readProfile !== undefined) throw conflict();
  }
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const remainingMs = Number((opened.expiresAtNs - trustedNow()) / 1000000n);
  if (remainingMs <= 0) throw new MatrixError(409, 'M_CONFLICT', 'Sealed observation evidence has expired');
  const bound = Math.max(1, Math.min(opened.requestTimeoutMs, remainingMs));
  // Profile-specific PURE preparation; the ACP plan additionally acquires the ONE direct room policy.
  const plan = isAcpObservation(observation)
    ? await prepareAcpDelta(opened, observation, intent, target, reservation, creationMatches, limits, bound)
    : prepareWacDelta(opened, observation, intent, target, reservation, creationMatches);
  // Shared guarded policy write + finite readback + exact profile-specific readback validation.
  if (plan.update) {
    if (!plan.guard) throw unsupported();
    await executeObservationPolicyUpdate(opened.access, plan.guard, plan.update);
    // WAC preserves its original per-request readback bound; ACP bounds by min(request limit, remaining TTL).
    const after = await readPolicy(opened.access, plan.room, plan.roomPolicy, '200',
      plan.profile === 'acp' ? bound : limits.requestTimeoutMs, limits.bytes);
    validateDeltaReadback(plan, after.quads, intent, target);
  }
  // Shared genuinely-NEW complete observation + proof + postcondition.
  const post = await observer.observe(roomId, incoming, intent.kind);
  const proof = await proveMembershipEffectiveRead(post, target);
  if (proof.profile !== (plan.profile === 'acp' ? 'acp-effective-read-v1' : 'wac-effective-read-v1')) throw unsupported();
  if (intent.kind === 'join' ? !proof.allRead : !proof.noneRead) {
    throw new MatrixError(409, 'M_CONFLICT', 'The required effective Read postcondition is not satisfied');
  }
  // Shared post-delta closure + private receipt carrying the explicit profile for the install CAS.
  const postGuard = compileMembershipPolicyGuard(post);
  const evidence = Object.freeze({ profile: plan.profile === 'acp' ? 'acp-read-delta-v1' as const : 'wac-read-delta-v1' as const });
  readDeltas.set(evidence, Object.freeze({ kind: intent.kind, operationId: intent.operationId, actorWebId: target,
    targetWebId: target, binding: opened.access.binding, sourceIri: facts.sourceIri, sourcePodId: facts.sourcePodId,
    sourceRoot: facts.sourcePodUrl, snapshot: opened.initial, proof, postGuard,
    authorizationIri: plan.authorizationIri, policyIri: plan.roomPolicy,
    readProfile: plan.profile === 'acp' ? 'acp-ground-v1' as const : 'wac-ground-v1' as const }));
  return evidence;
}

/** The exact durable authorization the delta created/removed, bound to the branded evidence. */
export function membershipReadDeltaGrant(evidence: unknown): { authorizationIri: string; policyIri: string; readProfile: 'wac-ground-v1' | 'acp-ground-v1' } {
  const sealed = evidence && typeof evidence === 'object' ? readDeltas.get(evidence as object) : undefined;
  if (!sealed) throw conflict();
  return { authorizationIri: sealed.authorizationIri, policyIri: sealed.policyIri, readProfile: sealed.readProfile };
}

/** Whole-history guarded source CAS carrying the post-delta closure. Evidence is mandatory. */
export async function executeMembershipReadDeltaCas(evidence: unknown, changes: CanonicalRoomChanges): Promise<CanonicalRoomSnapshot> {
  const sealed = evidence && typeof evidence === 'object' ? readDeltas.get(evidence as object) : undefined;
  if (!sealed) throw conflict();
  return await executeMembershipGuardedCas(sealed.postGuard, changes);
}

/** Requires the exact branded post-delta proof for the current canonical operation. Never optional. */
export function assertMembershipReadDeltaEvidence(evidence: unknown, expected: {
  kind: 'join' | 'leave'; operationId: string; actorWebId: string; targetWebId: string;
  binding?: MembershipAuthorityBinding; snapshot: CanonicalRoomSnapshot;
}): void {
  const sealed = evidence && typeof evidence === 'object' ? readDeltas.get(evidence) : undefined;
  if (!sealed) throw conflict();
  const facts = expected.snapshot.facts;
  if (sealed.kind !== expected.kind || sealed.operationId !== expected.operationId
    || sealed.actorWebId !== expected.actorWebId || sealed.targetWebId !== expected.targetWebId
    || !isDeepStrictEqual(sealed.binding, expected.binding ?? null)
    || facts.sourceIri !== sealed.sourceIri || facts.sourcePodId !== sealed.sourcePodId
    || facts.sourcePodUrl !== sealed.sourceRoot
    || !isDeepStrictEqual(sealed.snapshot, expected.snapshot)
    || (expected.kind === 'join' ? !sealed.proof.allRead : !sealed.proof.noneRead)) throw conflict();
}
