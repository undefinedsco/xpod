import { isDeepStrictEqual } from 'node:util';
import type { PodAccessFetchProvider } from '../ai-gateway/pod/OwnerPodAccess';
import { isSolidAuth } from '../auth/AuthContext';
import { copyImmutableCanonicalRoomSnapshot, parseMembershipAuthorityBinding,
  type CanonicalRoomFacts, type CanonicalRoomSnapshot, type MembershipAuthorityBinding } from './canonicalRoomSource';
import { buildCanonicalRoomCas, type CanonicalRoomChanges } from './canonicalRoomCas';
import { parseMembershipOperation, type MembershipOperation } from './membershipOperation';
import { openCanonicalMembershipAccess, assertMembershipOperationState, assertOwnerRecoveryOperationState,
  operationRoster, snapshotRoles,
  requireInviteManager, type MembershipSourceAccessOptions } from './membershipSourceAccess';
import { assertMembershipReadDeltaEvidence, executeMembershipReadDeltaCas,
  membershipReadDeltaGrant } from './membershipPolicyMutation';
import { parseMembershipReadGrant, type MembershipReadGrants } from './membershipReadGrant';
import { digestGroundSource } from '../../storage/rdf/GuardedPolicySnapshot';
import { matrixPodWriteFor } from './podAccess';
import type { MatrixStoreContext } from './types';
import { MatrixError } from './MatrixError';

export interface MembershipSourceEvidence { readonly facts: CanonicalRoomFacts }
export interface InviteIntent { operationId: string; createdAt: number; targetWebId: string }
export interface MembershipPhaseIntent { operationId: string; createdAt: number }
interface MembershipSourcePort {
  readonly actor: Readonly<{ webId: string; podUrl: string }>;
  readCurrent(): Promise<MembershipSourceEvidence>;
  confirmOperation(expected: MembershipSourceEvidence, operationId: string): Promise<MembershipSourceEvidence>;
}
export interface MembershipInviteSourcePort extends MembershipSourcePort {
  reserveInvite(expected: MembershipSourceEvidence, intent: InviteIntent): Promise<MembershipSourceEvidence>;
  completeInvite(expected: MembershipSourceEvidence, operationId: string): Promise<MembershipSourceEvidence>;
}
/** Internal phase primitives only: neither ACL effects nor actor-PDU persistence are proved here. */
export interface MembershipJoinSourcePort extends MembershipSourcePort {
  reserveJoin(expected: MembershipSourceEvidence, intent: MembershipPhaseIntent): Promise<MembershipSourceEvidence>;
  markJoinReadGranted(expected: MembershipSourceEvidence, operationId: string, evidence: object): Promise<MembershipSourceEvidence>;
  completeJoin(expected: MembershipSourceEvidence, operationId: string): Promise<MembershipSourceEvidence>;
}
export interface MembershipLeaveSourcePort extends MembershipSourcePort {
  reserveLeave(expected: MembershipSourceEvidence, intent: MembershipPhaseIntent): Promise<MembershipSourceEvidence>;
  markLeaveReadRemoved(expected: MembershipSourceEvidence, operationId: string, evidence: object): Promise<MembershipSourceEvidence>;
  commitLeaveRoster(expected: MembershipSourceEvidence, operationId: string): Promise<MembershipSourceEvidence>;
  completeLeave(expected: MembershipSourceEvidence, operationId: string): Promise<MembershipSourceEvidence>;
}
export type CanonicalMembershipSourceOptions = MembershipSourceAccessOptions;
/** Explicit generation+replacement-binding intent for the owner-authenticated recovery marker. */
export interface OwnerRecoveryIntent { generation: number; binding: MembershipAuthorityBinding }
/**
 * Owner-authenticated recovery port. It is deliberately NOT the member source port: `actor` is the real
 * owner caller, the original operation actor/target are never fabricated as caller credentials, and no
 * ReadDelta/ACL/PDU/phase capability is exposed. Only an exact-source CAS stamp is available.
 */
