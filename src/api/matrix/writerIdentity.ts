/**
 * The first half of authenticity once nothing is signed: *who is writing, and may they claim this?*
 *
 * A delivered batch arrives over an authenticated channel — a Solid session for the participant the
 * deployment acts for — so the identity of the writer is established at the hop, not by a signature
 * on each event. What is left to check is that the hop's identity is allowed to speak for the
 * events' author: a deployment may write Alice's events as Alice, and nobody else's. Without this,
 * "no signatures" would mean "anybody may put anybody's name on an event".
 *
 * The identity *form* is injected: today a sender is an `@localpart:server` id derived from a WebID,
 * and this protocol's target is the WebID itself. Passing the mapping in keeps this check correct
 * across that switch — and keeps it in one place instead of two spellings of "same person".
 */
export interface WriterClaim {
  /** The WebID the hop was authenticated as, if any. No session is `undefined`, never a guess. */
  sessionWebId?: string;
  /** The author the event claims (`sender`). */
  sender: string;
  /** How a WebID is spelled as a sender today — the MXID derivation, later the WebID itself. */
  identityOf: (webId: string) => string;
}

export type WriterVerdict =
  | { allowed: true; webId: string }
  | { allowed: false; reason: 'no-session' | 'impersonation'; detail: string };

/**
 * May the authenticated hop write an event claiming this sender?
 *
 * A refusal names which of the two it is — an unauthenticated write and a write on somebody else's
 * behalf are different problems, and an operator reading a log should not have to guess.
 */
export function writerMayClaim(claim: WriterClaim): WriterVerdict {
  if (!claim.sessionWebId) {
    return { allowed: false, reason: 'no-session', detail: 'The write carried no authenticated identity' };
  }
  if (claim.identityOf(claim.sessionWebId) !== claim.sender) {
    return {
      allowed: false,
      reason: 'impersonation',
      detail: `${claim.sessionWebId} may not write events as ${claim.sender}`,
    };
  }
  return { allowed: true, webId: claim.sessionWebId };
}
