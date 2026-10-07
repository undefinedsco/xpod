import type { SolidDatabase } from '@undefineds.co/drizzle-solid';
import type { PodAccessFetchProvider } from '../ai-gateway/pod/OwnerPodAccess';
import { isSolidAuth } from '../auth/AuthContext';
import type { TaskCredentialStore } from '../tasks/TaskCredentialStore';
import { CanonicalRoomSource, parseMembershipAuthorityBinding,
  type CanonicalRoomSnapshot, type MembershipAuthorityBinding, type MembershipAuthorityPublication } from './canonicalRoomSource';
import { generateEventId } from './eventIdentity';
import { buildCanonicalRoomCas } from './canonicalRoomCas';
import { MatrixError } from './MatrixError';
import { matrixPodWriteFor, type MatrixPodWrite } from './podAccess';
import type { MatrixEventRecord, MatrixStoreContext } from './types';

export const MEMBERSHIP_AUTHORITY_EVENT_TYPE = 'co.undefineds.membership.authority';

export type MembershipAuthorityProjectEvent = (input: {
  roomId: string; binding: MembershipAuthorityBinding; publication: MembershipAuthorityPublication;
  write: MatrixPodWrite; context: MatrixStoreContext; existingOnly: boolean;
  queueOnly: boolean;
  /** The incoming current grant, which may differ from the old projection being recovered. */
  authorityBinding: MembershipAuthorityBinding;
  /** Validate the strict persistent winner before journal/queue effects in the projection adapter. */
  validateCommitted: (record: MatrixEventRecord) => Promise<void>;
}) => Promise<MatrixEventRecord>;

export interface MembershipAuthorityPublisherOptions {
  canonicalSource: Pick<CanonicalRoomSource, 'readSnapshot'>;
  credentials: Pick<TaskCredentialStore, 'lease'>;
  podAccess: PodAccessFetchProvider;
  issuer: string;
  now?: () => number;
}

const denied = (): MatrixError => new MatrixError(403, 'M_FORBIDDEN', 'Current explicit membership authority is required');
const conflict = (): MatrixError => new MatrixError(409, 'M_CONFLICT', 'Canonical publication changed concurrently');

function sameBinding(left: MembershipAuthorityBinding | undefined, right: MembershipAuthorityBinding): boolean {
  return left?.purpose === right.purpose && left.credentialRef === right.credentialRef
    && left.version === right.version && left.issuer === right.issuer;
}

function samePublication(left: MembershipAuthorityPublication | undefined, right: MembershipAuthorityPublication): boolean {
  return left?.eventId === right.eventId && left.createdAt === right.createdAt && left.state === right.state;
}

/** Owner-driven publication. The named lease is a fence; the caller remains the Pod principal. */
export class MembershipAuthorityPublisher {
  public constructor(private readonly options: MembershipAuthorityPublisherOptions) {}

