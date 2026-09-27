/**
 * Answering `GET /_matrix/federation/v1/event_auth/{roomId}/{eventId}`.
 *
 * A server that receives an event it cannot authorise needs the events that authorise it —
 * the event's `auth_events`, and theirs, transitively. That is a different question from
 * "what parents am I missing": an auth event is usually an ancestor, but state resolution
 * can select an event that is not on the `prev_events` walk, so the specification has a
 * separate endpoint for it, and this is its walk.
 *
 * The answer excludes the event itself (the requester already has it) and is ordered
 * oldest-first by `depth`, because the requester is going to authorise the chain in order and
 * an event cannot be authorised before the events that authorise it.
 */
import { eventReferenceIds } from '../protocol/eventReferences';

export interface AuthChainSelection {
  /** The events that authorise `eventId`, oldest first. */
  chain: Record<string, unknown>[];
  /** Ids the walk needed that this server does not hold. */
  unavailable: string[];
}

/** Walk the auth chain of `eventId` through the PDUs this server holds for the room. */
export function selectAuthChain(
  room: readonly Record<string, unknown>[],
  eventId: string,
): AuthChainSelection {
  const byId = new Map<string, Record<string, unknown>>();
  for (const event of room) {
    const id = event.event_id;
    if (typeof id === 'string' && !byId.has(id)) byId.set(id, event);
  }
  const target = byId.get(eventId);
  if (!target) return { chain: [], unavailable: [ eventId ] };

  const chain: Record<string, unknown>[] = [];
  const unavailable: string[] = [];
  const seen = new Set<string>([ eventId ]);
  const queue: string[] = [ ...eventReferenceIds(target, 'auth_events') ];
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