export interface MembershipOwnerRecoverySourcePort {
  readonly actor: Readonly<{ webId: string; podUrl: string }>;
  readCurrent(): Promise<MembershipSourceEvidence>;
  beginOwnerRecovery(expected: MembershipSourceEvidence, operationId: string, intent: OwnerRecoveryIntent): Promise<MembershipSourceEvidence>;
}
const forbidden = (): MatrixError => new MatrixError(403, 'M_FORBIDDEN', 'Current canonical invitation authority is required');
const conflict = (): MatrixError => new MatrixError(409, 'M_CONFLICT', 'Canonical invitation changed concurrently');
export { isMembershipWebId, requireInviteManager } from './membershipSourceAccess';

/** Exact source effects only. No source-owner transport is exposed to the actor projection. */
export class CanonicalMembershipSource {
  public constructor(private readonly options: CanonicalMembershipSourceOptions) {}

  public async open(roomId: string, incoming: MatrixStoreContext): Promise<MembershipInviteSourcePort> {
    return await this.openSource(roomId, incoming, 'invite') as MembershipInviteSourcePort;
  }
  public async openForJoin(roomId: string, incoming: MatrixStoreContext): Promise<MembershipJoinSourcePort> {
    return await this.openSource(roomId, incoming, 'join') as MembershipJoinSourcePort;
  }
  public async openForLeave(roomId: string, incoming: MatrixStoreContext): Promise<MembershipLeaveSourcePort> {
    return await this.openSource(roomId, incoming, 'leave') as MembershipLeaveSourcePort;
  }
  /**
   * Owner-authenticated recovery marker port. Only the exact original source author, reading/writing with
   * their own Solid caller session on the registered source Pod, may stamp the existing pending member
   * operation's `ownerRecovery`. It rotates NO global binding/publication, mutates NO ACL/ACP/PDU, and
   * exposes no phase/ReadDelta capability. The replacement binding is validated against the current named
   * lease before every physical attempt and the final readback; the caller identity is never rewritten to
   * the original intent actor.
   */
  public async openForOwnerRecovery(roomId: string, ownerCaller: MatrixStoreContext): Promise<MembershipOwnerRecoverySourcePort> {
    const auth = ownerCaller.auth;
    if (ownerCaller.service || !auth || !isSolidAuth(auth) || auth.webId !== ownerCaller.webId) throw forbidden();
    const registered = await this.options.canonicalSource.assertActorPod(ownerCaller);
    const read = async(): Promise<CanonicalRoomSnapshot> =>
      copyImmutableCanonicalRoomSnapshot(await this.options.canonicalSource.readSnapshot(roomId, ownerCaller));
    const initial = await read();
    if (initial.facts.authorWebId !== ownerCaller.webId) throw forbidden();
    const evidence = new WeakMap<object, CanonicalRoomSnapshot>();
    // A pre-write handle is consumed by the first beginOwnerRecovery call (synchronously, before any
    // await), so a known conflict/refusal/unknown can never be retried with the same old snapshot, and
    // two concurrent uses of one writable handle cannot both proceed. A NEW controlled readCurrent is
    // required for any further attempt.
    const usedEvidence = new WeakSet<object>();
    const seal = (snapshot: CanonicalRoomSnapshot): MembershipSourceEvidence => {
      const copy = copyImmutableCanonicalRoomSnapshot(snapshot);
      const handle = Object.freeze({ facts: copy.facts });
      evidence.set(handle, copy);
      return handle;
    };
    const expectedSnapshot = (handle: MembershipSourceEvidence): CanonicalRoomSnapshot => {
      const snapshot = evidence.get(handle);
      if (!snapshot) throw conflict();
      return snapshot;
    };
    // Full ground-source digest: the complete physical RDF SET including unrelated raw quads.
    const sourceDigest = (snapshot: CanonicalRoomSnapshot): string =>
      digestGroundSource(snapshot.facts.sourceIri, snapshot.facts.sourceIri.split('#')[0], snapshot.quads);
    // Explicit new binding: exact configured issuer + current active exact owner/ref/version lease.
    const validateBinding = async(binding: MembershipAuthorityBinding): Promise<void> => {
      if (binding.issuer !== this.options.issuer) throw forbidden();
      try {
        const lease = await this.options.credentials.lease({ credentialRef: binding.credentialRef,
          ownerWebId: ownerCaller.webId, version: binding.version, recordUsage: false });
        if (lease.credentialRef !== binding.credentialRef || lease.ownerWebId !== ownerCaller.webId
          || lease.version !== binding.version || lease.issuer !== this.options.issuer) throw forbidden();
      } catch { throw forbidden(); }
    };
    // ONE exact full-raw-source CAS through the existing ORM serializer/server conditional path.
    const stamp = async(snapshot: CanonicalRoomSnapshot, protocols: Record<string, unknown>,
      binding: MembershipAuthorityBinding): Promise<CanonicalRoomSnapshot> => {
      const beforeRequest = async(): Promise<void> => { await validateBinding(binding); };
      await beforeRequest();
      const context: MatrixStoreContext = { webId: ownerCaller.webId, podUrl: snapshot.facts.sourcePodUrl, auth };
      const provider: PodAccessFetchProvider = { getPodFetch: async(owner, request) =>
        await this.options.podAccess.getPodFetch(owner, { ...request, beforeRequest }) };
      const write = await matrixPodWriteFor(context, provider);
      const query = buildCanonicalRoomCas(write.db, snapshot, { protocols });
      const document = snapshot.facts.sourceIri.split('#')[0];
      const endpoint = `${document.slice(0, document.lastIndexOf('/') + 1)}-/sparql`;
      try {
        await write.db.getDialect().executeOnResource(endpoint, { type: 'INSERT', query, prefixes: {} }, { mode: 'sparql', endpoint });
      } catch (error) {
        // A known refusal (403/409/415) propagates; a real post-commit response loss is an UNKNOWN
        // outcome and must be reported as 503, never adopted as a successful stamp.
        if (error instanceof MatrixError) throw error;
        throw new MatrixError(503, 'M_UNAVAILABLE', 'Owner recovery stamp result is unknown');
      }
      // The explicit replacement lease is validated again before AND after the final readback, so a
      // revocation landing after the real commit is still refused.
      await beforeRequest();
      const confirmed = await read();
      await beforeRequest();
      return confirmed;
    };
    const readCurrent = async(): Promise<MembershipSourceEvidence> => seal(await read());
    const beginOwnerRecovery = async(expected: MembershipSourceEvidence, operationId: string,
      intent: OwnerRecoveryIntent): Promise<MembershipSourceEvidence> => {
      const binding = parseMembershipAuthorityBinding(intent.binding);
      if (!binding || !Number.isSafeInteger(intent.generation) || intent.generation <= 0) {
        throw new MatrixError(400, 'M_INVALID_PARAM', 'Invalid owner recovery intent');
      }
      // Consume the exact handle before any await (one writable use per minted evidence).
      if (usedEvidence.has(expected)) throw conflict();
      usedEvidence.add(expected);
      const snapshot = expectedSnapshot(expected);
      const facts = snapshot.facts;
      if (facts.authorWebId !== ownerCaller.webId) throw forbidden();
      // Reuse the ONE shared original-operation core: original actor/target/kind/phase/roster/expected,
      // original canonical binding, join invitation obligation and leave author protection. Normal
      // `assertMembershipOperationState` keeps rejecting an existing recovery marker.
      const operation = assertOwnerRecoveryOperationState(snapshot, operationId);
      if (operation.phase === 'complete') throw conflict();
      // The immutable original intent actor's Pod must be a currently registered Pod. Registration only:
      // the owner caller identity is never changed and the actor is never authenticated as the caller.
      await this.options.canonicalSource.assertRegisteredActorPod({ webId: operation.actor.webId, podUrl: operation.actor.podUrl });
      const current = operation.ownerRecovery;
      const currentGeneration = current?.generation ?? null;
      if (currentGeneration === null) {
        if (intent.generation !== 1) throw conflict();
      } else if (intent.generation < currentGeneration || intent.generation > currentGeneration + 1) {
        throw conflict();
      } else if (intent.generation === currentGeneration) {
        // Idempotent confirm: the SAME currently persisted generation+binding only. A NEW controlled read
        // must mint the returned evidence, and the current lease is validated; no native mutation. The
        // handed evidence must match the CURRENT complete physical source exactly (including unrelated
        // raw quads): an identical marker over a changed source is stale and never promoted.
        if (!isDeepStrictEqual(current!.binding, binding)) throw conflict();
        await validateBinding(binding);
        const fresh = await read();
        if (sourceDigest(snapshot) !== sourceDigest(fresh)) throw conflict();
        const freshOperation = fresh.facts.membershipOperation;
        if (!freshOperation || freshOperation.operationId !== operationId || !freshOperation.ownerRecovery
          || freshOperation.ownerRecovery.generation !== intent.generation
          || !isDeepStrictEqual(freshOperation.ownerRecovery.binding, binding)) throw conflict();
        await validateBinding(binding);
        return seal(fresh);
      }
      await validateBinding(binding);
      const protocols = structuredClone(snapshot.protocols);
      const matrix = protocols.matrix as Record<string, unknown>;
      matrix.membershipOperation = { ...(matrix.membershipOperation as Record<string, unknown>),
        ownerRecovery: { generation: intent.generation, binding: { ...binding } } };
      const confirmed = await stamp(snapshot, protocols, binding);
      // Exact final readback: the complete requested protocols (every original operation field +
      // ownerRecovery + preserved global authority/publication/grants) must equal, and ALL retained
      // original raw RDF quads must survive with full term identity. A post-commit unrelated raw quad or
      // an original event-time change makes this 409 and leaves the committed stamp pending (no adoption).
      if (!isDeepStrictEqual(confirmed.protocols, protocols)) throw conflict();
      const confirmedOperation = confirmed.facts.membershipOperation;
      if (!confirmedOperation || confirmedOperation.operationId !== operationId || !confirmedOperation.ownerRecovery
        || confirmedOperation.ownerRecovery.generation !== intent.generation
        || !isDeepStrictEqual(confirmedOperation.ownerRecovery.binding, binding)) throw conflict();
      const retainedConfirmed = confirmed.quads.filter(quad => !quad.equals(confirmed.protocolsQuad));
      const retainedSealed = snapshot.quads.filter(quad => !quad.equals(snapshot.protocolsQuad));
      if (retainedConfirmed.length !== retainedSealed.length
        || retainedSealed.some(quad => !retainedConfirmed.some(actual => actual.equals(quad)))) throw conflict();
      return seal(confirmed);
    };
    return Object.freeze({ actor: Object.freeze({ webId: ownerCaller.webId, podUrl: registered.podUrl }),
      readCurrent, beginOwnerRecovery });
  }
  private async openSource(roomId: string, incoming: MatrixStoreContext, kind: MembershipOperation['kind'])
    : Promise<MembershipInviteSourcePort | MembershipJoinSourcePort | MembershipLeaveSourcePort> {
    const access = await openCanonicalMembershipAccess(this.options, roomId, incoming, kind);
    const { actor, binding, read, assertSource } = access;
    const registered = { podUrl: actor.podUrl };
    const evidence = new WeakMap<object, CanonicalRoomSnapshot>();
    const seal = (snapshot: CanonicalRoomSnapshot): MembershipSourceEvidence => {
      assertSource(snapshot);
      const privateSnapshot = copyImmutableCanonicalRoomSnapshot(snapshot);
      const handle = Object.freeze({ facts: privateSnapshot.facts });
      evidence.set(handle, privateSnapshot);
      return handle;
    };
    const expectedSnapshot = (handle: MembershipSourceEvidence): CanonicalRoomSnapshot => {
      const snapshot = evidence.get(handle);
      if (!snapshot) throw conflict();
      return snapshot;
    };
    const assertOperation = (snapshot: CanonicalRoomSnapshot, operationId: string): MembershipOperation =>
      assertMembershipOperationState(snapshot, operationId, kind, actor, binding);
    const assertStableSource = (previous: CanonicalRoomSnapshot, current: CanonicalRoomSnapshot, changes: CanonicalRoomChanges = {}): void => {
      assertSource(current);
      if (current.metadataIri !== previous.metadataIri
        || !isDeepStrictEqual([...current.facts.participants].sort(), [...(changes.participants ?? previous.facts.participants)].sort())
        || !isDeepStrictEqual(snapshotRoles(current), Object.prototype.hasOwnProperty.call(changes, 'memberRoles') ? changes.memberRoles : snapshotRoles(previous))) throw conflict();
    };
    const replace = async(snapshot: CanonicalRoomSnapshot, operation: MembershipOperation,
      invitations = snapshot.facts.membershipInvitations ?? {}, changes: CanonicalRoomChanges = {},
      grants: MembershipReadGrants | undefined = snapshot.facts.membershipReadGrants): Promise<MembershipSourceEvidence> => {
      const protocols = structuredClone(snapshot.protocols);
      protocols.matrix = { ...(protocols.matrix as Record<string, unknown>),
        membershipInvitations: invitations, membershipOperation: operation,
        ...(grants === undefined ? {} : { membershipReadGrants: grants }) };
      let failure: unknown;
      try { await access.executeCas(snapshot, { ...changes, protocols }); }
      catch (error) { failure = error; }
      // An explicit 409/415 is terminal: never adopt a same-looking winner from a later readback.
      if (failure instanceof MatrixError && (failure.status === 409 || failure.status === 415)) throw failure;
      const confirmed = await read();
      assertStableSource(snapshot, confirmed, changes);
      if (!isDeepStrictEqual(confirmed.protocols, protocols)) { if (failure) throw failure; throw conflict(); }
      assertOperation(confirmed, operation.operationId);
      return seal(confirmed);
    };
    const reserveMember = async(expected: MembershipSourceEvidence, intent: MembershipPhaseIntent): Promise<MembershipSourceEvidence> => {
      const snapshot = expectedSnapshot(expected);
      const facts = snapshot.facts;
      if (kind === 'invite' || !binding) throw forbidden();
      if (facts.membershipOperation && (facts.membershipOperation.phase !== 'complete' || facts.membershipOperation.ownerRecovery)) throw conflict();
      const roles = snapshotRoles(snapshot);
      const invitation = facts.membershipInvitations?.[actor.webId] ?? null;
      if (kind === 'join') {
        if (facts.participants.includes(actor.webId) || Object.prototype.hasOwnProperty.call(roles ?? {}, actor.webId) || !invitation) throw forbidden();
      } else if (!facts.participants.includes(actor.webId) || actor.webId === facts.authorWebId) throw forbidden();
      const operation = parseMembershipOperation({ format: 1, operationId: intent.operationId, kind,
        phase: kind === 'join' ? 'join-read-pending' : 'leave-read-pending',
        actor: { webId: actor.webId, podUrl: registered.podUrl }, targetWebId: actor.webId, authority: binding,
        expected: { authorWebId: facts.authorWebId, participants: [...facts.participants], memberRoles: roles, invitation },
        event: { createdAt: intent.createdAt, content: { membership: kind } }, ownerRecovery: null });
      if (!operation) throw new MatrixError(400, 'M_INVALID_PARAM', 'Invalid membership intent');
      const invitations = { ...facts.membershipInvitations };
      if (kind === 'join') delete invitations[actor.webId];
      // Reserve a durable, operation-bound authorization IRI inside the SAME reserveJoin CAS. A
      // byte-identical pre-existing node shares only the spelling, never this distinct IRI.
      const grants = { ...facts.membershipReadGrants };
      if (kind === 'join') {
        const reserved = parseMembershipReadGrant({ actorWebId: actor.webId, sourceIri: facts.sourceIri,
          joinOperationId: operation.operationId, authorPodUrl: { webId: facts.authorWebId, podUrl: facts.sourcePodUrl },
          binding, createdAt: operation.event.createdAt, state: 'reserved' });
        if (!reserved) throw new MatrixError(500, 'M_UNKNOWN', 'Membership Read grant reservation is malformed');
        grants[actor.webId] = reserved;
      }
      return await replace(snapshot, operation, invitations, kind === 'join' ? operationRoster(operation, actor.webId) : {},
        kind === 'join' ? grants : undefined);
    };
    const advance = async(expected: MembershipSourceEvidence, operationId: string, from: MembershipOperation['phase'],
      to: MembershipOperation['phase']): Promise<MembershipSourceEvidence> => {
      const snapshot = expectedSnapshot(expected);
      const operation = assertOperation(snapshot, operationId);
      if (operation.phase !== from) throw conflict();
      const next = { ...operation, phase: to };
      return await replace(snapshot, next, snapshot.facts.membershipInvitations ?? {},
        kind === 'leave' && to === 'committed' ? operationRoster(next, actor.webId) : {});
    };
    /**
     * Evidence-gated phase mark: whole-history guarded source CAS carrying the post-delta closure.
     * A strict-unknown outcome is never adopted as a receipt: if the guarded CAS cannot be
     * confirmed (transport lost/unknown) the mark throws and the caller must recover through a
     * fresh controlled reopen that reads the exact canonical operation. Generic reserve/roster/
     * complete CAS keep their original exact-committed-winner recovery.
     */
    const guardedAdvance = async(expected: MembershipSourceEvidence, operationId: string,
      from: MembershipOperation['phase'], to: MembershipOperation['phase'], evidence: object): Promise<MembershipSourceEvidence> => {
      const snapshot = expectedSnapshot(expected);
      assertMembershipReadDeltaEvidence(evidence, { kind: kind as 'join' | 'leave', operationId,
        actorWebId: actor.webId, targetWebId: actor.webId, binding, snapshot });
      const operation = assertOperation(snapshot, operationId);
      if (operation.phase !== from) throw conflict();
      const reservation = snapshot.facts.membershipReadGrants?.[actor.webId];
      const bound = membershipReadDeltaGrant(evidence);
      if (kind === 'join') {
        // Install the durable receipt under the same guarded canonical CAS (never after an
        // unguarded update). The reservation is the CURRENT pending join's own distinct IRI.
        if (!reservation || reservation.state !== 'reserved' || reservation.joinOperationId !== operationId) throw conflict();
      } else if (reservation?.state === 'installed') {
        if (!reservation.authorizationIri || reservation.authorizationIri !== bound.authorizationIri) throw conflict();
      }
      const next = { ...operation, phase: to };
      const protocols = structuredClone(snapshot.protocols);
      const grants: MembershipReadGrants = { ...snapshot.facts.membershipReadGrants };
      if (kind === 'join' && reservation) {
        // Explicit profile is installed atomically with policy/root inside the same guarded source CAS;
        // it is never inferred later from an IRI/suffix.
        grants[actor.webId] = { ...reservation, state: 'installed',
          policyIri: bound.policyIri, authorizationIri: bound.authorizationIri, readProfile: bound.readProfile };
      }
      protocols.matrix = { ...(protocols.matrix as Record<string, unknown>),
        membershipInvitations: snapshot.facts.membershipInvitations ?? {}, membershipOperation: next,
        ...(Object.keys(grants).length ? { membershipReadGrants: grants } : {}) };
      const confirmed = await executeMembershipReadDeltaCas(evidence, { protocols });
      assertStableSource(snapshot, confirmed);
      if (!isDeepStrictEqual(confirmed.protocols, protocols)) throw conflict();
      assertOperation(confirmed, operationId);
      return seal(confirmed);
    };
    const complete = async(expected: MembershipSourceEvidence, operationId: string): Promise<MembershipSourceEvidence> => {
      const snapshot = expectedSnapshot(expected);
      const operation = assertOperation(snapshot, operationId);
      if (operation.phase === 'complete') {
        const current = await read();
        assertStableSource(snapshot, current);
        if (!isDeepStrictEqual(current.protocols, snapshot.protocols)) throw conflict();
        assertOperation(current, operationId);
        return seal(current);
      }
      return await advance(expected, operationId, 'committed', 'complete');
    };
    const base = { actor: Object.freeze({ webId: actor.webId, podUrl: registered.podUrl }),
      readCurrent: async() => seal(await read()),
      confirmOperation: async(expected: MembershipSourceEvidence, operationId: string) => {
        const snapshot = expectedSnapshot(expected);
        if (snapshot.facts.membershipOperation?.operationId !== operationId) throw conflict();
        assertOperation(snapshot, operationId);
        const current = await read();
        assertStableSource(snapshot, current);
        if (!isDeepStrictEqual(current.facts, snapshot.facts) || !isDeepStrictEqual(current.protocols, snapshot.protocols)
          || !isDeepStrictEqual(snapshotRoles(current), snapshotRoles(snapshot))) throw conflict();
        return seal(current);
      },
    };
    if (kind === 'invite') return Object.freeze({ ...base,
      reserveInvite: async(expected: MembershipSourceEvidence, intent: InviteIntent) => {
        const snapshot = expectedSnapshot(expected);
        requireInviteManager(snapshot.facts, actor.webId, intent.targetWebId);
        if (snapshot.facts.membershipOperation?.phase !== undefined
          && (snapshot.facts.membershipOperation.phase !== 'complete' || snapshot.facts.membershipOperation.ownerRecovery)) throw conflict();
        if (snapshot.facts.membershipInvitations?.[intent.targetWebId]) throw conflict();
        const operation = parseMembershipOperation({ format: 1, operationId: intent.operationId, kind: 'invite', phase: 'committed',
          actor: { webId: actor.webId, podUrl: registered.podUrl }, targetWebId: intent.targetWebId, authority: binding ?? null,
          expected: { authorWebId: snapshot.facts.authorWebId, participants: [...snapshot.facts.participants],
            memberRoles: snapshotRoles(snapshot),
            invitation: null }, event: { createdAt: intent.createdAt, content: { membership: 'invite' } }, ownerRecovery: null });
        if (!operation) throw new MatrixError(400, 'M_INVALID_PARAM', 'Invalid invitation intent');
        return await replace(snapshot, operation, { ...snapshot.facts.membershipInvitations,
          [intent.targetWebId]: { id: operation.operationId, inviterWebId: actor.webId, createdAt: operation.event.createdAt } });
      },
      completeInvite: complete,
    });
    if (kind === 'join') return Object.freeze({ ...base,
      reserveJoin: reserveMember,
      markJoinReadGranted: async(expected: MembershipSourceEvidence, id: string, evidence: object) =>
        await guardedAdvance(expected, id, 'join-read-pending', 'committed', evidence),
      completeJoin: complete,
    });
    return Object.freeze({ ...base,
      reserveLeave: reserveMember,
      markLeaveReadRemoved: async(expected: MembershipSourceEvidence, id: string, evidence: object) =>
        await guardedAdvance(expected, id, 'leave-read-pending', 'leave-roster-pending', evidence),
      commitLeaveRoster: async(expected: MembershipSourceEvidence, id: string) => {
        // Roster commit also retires this actor's durable Read-grant receipt; other actors'.
        const snapshot = expectedSnapshot(expected);
        const operation = assertOperation(snapshot, id);
        if (operation.phase !== 'leave-roster-pending') throw conflict();
        const grants: MembershipReadGrants = { ...snapshot.facts.membershipReadGrants };
        delete grants[actor.webId];
        const next = { ...operation, phase: 'committed' as const };
        return await replace(snapshot, next, snapshot.facts.membershipInvitations ?? {}, operationRoster(next, actor.webId), grants);
      },
      completeLeave: complete,
    });
  }
}
