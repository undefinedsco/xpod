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
 * `MatrixRoomStateReplay.stateBefore` computes; nothing here re-implements resolution.
 */
import { MatrixRoomStateReplay } from '../roomState';
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
  const stateEvents = state.events().filter(record => record.stateKey !== undefined);
  const { chain, unavailable } = selectAuthChainFor(records.map(pduOf), stateEvents.map(record => record.eventId));
  return { pdus: stateEvents.map(pduOf), authChain: chain, unavailable };
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

/**
 * The protocol event behind a record. Rows written before the graph existed carry no stored
 * event; they are reconstructed from the columns, which is enough for the auth walk to see
 * that they name no auth events.
 */
function pduOf(record: MatrixEventRecord): Record<string, unknown> {
  const stored = record.event;
  if (stored !== undefined) return stored;
  return {
    event_id: record.eventId,
    room_id: record.roomId,
    type: record.type,
    sender: record.sender,
    origin_server_ts: record.originServerTs,
    content: record.content,
    ...(record.stateKey === undefined ? {} : { state_key: record.stateKey }),
  };
}
