/**
 * The checks a received PDU must pass before it is accepted.
 *
 * Source: server-server API § "Checks performed on receipt of a PDU", in the
 * specification's order, which matters because each step decides something different:
 *
 * 1. a structurally valid event for the room version, otherwise it is dropped;
 * 2. a signature by the server named in `sender`, otherwise it is dropped — this is
 *    where `federation/serverKeys.ts` is used;
 * 3. the content hash, and a mismatch means the event is **redacted** and then
 *    processed further, not dropped: the payload is untrustworthy, the event is not;
 * 4. the authorisation rules, against the events the sender selected.
 *
 * Two things this module cannot do alone are reported rather than guessed: an event
 * whose `auth_events` are not all resolvable is `deferred` (the receiver has a
 * dependency gap to fill before it can judge the event), and nothing here writes to a
 * Pod — persisting what was accepted is the caller's step.
 *
 * Steps 1–3 are also exported on their own (`verifyInboundPdu`), because `/invite` needs exactly
 * them and not step 4: the invited server usually does not know the room, so it cannot judge the
 * invite's authorisation — the room's own servers do that when the invite reaches them in a
 * transaction.
 *
 * The event id is derived from the received event (room v11: the reference hash), so a
 * caller can use it for de-duplication without trusting the sender for an id.
 */
import { authorizeEvent, serverNameOf, type AuthEvent } from '../protocol/authRules';
import {
  computeContentHash,
  computeEventId,
  encodeUnpaddedBase64,
  redactEvent,
} from '../protocol/eventIntegrity';
import { eventReferenceIds } from '../protocol/eventReferences';
import { verifyRemoteEventSignature, type MatrixServerKeySource } from './serverKeys';

export type InboundPduOutcome = 'accepted' | 'rejected' | 'deferred';

/**
 * The step that decided the outcome, in the specification's order above — for an accepted event,
 * the step that accepted it.
 *
 * A caller that has to answer differently depending on *why* an event was refused — the join
 * handshake must, because the specification nominates `M_INVALID_PARAM` for a bad signature but
 * `M_FORBIDDEN` for a refused authorisation — reads this instead of parsing `reason`. The content
 * hash is not a stage: a mismatch redacts the event and processing continues, so it never decides
 * an outcome.
 */
export type InboundPduStage = 'structure' | 'signature' | 'authorisation' | 'dependencies';

export interface InboundPduResult {
  /** Derived from the received event, absent only when the event is not usable at all. */
  eventId?: string;
  outcome: InboundPduOutcome;
  stage: InboundPduStage;
  /** The rule or reason that decided the outcome. */
  reason: string;
  /** True when the content hash failed and the event was redacted before acceptance. */
  redacted: boolean;
  /** What the caller should store: the event as received, redacted when necessary. */
  event?: Record<string, unknown>;
}

export interface InboundPduOptions {
  /** Verify keys of the servers involved; typically `MatrixServerKeyFetcher`. */
  keys: MatrixServerKeySource;
  /**
   * The events named by the PDU's `auth_events`, resolved by the receiver. An id with
   * no entry is a dependency gap that defers the event.
   */
  authEvents: readonly AuthEvent[];
  now?: () => number;
}

export async function validateInboundPdu(pdu: unknown, options: InboundPduOptions): Promise<InboundPduResult> {
  const verified = await verifyInboundPdu(pdu, options);
  if (verified.outcome !== 'accepted' || !verified.event) return verified;
  const event = verified.event;

  // 4. Authorisation, judged against the events the *event* selected — the caller's
  //    list is only a lookup, so passing extra room state cannot change the decision.
  const authEventIds = eventReferenceIds(event, 'auth_events');
  const resolved = new Map(options.authEvents.map(authEvent => [ authEvent.event_id ?? '', authEvent ]));
  const selected = authEventIds.map(id => resolved.get(id));
  const missing = authEventIds.filter(id => !resolved.has(id));
  if (missing.length > 0) {
    return {
      eventId: verified.eventId,
      outcome: 'deferred',
      stage: 'dependencies',
      reason: `v11-4: ${missing.length} auth event(s) are not available yet`,
      redacted: verified.redacted,
    };
  }
  const decision = authorizeEvent(
    asAuthorizable(event),
    selected.filter((entry): entry is AuthEvent => entry !== undefined),
  );
  if (!decision.allowed) {
    return {
      eventId: verified.eventId,
      outcome: 'rejected',
      stage: 'authorisation',
      reason: `v11-4: ${decision.reason}`,
      redacted: verified.redacted,
    };
  }
  return { ...verified, reason: decision.reason };
}

