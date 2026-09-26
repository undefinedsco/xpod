/**
 * Room version 11 state resolution (v2 state resolution).
 *
 * Source: `content/rooms/fragments/v2-state-res.md` (matrix-spec `main`), which room
 * version 11 inherits unchanged. The algorithm's five steps are numbered in
 * `resolveState` so the code can be read against the specification.
 *
 * Why this exists: two writers can append to the same room at the same time, which
 * the event graph accepts as a fork. The graph settles *which events exist*; this
 * module settles *which state wins*, so two deployments that saw the same events in
 * different orders still agree on membership and power levels.
 *
 * The auth checks inside use `protocol/authRules.ts`, so a state event that its own
 * auth chain does not authorise is ignored rather than applied.
 */
import { authorizeEvent, userPowerLevel, type AuthEvent } from './authRules';

export interface StateResolutionEvent {
  event_id: string;
  room_id?: string;
  type?: string;
  state_key?: string;
  sender?: string;
  content?: Record<string, unknown>;
  origin_server_ts?: number;
  auth_events?: string[];
  prev_events?: string[];
  /** Events rejected on receipt may still participate, per the specification. */
  rejected?: boolean;
}

/** Looks events up by id; the auth chain and mainline walks need the whole room. */
export interface StateResolutionStore {
  event(eventId: string): StateResolutionEvent | undefined;
}

/** One slot of room state, keyed `type|state_key`. */
export type StateKey = string;
/** A state map: slot → event id. */
export type StateMap = Map<StateKey, string>;

/** The slot an event occupies, or `undefined` for timeline events. */
export function stateKeyOf(event: StateResolutionEvent): StateKey | undefined {
  if (event.state_key === undefined) return undefined;
  return `${event.type ?? ''}|${event.state_key}`;
}

/** S′(E): the state after E, which only changes when E is a state event. */
export function stateAfter(event: StateResolutionEvent, state: StateMap): StateMap {
  const next = new Map(state);
  const key = stateKeyOf(event);
  if (key !== undefined) next.set(key, event.event_id);
  return next;
}

/** A power event can remove someone's ability to do something. */
export function isPowerEvent(event: StateResolutionEvent | undefined): boolean {
  if (!event || event.state_key === undefined) return false;
  if (event.type === 'm.room.power_levels' || event.type === 'm.room.join_rules') return true;
  return event.type === 'm.room.member'
    && (event.content?.membership === 'leave' || event.content?.membership === 'ban')
    && event.sender !== event.state_key;
}

export interface StateClassification {
  /** Keys that every state map agrees on. */
  unconflicted: StateMap;
  /** Every value of a key the states disagree about, plus keys missing somewhere. */
  conflicted: Set<string>;
}

export function classifyStates(states: readonly StateMap[]): StateClassification {
  const keys = new Set<string>();
  for (const state of states) for (const key of state.keys()) keys.add(key);
  const unconflicted: StateMap = new Map();
  const conflicted = new Set<string>();
  for (const key of keys) {
    const values = new Set<string>();
    let presentEverywhere = true;
    for (const state of states) {
      const value = state.get(key);
      if (value === undefined) presentEverywhere = false;
      else values.add(value);
    }
    if (presentEverywhere && values.size === 1) {
      unconflicted.set(key, [ ...values ][0]);
      continue;
    }
    for (const value of values) conflicted.add(value);
  }
  return { unconflicted, conflicted };
}

/** Every event reachable through `auth_events`, excluding the event itself. */
export function authChain(eventId: string, store: StateResolutionStore, into = new Set<string>()): Set<string> {
  const event = store.event(eventId);
  if (!event) return into;
  for (const authEventId of event.auth_events ?? []) {
    if (into.has(authEventId)) continue;
    into.add(authEventId);
    authChain(authEventId, store, into);
  }
  return into;
}

