/**
 * Who may write an inbound event for a participant.
 *
 * Two rules, decided 2026-09-27/28 and deliberately kept apart:
 *
 * - **No grant, no write.** The deployment writes into a participant's Pod on its own behalf, with
 *   that participant's task-layer grant. Without one the answer is a refusal that names the Pod —
 *   never a borrowed session and never a silent skip.
 * - **Authority follows room membership, judged on what the state says.** A message or a state event
 *   belongs in a Pod because its owner is in that room; one that arrives while the state says they are
 *   invited, left, banned or knocking does not belong there. Two things are deliberately *not*
 *   refusals:
 *   - an `m.room.member` event, because it is the *means* by which membership changes (an invite's
 *     whole job is to tell somebody about a room they are not in yet);
 *   - an event for a room whose membership this Pod does not know yet, because the membership is
 *     still being established. A remote join handshake delivers the room's state as it was *before*
 *     the join — create, join rules, power levels — and refusing those would refuse the handshake's
 *     own first step.
 *
 *   So the rule is "refuse when the state says they are not in the room", never "refuse because we do
 *   not know yet".
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
   * The participant's membership in the room's *resolved* state. Absent means this Pod does not know
   * it yet — a first invite, or the state a join handshake delivers, which is the room as it was
   * before the join. That is a state of "still being established", not of "not a member".
   */
  membership?: 'join' | 'invite' | 'leave' | 'ban' | 'knock';
}

export type InboundWriteAuthority =
  | { allowed: true; reason: 'membership change' | 'member' | 'membership not established yet' }
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
  // Unknown is not a refusal: this is a room the participant is being brought into, and the events
  // that bring them in are the ones being written. Only a state that *says* they are out refuses.
  if (request.membership === undefined) return { allowed: true, reason: 'membership not established yet' };
  return { allowed: false, reason: `The participant is ${request.membership} in this room` };
}
