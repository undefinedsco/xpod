/**
 * Where a copied event's authenticity comes from once nobody signs anything.
 *
 * A signature used to make a copy self-proving: edit the payload and the signature stops verifying.
 * Without signatures, the stored `hashes.sha256` only proves the event is *self-consistent* — anyone
 * who edits the content can recompute it. So the question "is this really what the author wrote" is
 * answered the only way left: **ask the author's own Pod** for the event with that id and compare
 * content hashes. Their Pod is the original; a copy that disagrees with it is not the author's.
 *
 * Two failure modes are kept apart on purpose, because they mean different things to a caller:
 * `no-copy` (the author's Pod does not hold this event at all — nothing to compare, so nothing is
 * confirmed) and `mismatch` (it holds a different event under that id — the copy was altered or the
 * id was reused). Neither is treated as acceptance, and neither is treated as the other.
 *
 * How the author's Pod is found is deliberately *not* decided here: the lookup is injected, so this
 * stays the same whichever way endpoint resolution lands (identity's host, a registered Pod, or a
 * well-known pointer).
 */
import { computeContentHash, encodeUnpaddedBase64 } from './protocol/eventIntegrity';

/** An event as it is held somewhere: the protocol event itself. */
export interface CandidateEvent {
  roomId: string;
  event: Record<string, unknown>;
}

/** The author's own copy, or `undefined` when their Pod does not hold one. */
export type AuthorCopyLookup = (
  roomId: string,
  eventId: string,
) => Promise<Record<string, unknown> | undefined>;

export type AuthorCopyVerdict =
  | { authentic: true; contentHash: string }
  | { authentic: false; reason: 'no-id' | 'no-copy' | 'mismatch' | 'unreadable'; detail: string };

/**
 * The content hash of an event, in the same encoding the stored event carries in `hashes.sha256`.
 *
 * One rule, shared with `verifyPersistedEvent`: a second way of hashing would mean two answers to
 * "do these match", which is the one thing this check cannot afford.
 */
export function contentHashOf(event: Record<string, unknown>): string {
  return encodeUnpaddedBase64(computeContentHash(event as never));
}

/**
 * Compare a copy against the author's own Pod.
 *
 * The empty-string content hash a malformed event would produce is never treated as a match: an
 * event without a usable body cannot be confirmed, and saying so is the whole point of the check.
 */
export async function verifyAgainstAuthorCopy(
  candidate: CandidateEvent,
  lookup: AuthorCopyLookup,
): Promise<AuthorCopyVerdict> {
  const eventId = typeof candidate.event.event_id === 'string' ? candidate.event.event_id : undefined;
  if (!eventId) {
    return { authentic: false, reason: 'no-id', detail: 'The event carries no id to look up' };
  }
  let original: Record<string, unknown> | undefined;
  try {
    original = await lookup(candidate.roomId, eventId);
  } catch (error) {
    return {
      authentic: false,
      reason: 'unreadable',
      detail: `The author's Pod could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!original) {
    return {
      authentic: false,
      reason: 'no-copy',
      detail: `The author's Pod holds no event ${eventId}, so this copy is not confirmed`,
    };
  }
  const contentHash = contentHashOf(candidate.event);
  const originalHash = contentHashOf(original);
  if (contentHash !== originalHash) {
    return {
      authentic: false,
      reason: 'mismatch',
      detail: `The author's copy of ${eventId} hashes differently (${originalHash} vs ${contentHash})`,
    };
  }
  return { authentic: true, contentHash };
}
