/**
 * Who decides an event's id, and what makes one acceptable.
 *
 * The id used to be *derived*: the reference hash of the event's own content, which made the id
 * self-proving and made a replay produce the same id for free. This protocol gives that job to the
 * writer instead — a client picks an id (random is fine) and **reuses it on every retry**, and a
 * deployment does the same for the events it initiates (a join, an invitation, a membership change).
 *
 * Two consequences are deliberate and worth stating where the rule lives:
 *
 * - The id proves nothing. A random id can be claimed by anybody, which is the same trade already
 *   made by not signing events: what a copy is worth is decided by *who wrote it* (the hop's
 *   authenticated identity) and by comparing it with the author's own Pod, not by the id.
 * - Replays are absorbed by the *id*, not by a reservation: the same id is the same event, and a
 *   second write of it is read back rather than appended. That is what lets the reservation table go.
 */
import { randomBytes } from 'node:crypto';

/**
 * A fresh id for an event the deployment initiates.
 *
 * Unguessable rather than sequential: ids travel to other participants' Pods, and a run of small
 * integers would let one participant enumerate or predict another's events.
 */
export function generateEventId(): string {
  return `$${randomBytes(18).toString('base64url')}`;
}

/**
 * Is this usable as an event id?
 *
 * Bounded and non-empty: it becomes a row fragment inside a document, so anything that could change
 * where the row lands (a slash, a fragment marker, whitespace, or nothing at all) is refused here
 * rather than discovered as a stray document later.
 */
export function isEventId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > 255) return false;
  return !/[\s/#?\\]/u.test(value);
}

/**
 * The id a write should use: the writer's, or a fresh one.
 *
 * A caller that supplies something unusable is refused rather than quietly given a different id —
 * a silent substitution would break the one thing the caller's id is for, which is matching a retry
 * to the event the first attempt created.
 */
export function eventIdForWrite(provided?: unknown): string {
  if (provided === undefined || provided === null) return generateEventId();
  if (!isEventId(provided)) {
    throw new Error(`An event id must be a non-empty fragment without separators; got ${JSON.stringify(provided)}`);
  }
  return provided;
}