/** ∪Cᵢ − ∩Cᵢ over the states' full auth chains. */
export function authDifference(states: readonly StateMap[], store: StateResolutionStore): Set<string> {
  // The auth chain of E is E's auth events and theirs, recursively: E itself is not
  // part of its own chain. A state event that differs between the states is already
  // in the conflicted set, so leaving it out here does not lose it.
  const chains = states.map((state) => {
    const chain = new Set<string>();
    for (const eventId of state.values()) authChain(eventId, store, chain);
    return chain;
  });
  const difference = new Set<string>();
  for (const chain of chains) {
    for (const eventId of chain) {
      if (!chains.every(other => other.has(eventId))) difference.add(eventId);
    }
  }
  return difference;
}

/**
 * Reverse topological power ordering: a topological sort of the auth-event DAG,
 * picking the smallest candidate at each step. "Smallest" is defined by the
 * specification's comparison relation: greater sender power first, then earlier
 * `origin_server_ts`, then the smaller event id.
 */
export function reverseTopologicalPowerOrdering(
  events: readonly StateResolutionEvent[],
  store: StateResolutionStore,
): StateResolutionEvent[] {
  const byId = new Map(events.map(event => [ event.event_id, event ]));
  const incoming = new Map<string, number>(events.map(event => [ event.event_id, 0 ]));
  const outgoing = new Map<string, string[]>();
  for (const event of events) {
    for (const authEventId of event.auth_events ?? []) {
      if (!byId.has(authEventId)) continue;
      incoming.set(event.event_id, (incoming.get(event.event_id) ?? 0) + 1);
      outgoing.set(authEventId, [ ...(outgoing.get(authEventId) ?? []), event.event_id ]);
    }
  }
  const remaining = new Set(events.map(event => event.event_id));
  const sorted: StateResolutionEvent[] = [];
  while (remaining.size > 0) {
    const candidates = [ ...remaining ].filter(eventId => (incoming.get(eventId) ?? 0) === 0);
    if (candidates.length === 0) {
      // The candidates form a cycle, which cannot happen in a valid auth DAG. Rather
      // than drop events silently, fall back to the comparison relation over what is
      // left so resolution stays deterministic.
      candidates.push(...remaining);
    }
    candidates.sort((left, right) => compareByPower(byId.get(left)!, byId.get(right)!, store));
    const chosen = candidates[0];
    remaining.delete(chosen);
    sorted.push(byId.get(chosen)!);
    for (const child of outgoing.get(chosen) ?? []) {
      incoming.set(child, (incoming.get(child) ?? 0) - 1);
    }
  }
  return sorted;
}

function compareByPower(left: StateResolutionEvent, right: StateResolutionEvent, store: StateResolutionStore): number {
  const leftPower = senderPower(left, store);
  const rightPower = senderPower(right, store);
  if (leftPower !== rightPower) return rightPower - leftPower; // greater power first
  const leftTs = left.origin_server_ts ?? 0;
  const rightTs = right.origin_server_ts ?? 0;
  if (leftTs !== rightTs) return leftTs - rightTs;
  return left.event_id < right.event_id ? -1 : left.event_id > right.event_id ? 1 : 0;
}

/** The sender's power level according to the event's own auth events. */
function senderPower(event: StateResolutionEvent, store: StateResolutionStore): number {
  const authEvents = (event.auth_events ?? []).map(id => store.event(id)).filter((entry): entry is StateResolutionEvent => entry !== undefined);
  const powerLevels = authEvents.find(entry => entry.type === 'm.room.power_levels')?.content;
  const creator = authEvents.find(entry => entry.type === 'm.room.create')?.sender;
  return userPowerLevel({ powerLevels, userId: event.sender ?? '', creator });
}

/**
 * The mainline of a power levels event: the chain of power levels events reachable
 * through `auth_events`, newest first.
 */
