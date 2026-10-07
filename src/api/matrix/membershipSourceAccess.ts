import { isDeepStrictEqual } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { chatResource } from '@undefineds.co/models';
import type { PodAccessFetchProvider } from '../ai-gateway/pod/OwnerPodAccess';
import type { TaskCredentialStore } from '../tasks/TaskCredentialStore';
import { CanonicalRoomSource, copyImmutableCanonicalRoomSnapshot, type CanonicalRoomSnapshot, type MembershipAuthorityBinding, type CanonicalRoomFacts } from './canonicalRoomSource';
import { MembershipAuthorityResolver, isMembershipAuthorityProof } from './membershipAuthorityResolver';
import { createNamedCanonicalRead } from './namedCanonicalRead';
import { buildCanonicalRoomCas, type CanonicalRoomChanges } from './canonicalRoomCas';
import type { MembershipOperation } from './membershipOperation';
import { matrixPodWriteFor } from './podAccess';
import type { MatrixStoreContext } from './types';
import { MatrixError } from './MatrixError';
import { membershipGuardForAccess } from './membershipPolicyObservation';
import type { GuardedPolicySnapshot } from '../../storage/rdf/GuardedPolicySnapshot';
import { GUARDED_SPARQL_MEDIA_TYPE, digestGroundSource } from '../../storage/rdf/GuardedPolicySnapshot';
import {
  AUTHORIZATION_OBSERVATION_MEDIA_TYPE,
  AUTHORIZATION_OBSERVATION_PROFILE,
  AUTHORIZATION_PROFILE_DECLARATION_MEDIA_TYPE,
  AUTHORIZATION_PROFILE_NEGOTIATION_MEDIA_TYPE,
  AUTHORIZATION_PROFILE_NEGOTIATION_PROFILE,
  parseAuthorizationObservationResponse,
  parseAuthorizationProfileDeclaration,
  type AuthorizationProfileDeclaration,
  type AuthorizationObservationResponse,
} from '../../storage/rdf/AuthorizationObservation';
export interface MembershipSourceAccessOptions {
  canonicalSource: Pick<CanonicalRoomSource, 'readSnapshot' | 'readNamedSnapshot' | 'assertActorPod' | 'assertRegisteredActorPod'>;
  resolver: Pick<MembershipAuthorityResolver, 'readAsCaller' | 'resolveForMembership'>;
  credentials: Pick<TaskCredentialStore, 'lease'>;
  podAccess: PodAccessFetchProvider;
  issuer: string;
}
const forbidden = (): MatrixError => new MatrixError(403, 'M_FORBIDDEN', 'Current canonical membership authority is required');
const conflict = (): MatrixError => new MatrixError(409, 'M_CONFLICT', 'Canonical membership changed concurrently');
export function isMembershipWebId(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.trim() !== value) return false;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}
export function snapshotRoles(snapshot: CanonicalRoomSnapshot): CanonicalRoomFacts['memberRoles'] | null {
  const predicate = `${chatResource.getColumn('metadata')!.getPredicate(chatResource.config.namespace).replace(/[^/#]*$/, '')}memberRoles`;
  return snapshot.quads.some(q => q.subject.value === snapshot.metadataIri && q.predicate.value === predicate)
    ? snapshot.facts.memberRoles : null;
}
export function requireInviteManager(facts: CanonicalRoomFacts, actorWebId: string, target?: string): void {
  if ((target !== undefined && !isMembershipWebId(target)) || !facts.participants.includes(actorWebId)
    || (facts.authorWebId !== actorWebId && !['owner', 'admin'].includes(facts.memberRoles[actorWebId]))) throw forbidden();
  if (target !== undefined && facts.participants.includes(target)) throw forbidden();
  if (facts.authorWebId !== actorWebId && !facts.membershipAuthority) throw forbidden();
}

export function operationRoster(operation: MembershipOperation, actorWebId: string): { participants: string[]; memberRoles: CanonicalRoomFacts['memberRoles'] | null } {
  let participants = [...operation.expected.participants];
  let memberRoles = operation.expected.memberRoles === null ? null : { ...operation.expected.memberRoles };
  if (operation.kind === 'join') {
    participants.push(actorWebId);
    memberRoles = { ...memberRoles, [actorWebId]: 'member' };
  } else if (operation.kind === 'leave' && ['committed', 'complete'].includes(operation.phase)) {
    participants = participants.filter(value => value !== actorWebId);
    if (memberRoles) delete memberRoles[actorWebId];
  }
  return { participants, memberRoles };
}
/**
 * The ONE shared original-operation state core. `allowRecovery` is an internal extraction flag, never a
 * public capability: the normal wrapper below keeps the mandatory `ownerRecovery === null` rejection, and
 * the owner-recovery validator passes the operation's OWN immutable actor + original canonical binding.
 */
