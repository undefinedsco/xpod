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

/**
 * A room's replay, kept so an appended event costs the work of that event rather than
 * of the whole room.
 *
 * Replaying answers two questions: what state precedes an event, and what state the
 * room is in now. Only the extremities' states are needed for both, so the replay
 * keeps those and the protocol form of every event it has seen — the latter because an
 * auth chain or a mainline walk starts from a *new* event and reaches back into events
 * that may no longer be extremities.
 *
 * `extend` accepts a list that only appended leaves. Anything else — a backfill whose
 * parent is no longer an extremity, or a list that dropped events — returns `undefined`
 * so the caller replays in full instead of quietly computing a wrong state.
 */
export class MatrixRoomStateReplay {
  private constructor(
    private readonly protocolById: Map<string, StateResolutionEvent>,
    private readonly knownIds: Set<string>,
    private readonly extremityStates: Map<string, StateMap>,
    public readonly state: MatrixRoomState,
  ) {}

  /** Replay the whole list. */
  public static from(events: readonly MatrixEventRecord[]): MatrixRoomStateReplay {
    if (events.length === 0) {
      return new MatrixRoomStateReplay(new Map(), new Set(), new Map(), new MatrixRoomState(new Map()));
    }
    const recordsById = new Map(events.map(event => [ event.eventId, event ]));
    // Rows written before the graph was recorded carry no parents, so every one of them
    // would look like a root and resolution would be meaningless. Fall back to the
    // previous rule for such a room; migration is tracked separately (D5).
    if (events.every(event => event.event === undefined)) {
      return new MatrixRoomStateReplay(new Map(), new Set(events.map(event => event.eventId)), new Map(),
        latestStatePerSlot(events));
    }

    const protocolById = new Map<string, StateResolutionEvent>();
    for (const record of events) protocolById.set(record.eventId, protocolEventOf(record));
    const store: StateResolutionStore = { event: eventId => protocolById.get(eventId) };

    // S(E) is the resolution of the states after E's parents, so states are built in
    // causal order and only the extremities survive the pass.
    const afterById = new Map<string, StateMap>();
    for (const record of topologicalOrder(events)) {
      const event = protocolById.get(record.eventId)!;
      const parentStates = (event.prev_events ?? [])
        .map(parentId => afterById.get(parentId))
        .filter((state): state is StateMap => state !== undefined);
      afterById.set(record.eventId, stateAfter(event, parentStates.length === 0
        ? new Map<StateKey, string>()
        : resolveState(dedupeStates(parentStates), store)));
    }

    const extremities = forwardExtremityIds(events.map(graphEventOf));
    const extremityStates = new Map<StateKey, StateMap>();
    for (const eventId of extremities) {
      const state = afterById.get(eventId);
      if (state) extremityStates.set(eventId, state);
    }
    return new MatrixRoomStateReplay(protocolById, new Set(events.map(event => event.eventId)), extremityStates,
      materialize(resolveState([ ...extremityStates.values() ], store), recordsById));
  }

  /**
   * Extend this replay with events appended after it was built, or `undefined` when the
   * list is not such an extension.
   */
  public extend(events: readonly MatrixEventRecord[]): MatrixRoomStateReplay | undefined {
    // A legacy room has no graph to extend, and its fallback state is order-dependent.
    if (this.protocolById.size === 0 && this.knownIds.size > 0) return undefined;
    const recordsById = new Map(events.map(event => [ event.eventId, event ]));
    // Every extremity must still be there: a list that dropped one is not an extension.
    for (const eventId of this.extremityStates.keys()) {
      if (!recordsById.has(eventId)) return undefined;
    }
    const added = events.filter(event => !this.knownIds.has(event.eventId));
    if (added.length === 0) {
      return events.length === this.knownIds.size ? this : undefined;
    }
    const addedIds = new Set(added.map(event => event.eventId));
    const protocolById = new Map(this.protocolById);
    for (const record of added) protocolById.set(record.eventId, protocolEventOf(record));
    const store: StateResolutionStore = { event: eventId => protocolById.get(eventId) };

    // A new event may hang off a current extremity or off another new event. Anything
    // else is a backfill into the middle, which this replay cannot absorb.
    for (const record of added) {
      for (const parentId of parentIdsOf(record)) {
        if (!recordsById.has(parentId)) continue;
        if (!this.extremityStates.has(parentId) && !addedIds.has(parentId)) return undefined;
      }
    }

    const states = new Map(this.extremityStates);
    const extremities = new Set(this.extremityStates.keys());
    for (const record of topologicalOrder(added)) {
      const event = protocolById.get(record.eventId)!;
      for (const parentId of event.prev_events ?? []) extremities.delete(parentId);
      const parentStates = (event.prev_events ?? [])
        .map(parentId => states.get(parentId))
        .filter((state): state is StateMap => state !== undefined);
      states.set(record.eventId, stateAfter(event, parentStates.length === 0
        ? new Map<StateKey, string>()
        : resolveState(dedupeStates(parentStates), store)));
      extremities.add(record.eventId);
    }

    // Keep only what the next extension can use: extremities, not every event's state.
    const nextExtremities = new Map<StateKey, StateMap>();
    for (const eventId of extremities) {
      const state = states.get(eventId);
      if (state) nextExtremities.set(eventId, state);
    }
    const knownIds = new Set(this.knownIds);
    for (const record of added) knownIds.add(record.eventId);
    return new MatrixRoomStateReplay(protocolById, knownIds, nextExtremities,
      materialize(resolveState([ ...nextExtremities.values() ], store), recordsById));
  }
}

/** Resolve the state of the room the given events belong to. */
export function resolveRoomState(events: readonly MatrixEventRecord[]): MatrixRoomState {
  return MatrixRoomStateReplay.from(events).state;
}

function materialize(resolved: StateMap, recordsById: Map<string, MatrixEventRecord>): MatrixRoomState {
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
