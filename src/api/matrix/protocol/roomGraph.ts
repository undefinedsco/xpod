/**
 * Where a new event attaches in the room's event graph.
 *
 * These are protocol facts, not local bookkeeping: `prev_events`, `auth_events`
 * and `depth` are part of the event, so they are covered by the event id and the
 * signature, and a reader needs them to walk the room's dependencies. Rules and
 * sources (matrix-spec `main`, fetched 2026-09-27):
 *
 * - `content/server-server-api.md` § PDUs: `prev_events` identifies the parents
 *   and "the sending server should populate this field with all of the events in
 *   the room for which it has not yet seen a child" — the forward extremities.
 * - `data/api/server-server/definitions/components/depth_v6.yaml`: `depth` is "the
 *   maximum depth of the `prev_events`, plus one", capped at 2^53-1.
 * - `content/server-server-api.md` § Auth events selection: the `m.room.create`
 *   event (required by room version 11, see the v8 auth rules note), the current
 *   `m.room.power_levels`, the sender's membership, and for `m.room.member` the
 *   target's membership plus the join rules for `join`/`invite`/`knock`.
 * - Caps: at most 20 `prev_events` and 10 `auth_events`.
 *
 * What this module deliberately does not do: resolve state. Concurrent writers
 * may both attach to the same extremity — a fork is legitimate in Matrix — and the
 * next event then lists both extremities as parents, which merges them. Deciding
 * which side of a fork wins for *state* is state resolution, which is not
 * implemented here.
 */
export interface RoomGraphEvent {
  eventId: string;
  type: string;
  sender: string;
  stateKey?: string;
  content: Record<string, unknown>;
  /** Local ordering (the store's sequence): decides "current" state and breaks ties. */
  sequence: number;
  prevEvents: readonly string[];
  /** Depth as stored on the event; absent for events written before this was recorded. */
  depth?: number;
}

/** The facts about the event being created that the selection rules depend on. */
export interface NewRoomEvent {
  type: string;
  sender: string;
  stateKey?: string;
  content: Record<string, unknown>;
}

export interface RoomGraphPosition {
  prevEvents: string[];
  authEvents: string[];
  depth: number;
}

export const MAX_PREV_EVENTS = 20;
export const MAX_AUTH_EVENTS = 10;
/** `depth` "must be less than the maximum value for an integer (2^53 - 1)". */
export const MAX_EVENT_DEPTH = Number.MAX_SAFE_INTEGER;

/**
 * The parents, authorising events and depth a new event must carry.
 *
 * Every value is derived from events the caller can see, so two deployments
 * looking at the same Pod room produce the same position for the same event.
 */
export function roomGraphPosition(events: readonly RoomGraphEvent[], next: NewRoomEvent): RoomGraphPosition {
  if (next.type === 'm.room.create') {
    // The create event is the root of the room: the auth rules reject it if it has
    // any prev_events, its depth is the first one, and it has nothing to authorise it.
    return { prevEvents: [], authEvents: [], depth: 1 };
  }
  const prevEvents = forwardExtremityIds(events, { limit: MAX_PREV_EVENTS });
  return {
    prevEvents,
    authEvents: authEventsFor(events, next),
    depth: nextDepth(events, prevEvents),
  };
}

/**
 * The events nothing else references yet: the forward extremities.
 *
 * Ordered newest first so a cap keeps the events a receiver is least likely to have
 * already missed. `prev_events` itself caps at 20; state resolution needs all of
 * them, so the cap is the caller's choice rather than baked in.
 */
export function forwardExtremityIds(
  events: readonly RoomGraphEvent[],
  options: { limit?: number } = {},
): string[] {
  const hasChild = new Set<string>();
  for (const event of events) for (const prev of event.prevEvents) hasChild.add(prev);
  const ordered = events
    .filter(event => !hasChild.has(event.eventId))
    .sort((left, right) =>
      (depthOf(right) - depthOf(left)) || (right.sequence - left.sequence) || left.eventId.localeCompare(right.eventId))
    .map(event => event.eventId);
  return options.limit === undefined ? ordered : ordered.slice(0, options.limit);
}

function nextDepth(events: readonly RoomGraphEvent[], prevEvents: readonly string[]): number {
  if (prevEvents.length === 0) return 1;
  const byId = new Map(events.map(event => [ event.eventId, event ]));
  const deepest = Math.max(...prevEvents.map(eventId => depthOf(byId.get(eventId))));
  return Math.min(deepest + 1, MAX_EVENT_DEPTH);
}

/**
 * The auth events selection. Only the sender's own permission is described here:
 * whether the event is *allowed* is the auth rules' job, which this store does not
 * implement yet. Selection is ordered so the same room state always yields the
 * same array, since arrays are hashed in order.
 */
function authEventsFor(events: readonly RoomGraphEvent[], next: NewRoomEvent): string[] {
  const selected: string[] = [];
  const select = (event: RoomGraphEvent | undefined): void => {
    if (event && !selected.includes(event.eventId)) selected.push(event.eventId);
  };
  // Room version 11 requires the create event among the entries.
  select(currentState(events, 'm.room.create', ''));
  select(currentState(events, 'm.room.power_levels', ''));
  select(currentState(events, 'm.room.member', next.sender));
  if (next.type === 'm.room.member') {
    select(currentState(events, 'm.room.member', next.stateKey ?? ''));
    const membership = typeof next.content.membership === 'string' ? next.content.membership : undefined;
    if (membership === 'join' || membership === 'invite' || membership === 'knock') {
      select(currentState(events, 'm.room.join_rules', ''));
    }
  }
  return selected.slice(0, MAX_AUTH_EVENTS);
}

/** The event that currently holds a state slot: the latest one by local order. */
function currentState(events: readonly RoomGraphEvent[], type: string, stateKey: string): RoomGraphEvent | undefined {
  let current: RoomGraphEvent | undefined;
  for (const event of events) {
    if (event.type !== type || (event.stateKey ?? '') !== stateKey) continue;
    if (!current || event.sequence > current.sequence) current = event;
  }
  return current;
}

/**
 * An event's depth. Events written before the graph was recorded have none; they
 * are treated as the first event of their chain, which keeps the claim `depth`
 * actually makes — greater than every parent — true without inventing history.
 */
function depthOf(event: RoomGraphEvent | undefined): number {
  return typeof event?.depth === 'number' && Number.isSafeInteger(event.depth) && event.depth > 0
    ? event.depth
    : 1;
}