function assertOriginalState(snapshot: CanonicalRoomSnapshot, operationId: string, kind: MembershipOperation['kind'],
  actor: { webId: string; podUrl: string }, binding: MembershipAuthorityBinding | undefined, allowRecovery: boolean): MembershipOperation {
  const operation = snapshot.facts.membershipOperation;
  if (!operation || operation.kind !== kind || operation.operationId !== operationId
    || operation.actor.webId !== actor.webId || operation.actor.podUrl !== actor.podUrl
    || (!allowRecovery && operation.ownerRecovery !== null) || !isDeepStrictEqual(operation.authority, binding ?? null)
    || operation.expected.authorWebId !== snapshot.facts.authorWebId) throw conflict();
  const invitation = snapshot.facts.membershipInvitations?.[operation.targetWebId];
  if (kind === 'invite') {
    requireInviteManager(snapshot.facts, actor.webId, operation.targetWebId);
    if (operation.expected.invitation !== null || invitation?.id !== operation.operationId
      || invitation.inviterWebId !== actor.webId || invitation.createdAt !== operation.event.createdAt) throw conflict();
  } else {
    if (operation.targetWebId !== actor.webId || !binding) throw conflict();
    if (kind === 'join') {
      if (!operation.expected.invitation || operation.expected.participants.includes(actor.webId)
        || Object.prototype.hasOwnProperty.call(operation.expected.memberRoles ?? {}, actor.webId) || invitation !== undefined) throw conflict();
    } else if (actor.webId === snapshot.facts.authorWebId || !operation.expected.participants.includes(actor.webId)
      || !isDeepStrictEqual(invitation ?? null, operation.expected.invitation)) throw conflict();
  }
  const roster = operationRoster(operation, actor.webId);
  if (!isDeepStrictEqual([...roster.participants].sort(), [...snapshot.facts.participants].sort())
    || !isDeepStrictEqual(roster.memberRoles, snapshotRoles(snapshot))) throw conflict();
  return operation;
}
export function assertMembershipOperationState(snapshot: CanonicalRoomSnapshot, operationId: string,
  kind: MembershipOperation['kind'], actor: { webId: string; podUrl: string }, binding?: MembershipAuthorityBinding): MembershipOperation {
  return assertOriginalState(snapshot, operationId, kind, actor, binding, false);
}
/**
 * Owner-recovery admission over the immutable original pending operation. It reuses the SAME core
 * invariants (original actor/target/kind/phase/roster/expected, original canonical binding, join
 * invitation obligation, leave author protection) but does NOT reject an existing `ownerRecovery` and does
 * NOT compare the caller to the original intent actor. The normal wrapper keeps rejecting recovery.
 */
export function assertOwnerRecoveryOperationState(snapshot: CanonicalRoomSnapshot, operationId: string): MembershipOperation {
  const operation = snapshot.facts.membershipOperation;
  if (!operation) throw conflict();
  return assertOriginalState(snapshot, operationId, operation.kind, operation.actor, snapshot.facts.membershipAuthority, true);
}

export interface CanonicalMembershipAccess {
  readonly actor: Readonly<{ webId: string; podUrl: string }>;
  readonly binding?: MembershipAuthorityBinding;
  readonly tuple: Readonly<{ sourceIri: string; sourcePodId: string; sourceRoot: string; ownerWebId: string }>;
  assertSource(snapshot: CanonicalRoomSnapshot): void;
  read(): Promise<CanonicalRoomSnapshot>;
  executeCas(snapshot: CanonicalRoomSnapshot, changes: CanonicalRoomChanges): Promise<void>;
}
export interface MembershipObservationAccess {
  readonly actor: Readonly<{ webId: string; podUrl: string }>;
  readonly binding: MembershipAuthorityBinding;
  readonly initial: CanonicalRoomSnapshot;
  readonly roomContainer: string;
  readonly ancestors: readonly string[];
  /** Full ground-source digest of the sealed initial physical document; never caller-selected. */
  readonly expectedSourceDigest: string;
  readCanonical(signal?: AbortSignal): Promise<CanonicalRoomSnapshot>;
  readResource(iri: string, method: 'HEAD' | 'GET', signal: AbortSignal): Promise<Response>;
  allowContained(parent: string, child: string): string;
  allowPolicy(resource: string, policy: string): string;
  allowReference(policy: string, reference: string): string;
}
/**
 * Trusted remaining budgets passed INTO a privileged protocol probe. They come from the observer's
 * existing request/byte/time domain, never from a caller or JSON body. The probe reports the actual
 * physical request count (always 1) and the response bytes it consumed back to the observer.
 */
export interface MembershipProtocolProbeLimits {
  readonly requests: number;
  readonly bytes: number;
  readonly requestTimeoutMs: number;
}
export interface MembershipProtocolProbeAccounting { readonly requests: number; readonly bytes: number }
const guardedExecutors = new WeakMap<object, (guard: GuardedPolicySnapshot, changes: CanonicalRoomChanges, signal: AbortSignal) => Promise<CanonicalRoomSnapshot>>();
const policyExecutors = new WeakMap<object, (guard: GuardedPolicySnapshot, update: string, signal: AbortSignal) => Promise<void>>();
/**
 * ONE private named-owner protocol executor pair beside the existing guarded/policy executors. The
 * body, endpoint, media, nonce, source, actor and binding are ALL built inside the exact opened
 * closure; only the trusted remaining budgets and the total signal are accepted.
 */