/**
 * The first three checks: a structurally valid event whose signature verifies, with a content hash
 * that may have forced a redaction. `event` is what a caller should store, and `outcome` is
 * `accepted` for "well formed and signed" rather than for "allowed" — that is step 4's question.
 */
export async function verifyInboundPdu(
  pdu: unknown,
  options: { keys: MatrixServerKeySource; now?: () => number },
): Promise<InboundPduResult> {
  // 1. Structure.
  const shape = normalizeInboundPdu(pdu);
  if (!shape.event) return reject('v11-1: malformed event', shape.reason);
  const event = shape.event;
  const eventId = computeEventId(event);
  const rejectWithId = (reason: string): InboundPduResult =>
    ({ eventId, outcome: 'rejected', stage: 'signature', reason, redacted: false });

  // 2. Signature by the server named in `sender`.
  const senderServer = serverNameOf(String(event.sender));
  if (!senderServer) return rejectWithId('v11-2: sender has no server name');
  const keys = await options.keys.keysFor(senderServer);
  const signature = verifyRemoteEventSignature(event, keys, (options.now ?? Date.now)());
  if (!signature.valid) return rejectWithId(`v11-2: ${signature.reason}`);

  // 3. Content hash: a mismatch redacts the event and processing continues.
  let stored = event;
  let redacted = false;
  const storedHash = isRecord(event.hashes) ? event.hashes.sha256 : undefined;
  if (typeof storedHash === 'string' && storedHash !== encodeUnpaddedBase64(computeContentHash(event))) {
    stored = redactEvent(event);
    redacted = true;
  }
  return { eventId, outcome: 'accepted', stage: 'signature', reason: 'v11-3: signature and content hash verified', redacted, event: stored };
}

interface NormalizedPdu {
  event?: Record<string, unknown>;
  /** Why the event was not usable, when `event` is absent. */
  reason: string;
  authEventIds: string[];
}

/**
 * A structurally valid room v11 PDU.
 *
 * `auth_events` and `prev_events` are event-id lists; Synapse has historically sent
 * them as `[id, {sha256}]` tuples for v4+, so both forms are accepted and normalized to
 * ids — the hash is redundant with the event's own reference hash. Unknown fields are
 * kept: the event is stored as received, so nothing may be dropped here.
 */
export function normalizeInboundPdu(pdu: unknown): NormalizedPdu {
  if (!isRecord(pdu)) return { reason: 'event is not an object', authEventIds: [] };
  const invalid = (field: string): NormalizedPdu => ({ reason: `event has no usable ${field}`, authEventIds: [] });
  if (typeof pdu.type !== 'string' || !pdu.type) return invalid('type');
  if (typeof pdu.room_id !== 'string' || !pdu.room_id) return invalid('room_id');
  if (typeof pdu.sender !== 'string' || !pdu.sender) return invalid('sender');
  if (!isRecord(pdu.content)) return invalid('content');
  if (!Number.isSafeInteger(pdu.origin_server_ts)) return invalid('origin_server_ts');
  const authEventIds = eventIdList(pdu.auth_events);
  if (!authEventIds) return invalid('auth_events');
  const prevEventIds = eventIdList(pdu.prev_events);
  if (!prevEventIds) return invalid('prev_events');
  if (pdu.state_key !== undefined && typeof pdu.state_key !== 'string') return invalid('state_key');
  const event: Record<string, unknown> = {
    ...pdu,
    auth_events: authEventIds,
    prev_events: prevEventIds,
  };
  return { event, reason: 'structurally valid', authEventIds };
}

/** Event-id lists in either the plain or the `[id, {sha256}]` form, or undefined. */
function eventIdList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      ids.push(entry);
      continue;
    }
    if (Array.isArray(entry) && typeof entry[0] === 'string') {
      ids.push(entry[0]);
      continue;
    }
    return undefined;
  }
  return ids;
}

function asAuthorizable(event: Record<string, unknown>): Parameters<typeof authorizeEvent>[0] {
  return {
    event_id: computeEventId(event),
    type: String(event.type),
    sender: String(event.sender),
    room_id: String(event.room_id),
    content: (event.content ?? {}) as Record<string, unknown>,
    ...(event.state_key === undefined ? {} : { state_key: String(event.state_key) }),
    prev_events: eventIdList(event.prev_events) ?? [],
  };
}

function reject(reason: string, detail: string): InboundPduResult {
  return { outcome: 'rejected', stage: 'structure', reason: `${reason}: ${detail}`, redacted: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
