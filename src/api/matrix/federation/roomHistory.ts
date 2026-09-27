/**
 * Answering `GET /_matrix/federation/v1/backfill/{roomId}?v=...&limit=...`.
 *
 * A server that is missing history asks a server that has it for a sliding window: the events
 * it named and the events that preceded them, up to the limit. That is a `prev_events` walk
 * with no "stop at what the requester has" rule — the requester is asking precisely because it
 * does not have it — and it *includes* the named events, unlike `/get_missing_events`.
 *
 * The answer is ordered **newest first**, the opposite of the other walks here: the requester
 * is paging backwards through history, so the newest event is the one it anchors on and the
 * oldest one it gets back is where it asks next from.
 */
import { eventReferenceIds } from '../protocol/eventReferences';

export interface BackfillRequest {
  /** The event ids to walk back from; they are included in the answer. */
  from: readonly string[];
  /** The maximum number of PDUs to return, including the named ones. */
  limit: number;
}

export interface BackfillSelection {
  /** The window, newest first. */
  pdus: Record<string, unknown>[];
  /** Ids the walk needed that this server does not hold. */
  unavailable: string[];
}

export const MAX_BACKFILL_LIMIT = 100;

/** Walk back from the named events through the PDUs this server holds for the room. */
export function selectBackfill(
  room: readonly Record<string, unknown>[],
  request: BackfillRequest,
): BackfillSelection {
  const byId = new Map<string, Record<string, unknown>>();
  for (const event of room) {
    const id = event.event_id;
    if (typeof id === 'string' && !byId.has(id)) byId.set(id, event);
  }
  const limit = clampLimit(request.limit);
  const found: Record<string, unknown>[] = [];
  const unavailable: string[] = [];
  const seen = new Set<string>();
  // Breadth-first from the named events, so the window is filled with the closest ancestors
  // first and the limit cuts the oldest end.
  const queue: string[] = [ ...request.from ];
  while (queue.length > 0 && found.length < limit) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const event = byId.get(id);
    if (!event) {
      unavailable.push(id);
      continue;
    }
    found.push(event);
    queue.push(...eventReferenceIds(event, 'prev_events'));
  }
  // Oldest first out of the walk, reversed: the requester pages backwards.
  found.sort((left, right) => depthOf(right) - depthOf(left) || String(right.event_id).localeCompare(String(left.event_id)));
  return { pdus: found, unavailable };
}

function depthOf(event: Record<string, unknown>): number {
  return typeof event.depth === 'number' ? event.depth : 0;
}

function clampLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) return 1;
  return Math.min(limit, MAX_BACKFILL_LIMIT);
}