export function mainlineOf(powerLevels: StateResolutionEvent, store: StateResolutionStore): StateResolutionEvent[] {
  const mainline = [ powerLevels ];
  const seen = new Set([ powerLevels.event_id ]);
  let current = powerLevels;
  for (;;) {
    const next = (current.auth_events ?? [])
      .map(id => store.event(id))
      .find((entry): entry is StateResolutionEvent => entry !== undefined && entry.type === 'm.room.power_levels');
    if (!next || seen.has(next.event_id)) return mainline;
    seen.add(next.event_id);
    mainline.push(next);
    current = next;
  }
}

/**
 * The mainline position of an event: the index in `mainline` of the first power
 * levels event found while walking the event's own power levels chain, or
 * `Number.POSITIVE_INFINITY` when it never touches the mainline.
 */
export function mainlinePosition(
  event: StateResolutionEvent,
  mainline: readonly StateResolutionEvent[],
  store: StateResolutionStore,
): number {
  const positions = new Map(mainline.map((entry, index) => [ entry.event_id, index ]));
  const seen = new Set([ event.event_id ]);
  let current = event;
  for (;;) {
    const next = (current.auth_events ?? [])
      .map(id => store.event(id))
      .find((entry): entry is StateResolutionEvent => entry !== undefined && entry.type === 'm.room.power_levels');
    if (!next || seen.has(next.event_id)) return Number.POSITIVE_INFINITY;
    if (positions.has(next.event_id)) return positions.get(next.event_id)!;
    seen.add(next.event_id);
    current = next;
  }
}

/**
 * Mainline ordering: earlier mainlines first (a greater position means the event's
 * auth chain is based on an *earlier* power levels event), then by timestamp, then
 * by event id.
 */
export function mainlineOrdering(
  events: readonly StateResolutionEvent[],
  powerLevels: StateResolutionEvent | undefined,
  store: StateResolutionStore,
): StateResolutionEvent[] {
  const mainline = powerLevels ? mainlineOf(powerLevels, store) : [];
  const positions = new Map(events.map(event => [ event.event_id, mainlinePosition(event, mainline, store) ]));
  return [ ...events ].sort((left, right) => {
    const leftPosition = positions.get(left.event_id)!;
    const rightPosition = positions.get(right.event_id)!;
    if (leftPosition !== rightPosition) return rightPosition - leftPosition;
    const leftTs = left.origin_server_ts ?? 0;
    const rightTs = right.origin_server_ts ?? 0;
    if (leftTs !== rightTs) return leftTs - rightTs;
    return left.event_id < right.event_id ? -1 : left.event_id > right.event_id ? 1 : 0;
  });
}

/**
 * Iterative auth checks: apply each state event in order if the authorisation rules
 * allow it against the state built so far, otherwise ignore it.
 *
 * When the running state lacks a slot the rules need, the event's own auth events
 * supply it — unless that entry was rejected, in which case it must not be used.
 */
export function iterativeAuthChecks(
  initialState: StateMap,
  ordered: readonly StateResolutionEvent[],
  store: StateResolutionStore,
): StateMap {
  let state = new Map(initialState);
  for (const event of ordered) {
    if (stateKeyOf(event) === undefined) continue;
    const authEvents = authEventsForCheck(event, state, store);
    const decision = authorizeEvent(toAuthorizable(event), authEvents);
    if (decision.allowed) state = stateAfter(event, state);
  }
  return state;
}

/**
 * The resolution of a set of states. Steps mirror the specification:
 * 1. power events in the full conflicted set, plus their conflicted auth chains;
 * 2. iterative auth checks for those, starting from the unconflicted state;
 * 3. the rest, ordered by the mainline of the partially resolved power levels;
 * 4. iterative auth checks again;
 * 5. the unconflicted state map wins over anything the checks changed.
 */