const negotiationExecutors = new WeakMap<object, (limits: MembershipProtocolProbeLimits, signal: AbortSignal) => Promise<MembershipProtocolProbeAccounting & { declaration: AuthorizationProfileDeclaration }>>();
const observationExecutors = new WeakMap<object, (limits: MembershipProtocolProbeLimits, signal: AbortSignal) => Promise<MembershipProtocolProbeAccounting & { response: AuthorizationObservationResponse }>>();
/**
 * ONE private readonly authority-recheck executor. It re-runs the SAME frozen named-lease check as
 * every physical request (`beforeRequest`) WITHOUT any transport, so a revoked/rotated/foreign lease
 * is refused (403) before any further privileged call. The sealed access is the only key.
 */
const authorityExecutors = new WeakMap<object, (signal: AbortSignal) => Promise<void>>();
/** Internal consumer of the sealed authority recheck; no access => conflict, never a request. */
export async function recheckObservationAuthority(access: MembershipObservationAccess, signal: AbortSignal): Promise<void> {
  const executor = authorityExecutors.get(access);
  if (!executor) throw conflict();
  await executor(signal);
}
/** Internal consumer of the sealed negotiation executor; no access => conflict, never a request. */
export async function negotiateMembershipAccess(access: MembershipObservationAccess, limits: MembershipProtocolProbeLimits,
  signal: AbortSignal): Promise<MembershipProtocolProbeAccounting & { declaration: AuthorizationProfileDeclaration }> {
  const executor = negotiationExecutors.get(access);
  if (!executor) throw conflict();
  return await executor(limits, signal);
}
/** Internal consumer of the sealed A1 observation executor; no access => conflict, never a request. */
export async function observeMembershipAccess(access: MembershipObservationAccess, limits: MembershipProtocolProbeLimits,
  signal: AbortSignal): Promise<MembershipProtocolProbeAccounting & { response: AuthorizationObservationResponse }> {
  const executor = observationExecutors.get(access);
  if (!executor) throw conflict();
  return await executor(limits, signal);
}
/**
 * Internal policy-only guarded update. Only the sealed observation access and its opaque compiled
 * evidence can consume it; there is no caller-selected guard DTO or timeout. The private physical
 * write is bounded by `min(request limit, remaining sealed TTL)` and the current named lease, so it
 * can never gain a fresh whole budget after the observation TTL.
 */
