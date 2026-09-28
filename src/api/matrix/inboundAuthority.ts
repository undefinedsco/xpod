/**
 * Who may write an inbound event for a participant.
 *
 * Two rules, decided 2026-09-27/28 and deliberately kept apart:
 *
 * - **No grant, no write.** The deployment writes into a participant's Pod on its own behalf, with
 *   that participant's task-layer grant. Without one the answer is a refusal that names the Pod —
 *   never a borrowed session and never a silent skip.
 * - **Authority follows room membership, with one exception.** A message or a state event belongs in
 *   a Pod because its owner is in that room right now; an `m.room.member` event does not, because it
 *   is the *means* by which membership changes. An invite is the clearest case: its whole job is to
 *   tell somebody about a room they are not in yet, and gating it on membership would refuse the one
 *   event that could ever make them a member. That is not hypothetical — receiving an unknown room's
 *   events has to materialise the room first, or the invite is invisible and cannot be accepted.
 *
 * The judgement is a pure function so it can be tested against the cases that matter and then wired
 * into the inbound path in one place, rather than re-derived wherever a write happens.
 */

/** What the caller knows when it asks: the grant it holds, and the room's view of the participant. */
export interface InboundWriteRequest {
  /** Whether this deployment holds a task-layer grant for the participant's Pod. */
  grant: boolean;
  /** The event type being written. */
  type: string;
  /**
   * The participant's membership in the room's *resolved* state. Absent means the room is unknown
   * here (a first invite, an event for a room this Pod has not materialised yet).
   */
  membership?: 'join' | 'invite' | 'leave' | 'ban' | 'knock';
}

export type InboundWriteAuthority =
  | { allowed: true; reason: 'membership change' | 'member' }
  | { allowed: false; reason: string };

/** May this deployment write this event into this participant's Pod? */
export function inboundWriteAuthority(request: InboundWriteRequest): InboundWriteAuthority {
  if (!request.grant) {
    return { allowed: false, reason: 'This deployment holds no grant for the participant\'s Pod' };
  }
  // The events that change membership are how somebody gets into a room, so they cannot require
  // already being in it. Nothing else gets this exemption.
  if (request.type === 'm.room.member') return { allowed: true, reason: 'membership change' };
  if (request.membership === 'join') return { allowed: true, reason: 'member' };
  return {
    allowed: false,
    reason: request.membership === undefined
      ? 'The participant is not known to be in this room'
      : `The participant is ${request.membership} in this room`,
  };
}
