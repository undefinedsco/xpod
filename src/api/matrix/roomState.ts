/**
 * The room's state, resolved across forks.
 *
 * Reading the "current" state as "the latest state event by local order" is only
 * correct while the room is a chain. A fork — two writers attaching to the same
 * parent, which the event graph allows — makes two different events claim the same
 * slot, and then the answer has to come from the room version's state resolution,
 * not from arrival order. This module does the replay: it derives the state after
 * every event from its `prev_events`, then resolves the states of the events that
 * have no child yet.
 *
 * The replay is pure and takes events the caller already read, so it adds no Pod
 * round trip. It is O(events × state size) per call, which is why callers should
 * compute it once per operation instead of per event.
 */
import { resolveState, stateAfter, type StateKey, type StateMap, type StateResolutionEvent, type StateResolutionStore } from './protocol/stateResolution';
import { forwardExtremityIds, type RoomGraphEvent } from './protocol/roomGraph';
import type { MatrixEventRecord } from './types';

/** State slots the room currently has, by `type|state_key`. */
export class MatrixRoomState {
  private readonly slots: Map<StateKey, MatrixEventRecord>;

  public constructor(slots: Map<StateKey, MatrixEventRecord>) {
    this.slots = slots;
  }

  public get(type: string, stateKey = ''): MatrixEventRecord | undefined {
    return this.slots.get(`${type}|${stateKey}`);
  }

  /** A member's current membership, or `undefined` if the room never saw them. */
  public membership(userId: string): string | undefined {
    const membership = this.get('m.room.member', userId)?.content.membership;
    return typeof membership === 'string' ? membership : undefined;
  }

  public events(): MatrixEventRecord[] {
    return [ ...this.slots.values() ];
  }

  public entries(): Array<[StateKey, MatrixEventRecord]> {
    return [ ...this.slots.entries() ];
  }

  public get size(): number {
    return this.slots.size;
  }
}

/** Resolve the state of the room the given events belong to. */
export function resolveRoomState(events: readonly MatrixEventRecord[]): MatrixRoomState {
  if (events.length === 0) return new MatrixRoomState(new Map());

  const recordsById = new Map(events.map(event => [ event.eventId, event ]));
  // Rows written before the graph was recorded carry no parents, so every one of them
  // would look like a root and resolution would be meaningless. Fall back to the
  // previous rule for such a room; migration is tracked separately (D5).
  if (events.every(event => event.event === undefined)) return latestStatePerSlot(events);

  const protocolById = new Map<string, StateResolutionEvent>();
  for (const record of events) protocolById.set(record.eventId, protocolEventOf(record));
  const store: StateResolutionStore = { event: eventId => protocolById.get(eventId) };

  // S(E) is the resolution of the states after E's parents, so the states have to be
  // built in causal order.
  const afterById = new Map<string, StateMap>();
  for (const record of topologicalOrder(events)) {
    const event = protocolEventOf(record);
    const parentStates = (event.prev_events ?? [])
      .map(parentId => afterById.get(parentId))
      .filter((state): state is StateMap => state !== undefined);
    const before = parentStates.length === 0
      ? new Map<StateKey, string>()
      : resolveState(dedupeStates(parentStates), store);
    afterById.set(record.eventId, stateAfter(event, before));
  }

  const extremityStates = forwardExtremityIds(events.map(graphEventOf))
    .map(eventId => afterById.get(eventId))
    .filter((state): state is StateMap => state !== undefined);
  const resolved = resolveState(extremityStates, store);

  const slots = new Map<StateKey, MatrixEventRecord>();
  for (const [ key, eventId ] of resolved) {
    const record = recordsById.get(eventId);
    if (record) slots.set(key, record);
  }
  return new MatrixRoomState(slots);
}

/** Today's rule, kept only for rooms written before the graph existed. */
function latestStatePerSlot(events: readonly MatrixEventRecord[]): MatrixRoomState {
  const slots = new Map<StateKey, MatrixEventRecord>();
  for (const event of [ ...events ].sort((left, right) => (left.depth ?? 0) - (right.depth ?? 0))) {
    if (event.stateKey === undefined) continue;
    slots.set(`${event.type}|${event.stateKey}`, event);
  }
  return new MatrixRoomState(slots);
}

/**
 * Causal order by `prev_events`, with the store's own sequence as the tie-break so
 * the result is deterministic. An event whose parent is missing (a dependency gap)
 * starts a chain of its own instead of being dropped.
 */
function topologicalOrder(events: readonly MatrixEventRecord[]): MatrixEventRecord[] {
  const byId = new Map(events.map(event => [ event.eventId, event ]));
  const remaining = new Map(events.map(event => [ event.eventId, parentIdsOf(event).filter(id => byId.has(id)) ]));
  const ordered: MatrixEventRecord[] = [];
  const emitted = new Set<string>();
  while (remaining.size > 0) {
    const ready = [ ...remaining ]
      .filter(([ , parents ]) => parents.every(parentId => emitted.has(parentId)))
      .map(([ eventId ]) => byId.get(eventId)!)
      .sort((left, right) => ((left.depth ?? 0) - (right.depth ?? 0)) || left.eventId.localeCompare(right.eventId));
    if (ready.length === 0) {
      // A parent cycle cannot come from valid events, but do not drop the rest.
      const [ eventId ] = [ ...remaining.keys() ].sort();
      ordered.push(byId.get(eventId)!);
      emitted.add(eventId);
      remaining.delete(eventId);
      continue;
    }
    for (const event of ready) {
      ordered.push(event);
      emitted.add(event.eventId);
      remaining.delete(event.eventId);
    }
  }
  return ordered;
}

function dedupeStates(states: readonly StateMap[]): StateMap[] {
  const unique: StateMap[] = [];
  for (const state of states) {
    if (!unique.some(candidate => sameState(candidate, state))) unique.push(state);
  }
  return unique;
}

function sameState(left: StateMap, right: StateMap): boolean {
  if (left.size !== right.size) return false;
  for (const [ key, value ] of left) if (right.get(key) !== value) return false;
  return true;
}

function graphEventOf(event: MatrixEventRecord): RoomGraphEvent {
  return {
    eventId: event.eventId,
    type: event.type,
    sender: event.sender,
    stateKey: event.stateKey,
    content: event.content,
    sequence: event.depth ?? 0,
    prevEvents: parentIdsOf(event),
    depth: numberOrUndefined(persistedEventOf(event)?.depth),
  };
}

function parentIdsOf(event: MatrixEventRecord): string[] {
  return stringList(persistedEventOf(event)?.prev_events);
}

function protocolEventOf(event: MatrixEventRecord): StateResolutionEvent {
  const stored = persistedEventOf(event);
  return {
    event_id: event.eventId,
    room_id: event.roomId,
    type: event.type,
    sender: event.sender,
    content: event.content,
    origin_server_ts: event.originServerTs,
    auth_events: stringList(stored?.auth_events),
    prev_events: stringList(stored?.prev_events),
    ...(event.stateKey === undefined ? {} : { state_key: event.stateKey }),
  };
}

function persistedEventOf(event: MatrixEventRecord): Record<string, unknown> | undefined {
  const stored = event.event;
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}
