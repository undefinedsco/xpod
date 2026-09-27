/**
 * Answering `POST /_matrix/federation/v1/get_missing_events/{roomId}`.
 *
 * A server that receives a PDU whose parents it does not have cannot authorise it, and
 * asking the sender is the specification's answer: a breadth-first walk of `prev_events`
 * from the events it *does* have, ignoring the events it says it already has and stopping
 * at the limit. This module is the walk; the HTTP shell and the Pod that supplies the room
 * are the caller's, which is what keeps the decision here testable on its own.
 *
 * Three details come from the specification and from what the caller does with the answer:
 *
 * - the walk starts at the `prev_events` of `latest_events`, not at those events: the
 *   requester already has them, and it is asking for what came *before*;
 * - an event in `earliest_events` is not returned **and is not walked past** — the
 *   requester says it has it, and everything older than it is the requester's problem;
 * - the answer is ordered oldest-first by `depth`. The requester is going to authorise the
 *   events it asked for, and a dependent cannot be authorised before its dependency, so
 *   returning the walk's newest-first order would hand it a batch it cannot use.
 */
import { eventReferenceIds } from '../protocol/eventReferences';

export interface MissingEventsRequest {
  /** Event ids the requester already has: skipped, and not walked past. */
  earliestEvents: readonly string[];
  /** Event ids whose parents the requester wants. */
  latestEvents: readonly string[];
  /** Maximum number of events to return; the specification defaults to 10. */
  limit?: number;
  /** Do not return anything shallower than this. */
  minDepth?: number;
}

export interface MissingEventsSelection {
  /** The events to answer with, oldest first. */
  events: Record<string, unknown>[];
  /** Ids the walk reached that this server does not hold. */
  unavailable: string[];
}

export const DEFAULT_MISSING_EVENTS_LIMIT = 10;
const MAX_MISSING_EVENTS_LIMIT = 1_000;

/**
 * Walk `room` (the PDUs this server holds for the room) for what the requester is missing.
 */
export function selectMissingEvents(
  room: readonly Record<string, unknown>[],
  request: MissingEventsRequest,
): MissingEventsSelection {
  const byId = new Map<string, Record<string, unknown>>();
  for (const event of room) {
    const id = event.event_id;
    if (typeof id === 'string' && !byId.has(id)) byId.set(id, event);
  }
  const earliest = new Set(request.earliestEvents);
  const limit = clampLimit(request.limit);
  const minDepth = Number.isSafeInteger(request.minDepth) && (request.minDepth ?? 0) > 0 ? request.minDepth! : 0;

  const found: Record<string, unknown>[] = [];
  const unavailable: string[] = [];
  const seen = new Set<string>(earliest);
  // The requester has the latest events; what it wants is behind them.
  const queue: string[] = request.latestEvents.flatMap(id => eventReferenceIds(byId.get(id), 'prev_events'));

  while (queue.length > 0 && found.length < limit) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const event = byId.get(id);
    if (!event) {
      // We cannot return what we do not hold, and we cannot walk through it either.
      unavailable.push(id);
      continue;
    }
    const depth = typeof event.depth === 'number' ? event.depth : 0;
    if (depth < minDepth) {
      // Shallower than asked for, so its parents are too.
      continue;
    }
    found.push(event);
    queue.push(...eventReferenceIds(event, 'prev_events'));
  }

  found.sort((left, right) => depthOf(left) - depthOf(right) || String(left.event_id).localeCompare(String(right.event_id)));
  return { events: found, unavailable };
}

function depthOf(event: Record<string, unknown>): number {
  return typeof event.depth === 'number' ? event.depth : 0;
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isSafeInteger(limit) || (limit ?? 0) < 1) return DEFAULT_MISSING_EVENTS_LIMIT;
  return Math.min(limit!, MAX_MISSING_EVENTS_LIMIT);
}
