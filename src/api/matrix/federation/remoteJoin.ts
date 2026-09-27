/**
 * Joining a room that another deployment hosts.
 *
 * The three pieces of this already exist — the client's `makeJoin`/`sendJoin`, the template check
 * that discards an answer about somebody else's room or user, and the signing identity that turns a
 * template into an event — and this is the order the specification puts them in, in one place, so
 * the join rules are not re-derived by whoever calls it:
 *
 * 1. ask a resident server for a template;
 * 2. **fill in what only the sender can know** — the specification says the joining server adds or
 *    replaces `origin`, `origin_server_ts` and `event_id`; everything else (`prev_events`,
 *    `auth_events`, `depth`) is the resident's, because only it can see the room's graph;
 * 3. sign it as our own server name;
 * 4. submit it and take back the room's state, the auth chain it rests on, and the event as the
 *    resident accepted it (with its signature added).
 *
 * What this deliberately does not do is *persist* anything: the state and auth chain it returns are
 * what a caller stores in the joining participant's Pod, and a caller that cannot store them has
 * not joined the room — so the decision stays where the Pod write is.
 */
import { computeEventId } from '../protocol/eventIntegrity';
import { SUPPORTED_ROOM_VERSION } from '../protocol/authRules';
import type { MatrixFederationClient } from './outboundTransaction';

/** The two client calls this needs, so a test can answer them without a peer. */
export type MembershipHandshakeClient = Pick<MatrixFederationClient, 'makeJoin' | 'sendJoin'>;

export interface RemoteJoinInput {
  client: MembershipHandshakeClient;
  /** The room to join. */
  roomId: string;
  /** Our user in that room: the MXID this deployment is joining as. */
  userId: string;
  /** The resident server to ask; for a room id, the server it names. */
  destination: string;
  /** The server name we sign as, which the template's `origin` becomes. */
  serverName: string;
  /** Our signing identity: the template is signed as this server. */
  sign: (event: Record<string, unknown>) => Record<string, unknown>;
  /** Room versions we offer to support; the version this deployment implements by default. */
  versions?: readonly string[];
  now?: () => number;
}

export type RemoteJoinOutcome =
  | {
    status: 'joined';
    /** The join event, carrying both signatures. */
    event: Record<string, unknown>;
    eventId: string;
    /** The room's state *before* the join, as the resident resolved it. */
    state: Record<string, unknown>[];
    /** The auth chain that state rests on, oldest first. */
    authChain: Record<string, unknown>[];
  }
  | { status: 'rejected' | 'retry'; reason: string };

export async function joinRoomOverFederation(input: RemoteJoinInput): Promise<RemoteJoinOutcome> {
  const template = await input.client.makeJoin({
    destination: input.destination,
    roomId: input.roomId,
    userId: input.userId,
    versions: input.versions ?? [ SUPPORTED_ROOM_VERSION ],
  });
  if (template.status !== 'ok' || !template.event) {
    // A template this deployment cannot use (another room, user, membership or version) is already
    // discarded by the client; there is nothing to sign, and asking another resident may work.
    return { status: template.status === 'ok' ? 'rejected' : template.status, reason: template.reason };
  }

  // Only the sender's own facts are added; the resident's graph position is used as received.
  const signed = input.sign({
    ...template.event,
    origin: input.serverName,
    origin_server_ts: (input.now ?? Date.now)(),
  });
  const eventId = computeEventId(signed);

  const answer = await input.client.sendJoin({
    destination: input.destination,
    roomId: input.roomId,
    eventId,
    event: signed,
  });
  if (answer.status !== 'ok') return { status: answer.status, reason: answer.reason };

  return {
    status: 'joined',
    // The resident's copy carries its own signature as well; ours is the one we signed with.
    event: answer.event ?? signed,
    eventId,
    state: answer.state ?? [],
    authChain: answer.authChain ?? [],
  };
}
