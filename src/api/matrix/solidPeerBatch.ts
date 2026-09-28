/**
 * A delivered batch from a Solid-authenticated peer: may it be written at all?
 *
 * This is where the two halves of the authenticity model meet the transport. The hop proves *who is
 * writing* (a Solid session, so a WebID), the batch declares *which server it is speaking as*, and
 * every event in it claims an author. The rule is the one `writerMayClaim` states, applied to a
 * whole batch: the session may write events as its own identity and nobody else's.
 *
 * The declared origin is what the author's identity is spelled with — the sending deployment derived
 * its own senders under *its* name, which is exactly the name it declares here. Recomputing them
 * under the receiving deployment's name would compare two different spellings and refuse every
 * honest batch; that mistake is the reason this rule takes the origin as an input instead of
 * assuming the name it is addressed by.
 */
import { writerMayClaim } from './writerIdentity';

export interface SolidPeerBatch {
  /** The WebID the delivery was authenticated as, if the caller presented a session. */
  sessionWebId?: string;
  /** The server name the batch declares it speaks as (`origin`). */
  declaredOrigin?: string;
  /** The authors the events claim, in order. */
  senders: readonly string[];
  /** How a WebID is spelled as a sender under a server name — the deployment's own rule. */
  identityOf: (webId: string, serverName: string) => string;
}

export type SolidPeerVerdict =
  | { allowed: true; webId: string; origin: string }
  | { allowed: false; reason: 'no-session' | 'no-origin' | 'empty' | 'impersonation'; detail: string };

/**
 * Decide, and say which of the four it was.
 *
 * An empty batch is refused rather than waved through: it would record a delivery that carried
 * nothing, and "nothing to check" is not the same as "checked and fine".
 */
export function solidPeerMayDeliver(batch: SolidPeerBatch): SolidPeerVerdict {
  if (!batch.sessionWebId) {
    return { allowed: false, reason: 'no-session', detail: 'The delivery carried no Solid session' };
  }
  if (!batch.declaredOrigin) {
    return { allowed: false, reason: 'no-origin', detail: 'The delivery did not declare the server it speaks as' };
  }
  if (batch.senders.length === 0) {
    return { allowed: false, reason: 'empty', detail: 'The delivery carried no events' };
  }
  for (const sender of batch.senders) {
    const verdict = writerMayClaim({
      sessionWebId: batch.sessionWebId,
      sender,
      identityOf: webId => batch.identityOf(webId, batch.declaredOrigin!),
    });
    if (!verdict.allowed) {
      return { allowed: false, reason: verdict.reason === 'no-session' ? 'no-session' : 'impersonation', detail: verdict.detail };
    }
  }
  return { allowed: true, webId: batch.sessionWebId, origin: batch.declaredOrigin };
}
