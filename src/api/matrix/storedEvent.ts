/**
 * Reading a stored row back as a protocol event.
 *
 * A row's `event` is the event as it was persisted — hashes, signatures and parents included —
 * and everything that needs protocol facts should read that. Rows written before the graph was
 * recorded carry none, so the event is reconstructed from the columns instead; the
 * reconstruction is deliberately small: it holds no hashes, signatures or parents, which is
 * exactly why a reader that asks about those must treat their absence as unknown rather than as
 * "none".
 *
 * Both shapes are needed by more than one reader (the state replay, the state snapshot, the join
 * handshake, the write path's graph position), so they live here instead of being spelled out
 * again in each of them.
 */
import { computeEventId } from './protocol/eventIntegrity';
import { eventReferenceIds } from './protocol/eventReferences';
import type { RoomGraphEvent } from './protocol/roomGraph';
import type { MatrixEventRecord } from './types';

/**
 * The protocol event behind a row: the stored event, or the columns rebuilt.
 *
 * Rebuilding uses the row's own columns and nothing else, so the result is the event this server
 * can prove it has — no field is invented to make it look complete.
 */
export function storedProtocolEvent(record: MatrixEventRecord): Record<string, unknown> {
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

/**
 * The graph facts of a stored event: its id, the state slot it fills, its local order and the
 * parents and depth it recorded.
 *
 * `sequence` is the row's own order (`depth`), which is what breaks ties between events that are
 * concurrent in the graph; an event with no recorded depth has none, and the selection rules
 * treat it as the first event of its chain rather than as depth zero.
 */
export function storedGraphEvent(record: MatrixEventRecord): RoomGraphEvent {
  const stored = record.event;
  return {
    eventId: record.eventId,
    type: record.type,
    sender: record.sender,
    stateKey: record.stateKey,
    content: record.content,
    sequence: record.depth ?? 0,
    prevEvents: eventReferenceIds(stored, 'prev_events'),
    depth: typeof stored?.depth === 'number' ? stored.depth : undefined,
  };
}

/**
 * The row a protocol event stands for.
 *
 * The other direction, for readers that work on rows but were handed PDUs: the federation read
 * endpoints read a room from the Pod as protocol events and then need the state replay, which is
 * written in terms of rows. The event itself is kept as the row's `event`, so the replay sees the
 * graph exactly as a stored row would show it — and an event that arrived without an id gets the
 * one its content implies rather than an empty identity.
 */
export function recordOfProtocolEvent(pdu: Record<string, unknown>): MatrixEventRecord {
  const eventId = typeof pdu.event_id === 'string' && pdu.event_id ? pdu.event_id : computeEventId(pdu);
  return {
    eventId,
    roomId: String(pdu.room_id ?? ''),
    type: String(pdu.type ?? ''),
    sender: String(pdu.sender ?? ''),
    originServerTs: Number(pdu.origin_server_ts ?? 0),
    ...(typeof pdu.depth === 'number' ? { depth: pdu.depth } : {}),
    content: (pdu.content ?? {}) as Record<string, unknown>,
    ...(pdu.state_key === undefined ? {} : { stateKey: String(pdu.state_key) }),
    event: pdu,
  };
}