export async function executeObservationPolicyUpdate(access: MembershipObservationAccess, evidence: unknown, update: string): Promise<void> {
  const sealed = membershipGuardForAccess(evidence, access);
  const executor = policyExecutors.get(access);
  if (!executor || typeof update !== 'string' || !update.trim()) throw conflict();
  const remainingMs = Number((sealed.expiresAtNs - process.hrtime.bigint()) / 1000000n);
  if (remainingMs <= 0) throw conflict();
  const bound = Math.max(1, Math.min(sealed.requestTimeoutMs, remainingMs));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new MatrixError(503, 'M_UNAVAILABLE', 'Guarded policy update exceeded its deadline')), bound);
  try { await executor(structuredClone(sealed.guard), update, controller.signal); }
  finally { clearTimeout(timer); controller.abort(); }
}
/** Internal consumer; an actual opaque observation guard is mandatory, with no caller deadline. */
export async function executeObservationGuard(access: MembershipObservationAccess, evidence: unknown,
  changes: CanonicalRoomChanges): Promise<CanonicalRoomSnapshot> {
  const sealed = membershipGuardForAccess(evidence, access);
  const executor = guardedExecutors.get(access);
  if (!executor || !changes || Object.keys(changes).some(key => !['protocols', 'participants', 'memberRoles'].includes(key))) throw conflict();
  // Never grant a fresh whole budget after the sealed TTL: enforce expiry and bound by remaining TTL.
  const remainingMs = Number((sealed.expiresAtNs - process.hrtime.bigint()) / 1000000n);
  if (remainingMs <= 0) throw conflict();
  const bound = Math.max(1, Math.min(sealed.requestTimeoutMs, remainingMs));
  const next = JSON.parse(JSON.stringify(changes)) as CanonicalRoomChanges;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new MatrixError(503, 'M_UNAVAILABLE', 'Guarded source request exceeded its deadline')), bound);
  try { return await executor(sealed.guard, next, controller.signal); }
  finally { clearTimeout(timer); controller.abort(); }
}
function assertGuardedReadback(old: CanonicalRoomSnapshot, result: CanonicalRoomSnapshot, next: CanonicalRoomChanges): void {
  const pairs = new Set<string>();
  const has = (name: keyof CanonicalRoomChanges): boolean => Object.prototype.hasOwnProperty.call(next, name);
  if (has('protocols')) pairs.add(JSON.stringify([old.metadataIri, old.protocolsQuad.predicate.value]));
  if (has('participants')) pairs.add(JSON.stringify([old.facts.sourceIri, chatResource.getColumn('participants')!.getPredicate(chatResource.config.namespace)]));
  if (has('memberRoles')) pairs.add(JSON.stringify([old.metadataIri, old.protocolsQuad.predicate.value.replace(/[^/#]*$/, 'memberRoles')]));
  const retained = (snapshot: CanonicalRoomSnapshot) => snapshot.quads.filter(quad => !pairs.has(JSON.stringify([quad.subject.value, quad.predicate.value])));
  const before = retained(old); const after = retained(result);
  if (result.metadataIri !== old.metadataIri || before.length !== after.length || before.some(quad => !after.some(other => quad.equals(other)))
    || !isDeepStrictEqual(result.protocols, has('protocols') ? next.protocols : old.protocols)
    || !isDeepStrictEqual([...result.facts.participants].sort(), [...(next.participants ?? old.facts.participants)].sort())
    || !isDeepStrictEqual(snapshotRoles(result), has('memberRoles') ? next.memberRoles : snapshotRoles(old))) throw conflict();
}
/** Reject ambiguous privileged URLs before the transport is touched. */
function checkedUrl(value: string, root: string, fragments = false): string {
  if (value.trim() !== value || /%(?:2e|2f|5c|25)/iu.test(value) || /\\/u.test(value)
    || /(?:^|\/)\.\.?(?:\/|$)/u.test(value)) throw forbidden();
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || (!fragments && url.hash)) throw forbidden();
  if (url.href !== value) throw forbidden();
  url.hash = '';
  if (!url.href.startsWith(root) || url.origin !== new URL(root).origin) throw forbidden();
  return url.href;
}
/**
 * The domain-separated operation/invitation state bound into the observation context digest. An
 * initial invitation admission without an active operation still binds an explicit kind + invitation
 * identity + current state rather than an undefined operation or an unbound wildcard.
 */
function observationContextState(initial: CanonicalRoomSnapshot, actorWebId: string, kind: 'join' | 'leave'): string[] {
  const operation = initial.facts.membershipOperation;
  if (operation) return [ 'operation', kind, operation.operationId, operation.kind, operation.phase, operation.targetWebId ];
  const invitation = initial.facts.membershipInvitations?.[actorWebId];
  if (invitation) return [ 'invitation', kind, invitation.id, String(invitation.createdAt) ];
  return [ 'none', kind ];
}
async function setup(options: MembershipSourceAccessOptions, roomId: string, incoming: MatrixStoreContext, kind: MembershipOperation['kind'], signal?: AbortSignal) {
  const checkSignal = (): void => { if (signal?.aborted) throw signal.reason; };
  checkSignal();
  const registered = await options.canonicalSource.assertActorPod(incoming);
  checkSignal();
  // Whitelist the real caller fields; injected DB/memo/service and extra context are not copied.
  const actor: MatrixStoreContext = { webId: incoming.webId, podUrl: registered.podUrl,
    auth: incoming.auth ? { ...incoming.auth } : undefined };
  const openedProof = kind === 'invite' ? undefined : await options.resolver.resolveForMembership(roomId, actor, signal);
  checkSignal();
  if (kind !== 'invite' && (!isMembershipAuthorityProof(openedProof) || openedProof.actorWebId !== actor.webId)) throw forbidden();
  const callerFacts = kind === 'invite' ? await options.resolver.readAsCaller(roomId, actor) : openedProof!.facts;
  if (kind === 'invite') requireInviteManager(callerFacts, actor.webId);
  else if (!callerFacts.membershipAuthority) throw forbidden();
  const tuple = { sourceIri: callerFacts.sourceIri, sourcePodId: callerFacts.sourcePodId,
    sourceRoot: callerFacts.sourcePodUrl, ownerWebId: callerFacts.authorWebId };
  const binding = callerFacts.membershipAuthority ? Object.freeze({ ...callerFacts.membershipAuthority }) : undefined;
  const requestSignals = new AsyncLocalStorage<AbortSignal>();
  const checkRequestSignal = (): void => { const active = requestSignals.getStore() ?? signal; if (active?.aborted) throw active.reason; };
  const beforeRequest = async(): Promise<void> => {
    checkRequestSignal();
    if (!binding) return;
    try {
      const pending = options.credentials.lease({ credentialRef: binding.credentialRef,
        ownerWebId: tuple.ownerWebId, version: binding.version, recordUsage: false });
      const active = requestSignals.getStore() ?? signal;
      // The lease lookup is readonly and has no cancellation API. Bound its await without
      // claiming to cancel it; late completion has no transport continuation.
      const lease = active ? await new Promise<Awaited<typeof pending>>((resolve, reject) => {
        const abort = (): void => { active.removeEventListener('abort', abort); reject(active.reason); };
        active.addEventListener('abort', abort, { once: true });
        pending.then(value => { active.removeEventListener('abort', abort); resolve(value); },
          error => { active.removeEventListener('abort', abort); reject(error); });
        if (active.aborted) abort();
      }) : await pending;
      if (binding.issuer !== options.issuer || lease.issuer !== binding.issuer
        || lease.ownerWebId !== tuple.ownerWebId || lease.credentialRef !== binding.credentialRef
        || lease.version !== binding.version) throw forbidden();
    } catch { checkRequestSignal(); throw forbidden(); }
    checkRequestSignal();
  };
  let read: () => Promise<CanonicalRoomSnapshot>;
  let transport: typeof fetch;
  if (binding) {
    const proof = openedProof ?? await options.resolver.resolveForMembership(roomId, actor);
    if (!isMembershipAuthorityProof(proof) || !isDeepStrictEqual(proof.binding, binding) || proof.actorWebId !== actor.webId
      || proof.transportOwnerWebId !== tuple.ownerWebId || proof.facts.sourceIri !== tuple.sourceIri
      || proof.facts.sourcePodId !== tuple.sourcePodId || proof.facts.sourcePodUrl !== tuple.sourceRoot) throw forbidden();
    await beforeRequest();
    const named = await options.podAccess.getPodFetch(tuple.ownerWebId, {
      taskCredential: { credentialRef: binding.credentialRef, version: binding.version },
      podBaseUrl: tuple.sourceRoot, beforeRequest,
    });
    checkSignal();
    if (!named) throw forbidden();
    transport = async(input, init) => {
      const active = init?.signal ?? requestSignals.getStore() ?? signal;
      const run = async(): Promise<Response> => { await beforeRequest(); checkRequestSignal(); return await named(input, { ...init, ...(active ? { signal: active } : {}), redirect: 'error' }); };
      return active ? await requestSignals.run(active, run) : await run();
    };
    const capability = await createNamedCanonicalRead({ ...tuple, binding, fetch: transport, beforeRequest });
    read = async() => await options.canonicalSource.readNamedSnapshot(roomId, capability);
  } else {
    if (tuple.ownerWebId !== actor.webId) throw forbidden();
    const caller = await options.podAccess.getPodFetch(actor.webId, {
      auth: actor.auth, podBaseUrl: tuple.sourceRoot,
    });
    if (!caller) throw forbidden();
    transport = async(input, init) => await caller(input, { ...init, redirect: 'error' });
    read = async() => await options.canonicalSource.readSnapshot(roomId, actor);
  }
  const assertSource = (snapshot: CanonicalRoomSnapshot): void => {
    const facts = snapshot.facts;
    if (facts.sourceIri !== tuple.sourceIri || facts.sourcePodId !== tuple.sourcePodId
      || facts.sourcePodUrl !== tuple.sourceRoot || facts.authorWebId !== tuple.ownerWebId
      || !isDeepStrictEqual(facts.membershipAuthority, binding)
      || (binding && facts.membershipAuthorityPublication?.state !== 'complete')) throw forbidden();
  };
  const initial = await read();
  checkSignal();
  assertSource(initial);
  if (kind === 'invite') requireInviteManager(initial.facts, actor.webId);
  if (initial.facts.membershipOperation?.ownerRecovery) throw conflict();

  const writeContext: MatrixStoreContext = binding
    ? { webId: tuple.ownerWebId, podUrl: tuple.sourceRoot,
      service: { taskCredential: { credentialRef: binding.credentialRef, version: binding.version } } }
    : { webId: actor.webId, podUrl: tuple.sourceRoot, auth: actor.auth };
  let write: ReturnType<typeof matrixPodWriteFor> | undefined;
  const canonical: CanonicalMembershipAccess = Object.freeze({ actor: Object.freeze({ webId: actor.webId, podUrl: registered.podUrl }),
    binding, tuple: Object.freeze(tuple), assertSource,
    read: async() => { const snapshot = await read(); assertSource(snapshot); return copyImmutableCanonicalRoomSnapshot(snapshot); },
    executeCas: async(snapshot: CanonicalRoomSnapshot, changes: CanonicalRoomChanges) => {
      assertSource(snapshot); await beforeRequest();
      write ??= matrixPodWriteFor(writeContext, { getPodFetch: async() => transport });
      const handle = await write;
      const document = tuple.sourceIri.split('#')[0];
      const endpoint = `${document.slice(0, document.lastIndexOf('/') + 1)}-/sparql`;
      const query = buildCanonicalRoomCas(handle.db, snapshot, changes);
      await handle.db.getDialect().executeOnResource(endpoint, { type: 'INSERT', query, prefixes: {} }, { mode: 'sparql', endpoint });
    },
  });
  return { canonical, initial: copyImmutableCanonicalRoomSnapshot(initial), beforeRequest, transport,
    getWrite: async() => { write ??= matrixPodWriteFor(writeContext, { getPodFetch: async() => transport }); return await write; },
    withRequestSignal: <T>(active: AbortSignal, action: () => Promise<T>): Promise<T> => requestSignals.run(active, action) }; 
}
export async function openCanonicalMembershipAccess(options: MembershipSourceAccessOptions, roomId: string,
  incoming: MatrixStoreContext, kind: MembershipOperation['kind']): Promise<CanonicalMembershipAccess> {
  return (await setup(options, roomId, incoming, kind)).canonical;
}
export async function openMembershipObservationAccess(options: MembershipSourceAccessOptions, roomId: string,
  incoming: MatrixStoreContext, kind: 'join' | 'leave', signal?: AbortSignal): Promise<MembershipObservationAccess> {
  const opened = await setup(options, roomId, incoming, kind, signal);
  const { canonical, beforeRequest, transport, initial } = opened;
  if (!canonical.binding) throw forbidden();
  const root = new URL(canonical.tuple.sourceRoot).href;
  const document = canonical.tuple.sourceIri.split('#')[0];
  const roomContainer = document.slice(0, document.lastIndexOf('/') + 1);
  checkedUrl(roomContainer, root);
  const ancestors: string[] = [];
  let parent = roomContainer;
  while (parent !== root) {
    parent = new URL('../', parent).href;
    checkedUrl(parent, root); ancestors.push(parent);
  }
  const allowed = new Map<string, 'container' | 'document' | 'policy'>([[roomContainer, 'container'], [document, 'document'],
    ...ancestors.map(uri => [uri, 'container'] as const)]);
  const expectedSourceDigest = digestGroundSource(canonical.tuple.sourceIri, document, initial.quads);
  const contextDigest = createHash('sha256').update(JSON.stringify([ 'a2-observation-context-v1',
    canonical.tuple.sourceIri, canonical.tuple.sourcePodId, canonical.tuple.sourceRoot, canonical.tuple.ownerWebId,
    canonical.actor.webId, canonical.actor.podUrl, canonical.binding.issuer, canonical.binding.credentialRef,
    canonical.binding.version, expectedSourceDigest, ...observationContextState(initial, canonical.actor.webId, kind) ])).digest('hex');
  const probeEndpoint = `${roomContainer}-/sparql`;
  const access: MembershipObservationAccess = Object.freeze({ actor: canonical.actor, binding: canonical.binding, initial, roomContainer, ancestors: Object.freeze(ancestors), expectedSourceDigest,
    readCanonical: async(signal?: AbortSignal) => {
      const run = async(): Promise<CanonicalRoomSnapshot> => {
        if (signal?.aborted) throw signal.reason;
        const guarded = async(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          if (signal?.aborted) throw signal.reason;
          await beforeRequest(); return await transport(input, { ...init, signal, redirect: 'error' });
        };
        const capability = await createNamedCanonicalRead({ ...canonical.tuple, binding: canonical.binding!, fetch: guarded, beforeRequest });
        const snapshot = await options.canonicalSource.readNamedSnapshot(roomId, capability);
        canonical.assertSource(snapshot); return copyImmutableCanonicalRoomSnapshot(snapshot);
      };
      return signal ? await opened.withRequestSignal(signal, run) : await run();
    },
    readResource: async(iri: string, method: 'HEAD' | 'GET', signal: AbortSignal) => await opened.withRequestSignal(signal, async() => {
      checkedUrl(iri, root);
      if (!allowed.has(iri) || (method === 'GET' && allowed.get(iri) === 'document')) throw forbidden();
      if (signal.aborted) throw signal.reason;
      await beforeRequest(); return await transport(iri, { method, signal, redirect: 'error', headers: { Accept: 'text/turtle' } });
    }),
    allowContained: (parentUri: string, child: string) => {
      if (allowed.get(parentUri) !== 'container' || !parentUri.startsWith(roomContainer)) throw forbidden();
      const uri = checkedUrl(child, root);
      const relative = uri.slice(parentUri.length);
      if (!uri.startsWith(parentUri) || !relative || relative.replace(/\/$/u, '').includes('/')) throw forbidden();
      allowed.set(uri, uri.endsWith('/') ? 'container' : 'document'); return uri;
    },
    allowPolicy: (resource: string, policy: string) => {
      if (!allowed.has(resource)) throw forbidden();
      if (/\\|%(?:2e|2f|5c|25)|(?:^|\/)\.\.?(?:\/|$)/iu.test(policy)) throw forbidden();
      const uri = checkedUrl(new URL(policy, resource).href, root, true);
      if (allowed.has(uri) && allowed.get(uri) !== 'policy') throw forbidden();
      allowed.set(uri, 'policy'); return uri;
    },
    allowReference: (policy: string, reference: string) => {
      if (allowed.get(policy) !== 'policy') throw forbidden();
      const uri = checkedUrl(reference, root, true);
      if (allowed.has(uri) && allowed.get(uri) !== 'policy') throw forbidden();
      allowed.set(uri, 'policy'); return uri;
    },
  });
  guardedExecutors.set(access, async(guard: GuardedPolicySnapshot, changes: CanonicalRoomChanges, active: AbortSignal) => await opened.withRequestSignal(active, async() => {
      if (active.aborted) throw active.reason;
      await beforeRequest();
      // Mandatory client-side current-source precheck: a receipt that is already stale at entry is
      // refused with zero native dispatch. A source change landing AFTER this precheck is still fenced
      // by the authoritative native full-source WHERE at linearization (zero effects + readback conflict).
      const current = await canonical.read();
      if (!isDeepStrictEqual(current.facts, initial.facts) || !isDeepStrictEqual(current.protocols, initial.protocols)
        || !isDeepStrictEqual(snapshotRoles(current), snapshotRoles(initial)) || current.metadataIri !== initial.metadataIri
        || current.quads.length !== initial.quads.length || initial.quads.some(quad => !current.quads.some(other => quad.equals(other)))) throw conflict();
      const handle = await opened.getWrite();
      const query = buildCanonicalRoomCas(handle.db, initial, changes);
      const endpoint = `${roomContainer}-/sparql`;
      let response: Response;
      try {
        response = await transport(endpoint, { method: 'POST', signal: active, redirect: 'error',
          headers: { 'Content-Type': GUARDED_SPARQL_MEDIA_TYPE }, body: JSON.stringify({ version: 1, update: query, guard }) });
      } catch (error) {
        if (active.aborted) throw active.reason;
        // A known refusal (revoked/foreign lease, expiry, conflict) is NOT an unknown outcome: propagate
        // it so a revoked lease yields 403 with zero native effects. Only a genuine transport error (no
        // explicit MatrixError) is the unknown 503 that keeps the operation pending.
        if (error instanceof MatrixError) throw error;
        throw new MatrixError(503, 'M_UNAVAILABLE', 'Guarded source result is unknown');
      }
      try {
        if (response.redirected || response.url !== endpoint) throw new MatrixError(503, 'M_UNAVAILABLE', 'Guarded source response URL is invalid');
        if (response.status === 409) throw conflict();
        if (response.status === 415) throw new MatrixError(415, 'M_UNSUPPORTED', 'Guarded source transport is unsupported');
        if (response.status !== 204) throw new MatrixError(503, 'M_UNAVAILABLE', 'Guarded source update was not confirmed');
      } finally { if (response.body) await response.body.cancel().catch(() => {}); }
      const result = await canonical.read();
      assertGuardedReadback(initial, result, changes);
      return copyImmutableCanonicalRoomSnapshot(result);
  }));
  policyExecutors.set(access, async(guard: GuardedPolicySnapshot, update: string, active: AbortSignal) =>
    await opened.withRequestSignal(active, async() => {
      if (active.aborted) throw active.reason;
      await beforeRequest();
      const endpoint = `${roomContainer}-/sparql`;
      let response: Response;
      try {
        response = await transport(endpoint, { method: 'POST', signal: active, redirect: 'error',
          headers: { 'Content-Type': GUARDED_SPARQL_MEDIA_TYPE }, body: JSON.stringify({ version: 1, update, guard }) });
      } catch (error) {
        if (active.aborted) throw active.reason;
        // A known refusal (revoked/foreign lease, expiry, conflict) is NOT an unknown outcome: propagate
        // it so a revoked lease yields 403 with zero native effects. Only a genuine transport error (no
        // explicit MatrixError) is the unknown 503 that keeps the operation pending.
        if (error instanceof MatrixError) throw error;
        throw new MatrixError(503, 'M_UNAVAILABLE', 'Guarded policy result is unknown');
      }
      try {
        if (response.redirected || response.url !== endpoint) throw new MatrixError(503, 'M_UNAVAILABLE', 'Guarded policy response URL is invalid');
        if (response.status === 409) throw conflict();
        if (response.status === 415) throw new MatrixError(415, 'M_UNSUPPORTED', 'Guarded policy transport is unsupported');
        if (response.status !== 204) throw new MatrixError(503, 'M_UNAVAILABLE', 'Guarded policy update was not confirmed');
      } finally { if (response.body) await response.body.cancel().catch(() => {}); }
    }));
  // ONE bounded physical probe path shared by negotiation and A1 observation. The endpoint, media,
  // nonce, body, source, actor and binding are all internal; only trusted remaining budgets and the
  // total signal enter. Bytes are checked BEFORE decoding/retaining and the physical request is really
  // cancelled/drained before any terminal outcome.
  const readProtocol = async(requestMedia: string, responseMedia: string, bodyOf: (challenge: string) => unknown,
    limits: MembershipProtocolProbeLimits, active: AbortSignal): Promise<{ responseText: string; challenge: string; bytes: number }> => {
    if (!Number.isSafeInteger(limits.requests) || limits.requests < 1 || !Number.isSafeInteger(limits.bytes) || limits.bytes < 0
      || !Number.isSafeInteger(limits.requestTimeoutMs) || limits.requestTimeoutMs <= 0) throw conflict();
    if (active.aborted) throw active.reason;
    const challenge = randomBytes(16).toString('hex');
    const body = JSON.stringify(bodyOf(challenge));
    const requestBytes = Buffer.byteLength(body, 'utf8');
    if (requestBytes > limits.bytes) throw new MatrixError(503, 'M_UNAVAILABLE', 'Authorization protocol probe exceeded its byte budget');
    const controller = new AbortController();
    const abort = (): void => controller.abort(active.reason);
    active.addEventListener('abort', abort, { once: true });
    const deadline = setTimeout(() => controller.abort(new MatrixError(503, 'M_UNAVAILABLE', 'Authorization protocol probe exceeded its deadline')), limits.requestTimeoutMs);
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      response = await transport(probeEndpoint, { method: 'POST', signal: controller.signal, redirect: 'error',
        headers: { 'Content-Type': requestMedia, Accept: responseMedia }, body });
      if (response.redirected || response.url !== probeEndpoint) throw new MatrixError(503, 'M_UNAVAILABLE', 'Authorization protocol probe response URL is invalid');
      if (response.status === 409) throw conflict();
      if (response.status === 415) throw new MatrixError(415, 'M_UNSUPPORTED', 'Authorization protocol probe is unsupported');
      if (response.status !== 200) throw new MatrixError(503, 'M_UNAVAILABLE', `Authorization protocol probe returned HTTP ${response.status}`);
      const mediaType = response.headers.get('content-type')?.split(';')[0].trim() ?? '';
      if (mediaType !== responseMedia) throw new MatrixError(503, 'M_UNAVAILABLE', 'Authorization protocol probe media is unsupported');
      let text = ''; let received = 0;
      if (response.body) {
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          if (controller.signal.aborted) throw controller.signal.reason;
          const chunk = await reader.read();
          if (chunk.done) break;
          received += chunk.value.byteLength;
          // Enforce the bounded whole body BEFORE decoding/retaining/parsing anything.
          if (requestBytes + received > limits.bytes) {
            await reader.cancel().catch(() => {});
            throw new MatrixError(503, 'M_UNAVAILABLE', 'Authorization protocol probe exceeded its byte budget');
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      return { responseText: text, challenge, bytes: received };
    } catch (error) {
      if (error instanceof MatrixError) throw error;
      if (controller.signal.aborted || active.aborted) throw new MatrixError(503, 'M_UNAVAILABLE', 'Authorization protocol probe was cancelled');
      throw new MatrixError(503, 'M_UNAVAILABLE', 'Authorization protocol probe failed');
    } finally {
      clearTimeout(deadline); active.removeEventListener('abort', abort);
      if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      else if (response?.body) await response.body.cancel().catch(() => {});
      controller.abort();
    }
  };
  negotiationExecutors.set(access, async(limits: MembershipProtocolProbeLimits, active: AbortSignal) => {
    const { responseText, challenge, bytes } = await readProtocol(AUTHORIZATION_PROFILE_NEGOTIATION_MEDIA_TYPE,
      AUTHORIZATION_PROFILE_DECLARATION_MEDIA_TYPE,
      nonce => ({ version: 1, profile: AUTHORIZATION_PROFILE_NEGOTIATION_PROFILE, sourceIri: canonical.tuple.sourceIri,
        expectedSourceDigest, targetWebId: canonical.actor.webId, contextDigest, challenge: nonce }), limits, active);
    let declaration: AuthorizationProfileDeclaration;
    try { declaration = parseAuthorizationProfileDeclaration(JSON.parse(responseText)); }
    catch { throw new MatrixError(503, 'M_UNAVAILABLE', 'Authorization profile declaration is malformed'); }
    if (declaration.requesterWebId !== canonical.tuple.ownerWebId || declaration.targetWebId !== canonical.actor.webId
      || declaration.sourceIri !== canonical.tuple.sourceIri || declaration.sourceDigest !== expectedSourceDigest
      || declaration.contextDigest !== contextDigest || declaration.challenge !== challenge) {
      throw new MatrixError(503, 'M_UNAVAILABLE', 'Authorization profile declaration does not echo the sealed request');
    }
    return { requests: 1, bytes, declaration };
  });
  observationExecutors.set(access, async(limits: MembershipProtocolProbeLimits, active: AbortSignal) => {
    const { responseText, challenge, bytes } = await readProtocol(AUTHORIZATION_OBSERVATION_MEDIA_TYPE,
      AUTHORIZATION_OBSERVATION_MEDIA_TYPE,
      nonce => ({ version: 1, profile: AUTHORIZATION_OBSERVATION_PROFILE, sourceIri: canonical.tuple.sourceIri,
        expectedSourceDigest, targetWebId: canonical.actor.webId, contextDigest, challenge: nonce }), limits, active);
    let response: AuthorizationObservationResponse;
    try { response = parseAuthorizationObservationResponse(JSON.parse(responseText)); }
    catch { throw new MatrixError(503, 'M_UNAVAILABLE', 'Authorization observation response is malformed'); }
    if (response.requesterWebId !== canonical.tuple.ownerWebId || response.targetWebId !== canonical.actor.webId
      || response.sourceIri !== canonical.tuple.sourceIri || response.sourceDigest !== expectedSourceDigest
      || response.contextDigest !== contextDigest || response.challenge !== challenge) {
      throw new MatrixError(503, 'M_UNAVAILABLE', 'Authorization observation response does not echo the sealed request');
    }
    if (response.guard.profile !== 'acp-ground-v1') throw new MatrixError(415, 'M_UNSUPPORTED', 'Authorization observation requires the ACP guarded profile');
    return { requests: 1, bytes, response };
  });
  authorityExecutors.set(access, async(active: AbortSignal) =>
    await opened.withRequestSignal(active, async() => {
      if (active.aborted) throw active.reason;
      await beforeRequest();
    }));
  return access;
}
