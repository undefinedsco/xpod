import { isDeepStrictEqual } from 'node:util';
import { CanonicalMembershipSource, isMembershipWebId, requireInviteManager,
  type MembershipInviteSourcePort, type MembershipSourceEvidence } from './canonicalMembershipSource';
import type { MembershipOperation } from './membershipOperation';
import { generateEventId } from './eventIdentity';
import { MatrixError } from './MatrixError';
import type { MatrixEventRecord, MatrixStoreContext } from './types';

/** Trusted internal actor-Pod adapter. It must read the exact winner before any append/journal;
 * prove registered actor Pod, actual RDF maker and IRI; preserve the first persistent full PDU.
 * existingOnly is a lawful read only, with no journal/write/queue. No source-owner fetch is supplied.
 * Concurrent append conflicts may adopt only the strict first persistent winner of this intent.
 */
export type MembershipInviteProjectEvent = (input: {
  roomId: string; operation: Readonly<MembershipOperation>; actor: MatrixStoreContext;
  existingOnly: boolean; validateCommitted(record: MatrixEventRecord): Promise<void>;
}) => Promise<MatrixEventRecord>;
export type MembershipInviteResult = { kind: 'invited'; event: MatrixEventRecord } | { kind: 'already-invited' };
export interface MembershipLifecycleOptions {
  source: Pick<CanonicalMembershipSource, 'open'>;
  now?: () => number;
  eventId?: () => string;
}
const conflict = (): MatrixError => new MatrixError(409, 'M_CONFLICT', 'The original invitation could not be confirmed');

/** Foundation only: no route, ACL, queue or ordinary membership gates are enabled here. */
export class MembershipLifecycle {
  public constructor(private readonly options: MembershipLifecycleOptions) {}

  public async invite(roomId: string, targetWebId: string, incoming: MatrixStoreContext,
    projectEvent: MembershipInviteProjectEvent): Promise<MembershipInviteResult> {
    if (!isMembershipWebId(targetWebId)) throw new MatrixError(400, 'M_INVALID_PARAM', 'An exact full HTTP WebID is required');
    if (typeof projectEvent !== 'function') throw conflict();
    const port = await this.options.source.open(roomId, incoming);
    const actor: MatrixStoreContext = { webId: port.actor.webId, podUrl: port.actor.podUrl,
      auth: incoming.auth ? { ...incoming.auth } : undefined };
    let evidence = await port.readCurrent();
    requireInviteManager(evidence.facts, actor.webId, targetWebId);
    let operation = evidence.facts.membershipOperation;
    if (operation && operation.phase !== 'complete') {
      if (operation.kind !== 'invite' || operation.phase !== 'committed' || operation.actor.webId !== actor.webId
        || operation.actor.podUrl !== actor.podUrl || operation.targetWebId !== targetWebId) throw conflict();
      return await this.resume(roomId, actor, port, evidence, operation, projectEvent);
    }
    if (evidence.facts.membershipInvitations?.[targetWebId]) return { kind: 'already-invited' };
    evidence = await port.reserveInvite(evidence, { operationId: (this.options.eventId ?? generateEventId)(),
      createdAt: (this.options.now ?? Date.now)(), targetWebId });
    operation = evidence.facts.membershipOperation;
    if (!operation) throw conflict();
    return await this.resume(roomId, actor, port, evidence, operation, projectEvent);
  }

  private async resume(roomId: string, actor: MatrixStoreContext, port: MembershipInviteSourcePort,
    evidence: MembershipSourceEvidence, operation: MembershipOperation,
    projectEvent: MembershipInviteProjectEvent): Promise<MembershipInviteResult> {
    const invitation = evidence.facts.membershipInvitations?.[operation.targetWebId];
    if (operation.kind !== 'invite' || operation.phase !== 'committed' || operation.ownerRecovery !== null
      || operation.expected.authorWebId !== evidence.facts.authorWebId
      || !isDeepStrictEqual([...operation.expected.participants].sort(), [...evidence.facts.participants].sort())
      || !isDeepStrictEqual(operation.expected.memberRoles ?? {}, evidence.facts.memberRoles)
      || !isDeepStrictEqual(operation.authority, evidence.facts.membershipAuthority ?? null)
      || operation.expected.invitation !== null
      || invitation?.id !== operation.operationId || invitation.inviterWebId !== operation.actor.webId
      || invitation.createdAt !== operation.event.createdAt) throw conflict();
    const event = await this.project(roomId, actor, operation, false, projectEvent, async() => {
      await port.confirmOperation(evidence, operation.operationId);
    });
    await port.completeInvite(evidence, operation.operationId);
    return { kind: 'invited', event };
  }

  private async project(roomId: string, actor: MatrixStoreContext, operation: MembershipOperation,
    existingOnly: boolean, projectEvent: MembershipInviteProjectEvent, confirmCurrent: () => Promise<void>): Promise<MatrixEventRecord> {
    if (typeof projectEvent !== 'function') throw conflict();
    const validateCommitted = async(record: MatrixEventRecord): Promise<void> => {
      const event = record.event;
      if (record.eventId !== operation.operationId || record.roomId !== roomId || record.type !== 'm.room.member'
        || record.sender !== operation.actor.webId || record.originServerTs !== operation.event.createdAt
        || record.stateKey !== operation.targetWebId || !isDeepStrictEqual(record.content, operation.event.content)
        || !event || event.event_id !== operation.operationId || event.room_id !== roomId
        || event.type !== 'm.room.member' || event.sender !== operation.actor.webId
        || event.state_key !== operation.targetWebId || event.origin_server_ts !== operation.event.createdAt
        || !isDeepStrictEqual(event.content, operation.event.content)) throw conflict();
      await confirmCurrent();
    };
    try {
      // The adapter may persist before invoking its winner validator. Prove this phase first too.
      await confirmCurrent();
      const record = await projectEvent({ roomId, operation, actor, existingOnly, validateCommitted });
      await validateCommitted(record);
      return record;
    } catch { throw conflict(); }
  }
}