export function resolveState(states: readonly StateMap[], store: StateResolutionStore): StateMap {
  if (states.length === 0) return new Map();
  if (states.length === 1) return new Map(states[0]);

  const { unconflicted, conflicted } = classifyStates(states);
  const fullConflicted = new Set<string>([ ...conflicted, ...authDifference(states, store) ]);

  // 1.
  const powerEvents = [ ...fullConflicted ]
    .map(id => store.event(id))
    .filter((event): event is StateResolutionEvent => isPowerEvent(event));
  const powerSet = new Set(powerEvents.map(event => event.event_id));
  // Walk a worklist rather than the array being extended: every power event enlarged
  // by the conflicted part of its auth chain, transitively.
  const queue = [ ...powerEvents ];
  while (queue.length > 0) {
    const event = queue.pop()!;
    for (const authEventId of authChain(event.event_id, store)) {
      if (!fullConflicted.has(authEventId) || powerSet.has(authEventId)) continue;
      const authEvent = store.event(authEventId);
      if (!authEvent) continue;
      powerSet.add(authEventId);
      powerEvents.push(authEvent);
      queue.push(authEvent);
    }
  }

  // 2.
  let resolved = iterativeAuthChecks(unconflicted, reverseTopologicalPowerOrdering(powerEvents, store), store);

  // 3.
  const remaining = [ ...fullConflicted ]
    .filter(eventId => !powerSet.has(eventId))
    .map(id => store.event(id))
    .filter((event): event is StateResolutionEvent => event !== undefined);
  const partialPowerLevels = [ ...resolved.entries() ]
    .map(([ , eventId ]) => store.event(eventId))
    .find((event): event is StateResolutionEvent => event?.type === 'm.room.power_levels');

  // 4.
  resolved = iterativeAuthChecks(resolved, mainlineOrdering(remaining, partialPowerLevels, store), store);

  // 5.
  for (const [ key, eventId ] of unconflicted) resolved.set(key, eventId);
  return resolved;
}

function authEventsForCheck(event: StateResolutionEvent, state: StateMap, store: StateResolutionStore): AuthEvent[] {
  const wanted: Array<[string, string]> = [
    [ 'm.room.create', '' ],
    [ 'm.room.power_levels', '' ],
    [ 'm.room.member', event.sender ?? '' ],
  ];
  if (event.type === 'm.room.member') {
    wanted.push([ 'm.room.member', event.state_key ?? '' ]);
    const membership = event.content?.membership;
    if (membership === 'join' || membership === 'invite' || membership === 'knock') {
      wanted.push([ 'm.room.join_rules', '' ]);
    }
  }

  const own = new Map<StateKey, StateResolutionEvent>();
  for (const authEventId of event.auth_events ?? []) {
    const authEvent = store.event(authEventId);
    const key = authEvent ? stateKeyOf(authEvent) : undefined;
    if (authEvent && key !== undefined) own.set(key, authEvent);
  }

  const selected: AuthEvent[] = [];
  const seen = new Set<StateKey>();
  for (const [ type, stateKey ] of wanted) {
    const slot = `${type}|${stateKey}`;
    if (seen.has(slot)) continue;
    seen.add(slot);
    const fromState = state.get(slot);
    const candidate = (fromState === undefined ? undefined : store.event(fromState)) ?? own.get(slot);
    if (!candidate || candidate.rejected === true) continue;
    selected.push(candidate);
  }
  return selected;
}

function toAuthorizable(event: StateResolutionEvent): Parameters<typeof authorizeEvent>[0] {
  return {
    event_id: event.event_id,
    type: event.type ?? '',
    sender: event.sender ?? '',
    room_id: event.room_id ?? '',
    content: event.content ?? {},
    ...(event.state_key === undefined ? {} : { state_key: event.state_key }),
    ...(event.auth_events === undefined ? {} : { auth_events: event.auth_events }),
    ...(event.prev_events === undefined ? {} : { prev_events: event.prev_events }),
    ...(event.rejected === undefined ? {} : { rejected: event.rejected }),
  };
}