  public async publish(roomId: string, value: unknown, ownerCaller: MatrixStoreContext,
    projectEvent?: MembershipAuthorityProjectEvent): Promise<MatrixEventRecord> {
    const binding = parseMembershipAuthorityBinding(value);
    const auth = ownerCaller.auth;
    if (!binding || binding.issuer !== this.options.issuer || ownerCaller.service
      || !auth || !isSolidAuth(auth) || auth.webId !== ownerCaller.webId || !projectEvent) throw denied();
    const beforeRequest = async(): Promise<void> => {
      try {
        const lease = await this.options.credentials.lease({ credentialRef: binding.credentialRef,
          ownerWebId: ownerCaller.webId, version: binding.version, recordUsage: false });
        if (lease.credentialRef !== binding.credentialRef || lease.ownerWebId !== ownerCaller.webId
          || lease.version !== binding.version || lease.issuer !== this.options.issuer) throw denied();
      } catch { throw denied(); }
    };
    const read = async(): Promise<CanonicalRoomSnapshot> => {
      await beforeRequest();
      const snapshot = await this.options.canonicalSource.readSnapshot(roomId, ownerCaller, beforeRequest);
      if (snapshot.facts.authorWebId !== ownerCaller.webId) throw denied();
      if (snapshot.facts.membershipOperation && snapshot.facts.membershipOperation.phase !== 'complete') throw conflict();
      return snapshot;
    };
    let snapshot = await read();
    // Fresh context: no injected database or memo from the incoming request can enter publication.
    const context: MatrixStoreContext = { webId: ownerCaller.webId,
      podUrl: snapshot.facts.sourcePodUrl, auth };
    const provider: PodAccessFetchProvider = { getPodFetch: async(owner, request) =>
      await this.options.podAccess.getPodFetch(owner, { ...request, beforeRequest }) };
    const write = await matrixPodWriteFor(context, provider);
    const confirmProjection = async(current: CanonicalRoomSnapshot, existingOnly: boolean, queueOnly = false): Promise<MatrixEventRecord> => {
      const oldBinding = current.facts.membershipAuthority;
      const publication = current.facts.membershipAuthorityPublication;
      if (!oldBinding || !publication) throw conflict();
      const phase = await read();
      if (!sameBinding(phase.facts.membershipAuthority, oldBinding)
        || !samePublication(phase.facts.membershipAuthorityPublication, publication)) throw conflict();
      await beforeRequest();
      const validateCommitted = async(record: MatrixEventRecord): Promise<void> => {
        const event = record.event;
        if (!event || event.event_id !== publication.eventId || event.room_id !== roomId
          || event.type !== MEMBERSHIP_AUTHORITY_EVENT_TYPE || event.state_key !== ''
          || event.sender !== ownerCaller.webId || event.origin_server_ts !== publication.createdAt
          || !sameBinding(parseMembershipAuthorityBinding(event.content), oldBinding)
          || record.eventId !== publication.eventId || record.originServerTs !== publication.createdAt
          || record.roomId !== roomId || record.type !== MEMBERSHIP_AUTHORITY_EVENT_TYPE
          || record.stateKey !== '' || record.sender !== ownerCaller.webId
          || !sameBinding(parseMembershipAuthorityBinding(record.content), oldBinding)) throw conflict();
        await beforeRequest();
        const currentPhase = await read();
        if (!sameBinding(currentPhase.facts.membershipAuthority, oldBinding)
          || !samePublication(currentPhase.facts.membershipAuthorityPublication, publication)) throw conflict();
      };
      const record = await projectEvent({ roomId, binding: oldBinding, publication, write, context,
        existingOnly, queueOnly, authorityBinding: binding, validateCommitted });
      await validateCommitted(record);
      return record;
    };
    const replace = async(current: CanonicalRoomSnapshot, nextBinding: MembershipAuthorityBinding,
      publication: MembershipAuthorityPublication): Promise<CanonicalRoomSnapshot> => {
      await beforeRequest();
      const protocols = structuredClone(current.protocols);
      protocols.matrix = { ...(protocols.matrix as Record<string, unknown>),
        membershipAuthority: nextBinding, membershipAuthorityPublication: publication };
      const query = buildMembershipAuthorityCas(write.db, current, protocols);
      const document = current.facts.sourceIri.split('#')[0];
      const endpoint = `${document.slice(0, document.lastIndexOf('/') + 1)}-/sparql`;
      await write.db.getDialect().executeOnResource(endpoint, { type: 'INSERT', query, prefixes: {} }, { mode: 'sparql', endpoint });
      const confirmed = await read();
      if (!sameBinding(confirmed.facts.membershipAuthority, nextBinding)
        || !samePublication(confirmed.facts.membershipAuthorityPublication, publication)) throw conflict();
      return confirmed;
    };
    // A new valid incoming lease permits only the original owner's explicit recovery of the old
    // pending projection. Its old binding remains canonical until completion is read back.
    const existing = snapshot.facts.membershipAuthorityPublication;
    if (existing?.state === 'pending') {
      await confirmProjection(snapshot, false);
      snapshot = await replace(snapshot, snapshot.facts.membershipAuthority!, { ...existing, state: 'complete' });
    }
    if (snapshot.facts.membershipAuthorityPublication?.state === 'complete') {
      const oldRecord = await confirmProjection(snapshot, true, true);
      if (sameBinding(snapshot.facts.membershipAuthority, binding)) return oldRecord;
    }
    const publication: MembershipAuthorityPublication = {
      eventId: generateEventId(), createdAt: (this.options.now ?? Date.now)(), state: 'pending',
    };
    snapshot = await replace(snapshot, binding, publication);
    await confirmProjection(snapshot, false);
    snapshot = await replace(snapshot, binding, { ...publication, state: 'complete' });
    return await confirmProjection(snapshot, true, true);
  }
}

/** Compatibility wrapper; all canonical source guards live in the shared CAS adapter. */
export function buildMembershipAuthorityCas(db: SolidDatabase, snapshot: CanonicalRoomSnapshot,
  protocols: Record<string, unknown>): string {
  return buildCanonicalRoomCas(db, snapshot, { protocols });
}
