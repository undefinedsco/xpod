/**
 * Answering `GET /_matrix/federation/v1/state/{roomId}` and `/state_ids/{roomId}`.
 *
 * A server that is joining a room — or that received an event whose history it lacks — asks
 * the resident server for the room's state *at* an event: "the fully resolved state for the
 * room, prior to considering any state changes induced by the requested event", plus the auth
 * chain that state rests on. `/state_ids` answers the same thing as ids, so a server that
 * already has the events does not download them again.
 *
 * The state at an event is the resolution of the states after its parents, which is what
 * `MatrixRoomStateReplay.stateBefore` computes; nothing here re-implements resolution. The same
 * answer, taken from the parents directly, is what `/send_join` returns — there the event is the
 * joining server's, and it is answered before this server stores it.
 */
import { MatrixRoomStateReplay, type MatrixRoomState } from '../roomState';
import { storedProtocolEvent } from '../storedEvent';
import { selectAuthChainFor } from './authChain';
import type { MatrixEventRecord } from '../types';

export interface StateSnapshot {
  /** The fully resolved state before the event, as PDUs. */
  pdus: Record<string, unknown>[];
  /** The auth events of that state, and theirs, recursively. */
  authChain: Record<string, unknown>[];
  /** Ids the auth walk needed that this server does not hold. */
  unavailable: string[];
}

export interface StateIdSnapshot {
  pduIds: string[];
  authChainIds: string[];
  unavailable: string[];
}

/** The state before `eventId`, with the auth chain it rests on. `undefined` when unknown. */
export function stateSnapshotBefore(
  records: readonly MatrixEventRecord[],
  eventId: string,
): StateSnapshot | undefined {
  const state = MatrixRoomStateReplay.from(records).stateBefore(eventId);
  if (!state) return undefined;
  return snapshotOf(state, records);
}

/**
 * The state before an event this server has not stored: the resolution of the states after the
 * parents it names. `/send_join` answers with this — the state prior to the join — before the
 * join event exists in the Pod.
 */
export function stateSnapshotBeforeParents(
  records: readonly MatrixEventRecord[],
  parentIds: readonly string[],
): StateSnapshot {
  return snapshotOf(MatrixRoomStateReplay.from(records).stateBeforeParents(parentIds), records);
}

function snapshotOf(state: MatrixRoomState, records: readonly MatrixEventRecord[]): StateSnapshot {
  const stateEvents = state.events().filter(record => record.stateKey !== undefined);
  const { chain, unavailable } = selectAuthChainFor(records.map(storedProtocolEvent), stateEvents.map(record => record.eventId));
  return { pdus: stateEvents.map(storedProtocolEvent), authChain: chain, unavailable };
}

/** The same answer in ids, which is all a server that has the events needs. */
export function stateIdsBefore(
  records: readonly MatrixEventRecord[],
  eventId: string,
): StateIdSnapshot | undefined {
  const snapshot = stateSnapshotBefore(records, eventId);
  if (!snapshot) return undefined;
  return {
    pduIds: snapshot.pdus.map(event => String(event.event_id)).sort(),
    authChainIds: snapshot.authChain.map(event => String(event.event_id)).sort(),
    unavailable: snapshot.unavailable,
  };
}
