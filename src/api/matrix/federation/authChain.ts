/**
 * Answering `GET /_matrix/federation/v1/event_auth/{roomId}/{eventId}`.
 *
 * A server that receives an event it cannot authorise needs the events that authorise it —
 * the event's `auth_events`, and theirs, transitively. That is a different question from
 * "what parents am I missing": an auth event is usually an ancestor, but state resolution
 * can select an event that is not on the `prev_events` walk, so the specification has a
 * separate endpoint for it, and this is its walk.
 *
 * The answer **includes the events it was asked about**, and is ordered oldest-first by
 * `depth`. Including them matches the specification's own implementations (a receiver
 * authorising a set of events wants the whole set, and `/state` is the same walk with a whole
 * state as its starting point), and the order is what the requester needs: an event cannot be
 * authorised before the events that authorise it.
 */
import { eventReferenceIds } from '../protocol/eventReferences';

export interface AuthChainSelection {
  /** The events asked about plus everything that authorises them, oldest first. */
  chain: Record<string, unknown>[];
  /** Ids the walk needed that this server does not hold. */
  unavailable: string[];
}

/** Walk the auth chain of `eventId` through the PDUs this server holds for the room. */
export function selectAuthChain(
  room: readonly Record<string, unknown>[],
  eventId: string,
): AuthChainSelection {
  return selectAuthChainFor(room, [ eventId ]);
}

/**
 * Walk the auth chain of several events at once: the union of their auth events and theirs,
 * recursively. `/state` answers with the auth chain of a whole state, so this is the same walk
 * with more than one starting point.
 */
export function selectAuthChainFor(
  room: readonly Record<string, unknown>[],
  eventIds: readonly string[],
): AuthChainSelection {
  const byId = new Map<string, Record<string, unknown>>();
  for (const event of room) {
    const id = event.event_id;
    if (typeof id === 'string' && !byId.has(id)) byId.set(id, event);
  }
  const targets = eventIds.filter(eventId => byId.has(eventId));
  const missingTargets = eventIds.filter(eventId => !byId.has(eventId));
  const chain: Record<string, unknown>[] = targets.map(eventId => byId.get(eventId)!);
  const unavailable: string[] = [ ...missingTargets ];
  const seen = new Set<string>(targets);
  const queue: string[] = targets.flatMap(eventId => eventReferenceIds(byId.get(eventId), 'auth_events'));
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const event = byId.get(id);
    if (!event) {
      unavailable.push(id);
      continue;
    }
    chain.push(event);
    queue.push(...eventReferenceIds(event, 'auth_events'));
  }

  chain.sort((left, right) => depthOf(left) - depthOf(right) || String(left.event_id).localeCompare(String(right.event_id)));
  return { chain, unavailable };
}

function depthOf(event: Record<string, unknown>): number {
  return typeof event.depth === 'number' ? event.depth : 0;
}
