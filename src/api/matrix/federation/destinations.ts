/**
 * Which servers need to hear about an event.
 *
 * A homeserver sends an event to the other servers *participating in the room* — the
 * ones with a member there. Membership events are the exception that proves the rule:
 * an invite has to reach a server whose member has not joined, and a kick or leave has
 * to reach one whose member no longer has, so the server of the member the event is
 * about is included as well.
 *
 * Our own server is never a destination: the event is already here, and a transaction to
 * ourselves would be an inbox that never empties.
 */
import { serverNameOf } from '../protocol/authRules';
import type { MatrixRoomState } from '../roomState';

export interface EventDestinationInput {
  state: MatrixRoomState;
  /** The server the event is coming from. */
  ourServerName: string;
  /** The event about to be sent, when the caller knows it. */
  event?: { type: string; stateKey?: string };
}

/** The distinct server names that should receive this event, in a stable order. */
export function eventDestinations(input: EventDestinationInput): string[] {
  const servers = new Set<string>();
  for (const stateEvent of input.state.events()) {
    if (stateEvent.type !== 'm.room.member') continue;
    // Only a joined member makes their server a participant in the room.
    if (stateEvent.content?.membership !== 'join') continue;
    const server = serverNameOf(stateEvent.stateKey);
    if (server) servers.add(server);
  }
  if (input.event?.type === 'm.room.member') {
    // The member this event is about may be joining, invited, leaving or banned, so their
    // server hears about it even though they are not (or no longer) joined.
    const target = serverNameOf(input.event.stateKey);
    if (target) servers.add(target);
  }
  servers.delete(input.ourServerName);
  return [ ...servers ].sort();
}
