/**
 * The protocol event a Matrix message persists alongside its Solid Chat view.
 *
 * The Solid Chat representation is what people and other apps read; this object
 * is the protocol fact: it carries the hashes and signatures that make the event
 * verifiable, so a deployment can re-check an event from the Pod alone instead
 * of trusting the row that references it.
 *
 * Only fields that are actually part of the event are stored here. Application
 * bookkeeping (the author's WebID, the client transaction id) stays beside it
 * under `metadata.protocols.matrix`; putting it inside the event would change the
 * canonical form and therefore the event id.
 */
import {
  computeContentHash,
  computeEventId,
  encodeUnpaddedBase64,
  EventIntegrityError,
  redactEvent,
  verifyJson,
  type RedactedEvent,
} from './protocol/eventIntegrity';
import type { MatrixServiceIdentity } from './protocol/serviceIdentity';

/** The subset of a Matrix event this adapter produces and verifies. */
export interface PersistedMatrixEvent extends RedactedEvent {
  event_id?: string;
  room_id?: string;
  sender?: string;
  type?: string;
  origin_server_ts?: number;
  state_key?: string;
  content?: Record<string, unknown>;
  hashes?: Record<string, unknown>;
  signatures?: Record<string, Record<string, string>>;
  /** Parents in the room DAG: the events that had no child when this one was made. */
  prev_events?: string[];
  /** The events that authorise this one, selected by the room version's rules. */
  auth_events?: string[];
  /** One more than the deepest parent; 1 for the create event. */
  depth?: number;
}

export interface PersistedEventInput {
  roomId: string;
  type: string;
  sender: string;
  originServerTs: number;
  content: Record<string, unknown>;
  stateKey?: string;
  /** Kept when a caller already holds one (replays reuse the first event id). */
  eventId?: string;
  /** Present for events received from another server; absent for local signing. */
  depth?: number;
  prevEvents?: string[];
  authEvents?: string[];
  unsigned?: Record<string, unknown>;
}

/**
 * Build the stored event. When a signing identity is configured the event gets
 * its content hash and signature; without one the event is still stored with the
 * id derived from its own content, so the deployment can tell what it would have
 * signed and can add signatures later.
 */
export function buildPersistedEvent(
  input: PersistedEventInput,
  identity?: MatrixServiceIdentity,
): PersistedMatrixEvent {
  // An event that is signed must contain only JSON-representable values, so
  // absent optional fields are dropped here rather than reaching the encoder.
  const base = dropUndefined<PersistedMatrixEvent>({
    room_id: input.roomId,
    sender: input.sender,
    type: input.type,
    origin_server_ts: input.originServerTs,
    content: input.content,
    state_key: input.stateKey,
    depth: input.depth,
    prev_events: input.prevEvents,
    auth_events: input.authEvents,
    unsigned: input.unsigned,
  });
  // `event_id` is derived from the event and never taken from the caller, so it is
  // attached only once it can be computed. A caller that already holds an
  // operational reference to this event (the journal's reservation) passes it in
  // for one purpose: to prove the two agree. A divergence is then a loud failure
  // rather than a second identity for the same event.
  let built: PersistedMatrixEvent;
  if (identity) {
    // Keep the full content beside the signed (redacted) event: the signature and
    // the event id cover the redacted form, while the content hash covers the whole
    // event. Dropping either half would make the event unverifiable.
    const signed = identity.signEvent(base) as PersistedMatrixEvent;
    built = { ...signed, content: base.content };
  } else {
    built = { ...base, hashes: { sha256: encodeUnpaddedBase64(computeContentHash(base)) } };
  }
  const eventId = computeEventId(built);
  if (input.eventId !== undefined && input.eventId !== eventId) {
    throw new EventIntegrityError(
      `The recorded event id ${input.eventId} does not match the event content (${eventId})`,
    );
  }
  return { ...built, event_id: eventId };
}

/**
 * Copy only the entries that carry a value, at every depth.
 *
 * Application objects routinely hold explicit `undefined` members; a JSON
 * document cannot, and `undefined` is not a value that can be signed. Arrays are
 * rebuilt element-wise so a hole stays a hole and the encoder rejects it rather
 * than silently changing the canonical form.
 */
function dropUndefined<T>(value: unknown): T {
  if (Array.isArray(value)) {
    return value.map(entry => dropUndefined(entry)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [ key, entry ] of Object.entries(value)) {
      if (entry !== undefined) result[key] = dropUndefined(entry);
    }
    return result as T;
  }
  return value as T;
}

export interface PersistedEventCheck {
  /** The stored event still hashes to the id stored beside it (redacted form). */
  eventIdMatches: boolean;
  /**
   * The stored content hash still covers the stored event.
   *
   * This is the check that guards the payload: a signature only covers the
   * redacted event, so content edits show up here rather than in the signature.
   */
  contentHashMatches: boolean;
  /** A signature is present, so some server claims to have signed the event. */
  signed: boolean;
}

/**
 * Re-derive the event's own claims. This is what makes a Pod-stored event
 * self-checking: nothing here trusts the row that referenced the event.
 */
export function verifyPersistedEvent(event: PersistedMatrixEvent): PersistedEventCheck {
  const storedHash = typeof event.hashes?.sha256 === 'string' ? event.hashes.sha256 : undefined;
  return {
    eventIdMatches: typeof event.event_id === 'string' && computeEventId(event) === event.event_id,
    contentHashMatches: storedHash !== undefined && storedHash === encodeUnpaddedBase64(computeContentHash(event)),
    signed: Boolean(event.signatures && Object.keys(event.signatures).length > 0),
  };
}

/**
 * Verify a stored signature: the signature covers the redacted event, which is
 * what other servers see, so verification redacts before checking.
 */
export function verifyPersistedEventSignature(
  event: PersistedMatrixEvent,
  signingName: string,
  keyId: string,
  verifyKeyPem: string,
): boolean {
  return verifyJson(redactEvent(event), signingName, keyId, verifyKeyPem);
}

/** Read a stored event back out of message metadata, if the row carries one. */
export function readPersistedEvent(matrix: Record<string, unknown>): PersistedMatrixEvent | undefined {
  const event = matrix.event;
  if (!event || typeof event !== 'object' || Array.isArray(event)) return undefined;
  return event as PersistedMatrixEvent;
}

/** Shape stored by the writer; kept in one place so reader and writer cannot drift. */
export const PERSISTED_EVENT_KEY = 'event';
