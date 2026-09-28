/**
 * Room version 11 event authorization.
 *
 * Source: `content/rooms/v11.md` § "Authorisation rules" (fetched from matrix-spec
 * `main`; v11 differs from v10 in rule 1 — a create event no longer carries a
 * `creator`, the sender is the creator — and in rule 4.3.1, which compares the
 * joiner against the sender of the create event).
 *
 * The rules are numbered in the comments so a reader can diff this file against the
 * specification. Two deliberate deviations, both fail-closed rather than permissive,
 * because this deployment does not implement the machinery behind them:
 *
 * - third-party invites are rejected (`m.room.third_party_invite` is not supported);
 * - restricted joins are only allowed when the target is already joined or invited,
 *   where the rules do not require the extra server signature. Anything that needs
 *   `join_authorised_via_users_server` to be validated is rejected.
 *
 * What this module does *not* do: resolve state, and it does not check signatures.
 * It judges one event against the authorising events the sender selected; deciding
 * which state is current after a fork is state resolution, and the caller is
 * responsible for having verified that the event is signed by the server named in
 * `sender` (v11 preamble: "Events must be signed by the server denoted by the
 * `sender` property").
 */
export interface AuthEvent {
  event_id?: string;
  type?: string;
  state_key?: string;
  sender?: string;
  room_id?: string;
  content?: Record<string, unknown>;
  prev_events?: string[];
  /** Set when this event was rejected on receipt; selected auth events must not be. */
  rejected?: boolean;
}

export interface AuthorizableEvent extends AuthEvent {
  type: string;
  sender: string;
  room_id: string;
  content: Record<string, unknown>;
}

export interface EventAuthDecision {
  allowed: boolean;
  /** Rule identifier plus a short explanation, e.g. `v11-4.3.3: sender is banned`. */
  reason: string;
}

/** The only room version this deployment validates. */
export const SUPPORTED_ROOM_VERSION = '11';

/** Defaults from the `m.room.power_levels` event definition. */
const DEFAULT_POWER_LEVELS = {
  ban: 50,
  kick: 50,
  redact: 50,
  invite: 0,
  users_default: 0,
  events_default: 0,
  state_default: 50,
} as const;

const INVITE_LEVEL_KEYS = [ 'users_default', 'events_default', 'state_default', 'ban', 'redact', 'kick', 'invite' ] as const;

/**
 * A stored or received event as the auth rules want to see it.
 *
 * Lives here because `AuthEvent` does: every caller that has to authorise an event — a receiver
 * judging a PDU, a handler resolving a chain, and (next) the write path before it stores what it
 * built — needs the same projection, and two of them drifting apart would mean one event judged
 * two ways.
 */
export function toAuthEvent(event: Record<string, unknown>): AuthEvent {
  return {
    event_id: typeof event.event_id === 'string' ? event.event_id : undefined,
    type: String(event.type ?? ''),
    sender: String(event.sender ?? ''),
    room_id: String(event.room_id ?? ''),
    content: (event.content ?? {}) as Record<string, unknown>,
    ...(event.state_key === undefined ? {} : { state_key: String(event.state_key) }),
    prev_events: [],
  };
}

export function authorizeEvent(event: AuthorizableEvent, authEvents: readonly AuthEvent[]): EventAuthDecision {
  const roomVersion = typeof event.content.room_version === 'string' ? event.content.room_version : undefined;

  // 1. m.room.create is the room's root and is judged on its own.
  if (event.type === 'm.room.create') {
    if ((event.prev_events ?? []).length > 0) return deny('v11-1.1: create event has prev_events');
    const senderServer = serverNameOf(event.sender);
    if (!senderServer || senderServer !== serverNameOf(event.room_id)) {
      return deny('v11-1.2: room_id domain does not match the sender domain');
    }
    if (roomVersion !== undefined && roomVersion !== SUPPORTED_ROOM_VERSION) {
      return deny(`v11-1.3: unsupported room version ${roomVersion}`);
    }
    // v11-1.4 is gone: there is no `creator` property to require.
    return allow('v11-1.5: create event allowed');
  }

  // 2. The authorising events the sender selected must be the ones the selection
  //    algorithm allows, and must include this room's create event.
  const selected = checkAuthEvents(event, authEvents);
  if (!selected.allowed) return selected;

  const createEvent = authEvents.find(entry => entry.type === 'm.room.create');
  if (!createEvent) return deny('v11-2.4: no m.room.create event among auth_events');
  const creator = typeof createEvent.sender === 'string' ? createEvent.sender : undefined;
  const powerLevels = powerLevelsOf(authEvents);
  const senderPower = userPowerLevel({ powerLevels, userId: event.sender, creator });
  const senderMembership = membershipOf(authEvents, event.sender);
  const targetMembership = event.state_key === undefined ? undefined : membershipOf(authEvents, event.state_key);
  const joinRule = joinRuleOf(authEvents);

  // 3. A non-federated room only accepts events from its own server.
  if (createEvent.content?.['m.federate'] === false) {
    const createServer = typeof createEvent.sender === 'string' ? serverNameOf(createEvent.sender) : undefined;
    if (serverNameOf(event.sender) !== createServer) {
      return deny('v11-3: room is not federated and the sender is on another server');
    }
  }

  // 4. Membership transitions.
  if (event.type === 'm.room.member') {
    return authorizeMember(event, {
      creator,
      createEventId: createEvent.event_id,
      powerLevels,
      senderPower,
      senderMembership,
      targetMembership,
      joinRule,
    });
  }

  // 5. Everything else requires the sender to be joined.
  if (senderMembership !== 'join') return deny('v11-5: sender is not joined');

  // 6. Third-party invites are not supported by this deployment.
  if (event.type === 'm.room.third_party_invite') {
    return senderPower >= powerLevel(powerLevels, 'invite')
      ? allow('v11-6: sender may invite')
      : deny('v11-6: sender is below the invite level');
  }

  // 7. The event type's required power level.
  const required = requiredPowerForEvent(powerLevels, event.type, event.state_key !== undefined);
  if (required > senderPower) {
    return deny(`v11-7: ${event.type} requires power ${required}, sender has ${senderPower}`);
  }

  // 8. A state key naming a user may only be written by that user.
  if (event.state_key?.startsWith('@') && event.state_key !== event.sender) {
    return deny('v11-8: state_key names another user');
  }

  // 9. Power level changes may not exceed the sender's own power.
  if (event.type === 'm.room.power_levels') {
    return authorizePowerLevels(event, powerLevels, senderPower);
  }

  // 10.
  return allow('v11-10: allowed');
}

/**
 * 2. The `auth_events` the sender selected.
 *
 * The selection algorithm is implemented as the set of slots this event may name;
 * an entry outside that set is what rule 2.2 rejects. `rejected` is carried on
 * events we know were refused (rule 2.3); events without the marker are treated as
 * accepted, which is the case for everything this store writes.
 */
function checkAuthEvents(event: AuthorizableEvent, authEvents: readonly AuthEvent[]): EventAuthDecision {
  const slots = new Set<string>();
  slots.add(slotOf('m.room.create', ''));
  slots.add(slotOf('m.room.power_levels', ''));
  slots.add(slotOf('m.room.member', event.sender));
  if (event.type === 'm.room.member') {
    slots.add(slotOf('m.room.member', event.state_key ?? ''));
    const membership = event.content.membership;
    if (membership === 'join' || membership === 'invite' || membership === 'knock') {
      slots.add(slotOf('m.room.join_rules', ''));
    }
  }

  const seen = new Set<string>();
  for (const entry of authEvents) {
    const key = slotOf(entry.type ?? '', entry.state_key ?? '');
    if (seen.has(key)) return deny(`v11-2.1: duplicate auth event for ${key}`);
    seen.add(key);
    if (!slots.has(key)) return deny(`v11-2.2: ${key} is not an allowed auth event for ${event.type}`);
    if (entry.rejected === true) return deny(`v11-2.3: auth event ${key} was rejected`);
    if (entry.room_id !== event.room_id) {
      return deny(`v11-2.5: auth event ${key} belongs to another room`);
    }
  }
  if (!seen.has(slotOf('m.room.create', ''))) {
    return deny('v11-2.4: no m.room.create event among auth_events');
  }
  return allow('v11-2: auth events are consistent with the selection rules');
}

function authorizeMember(event: AuthorizableEvent, context: {
  creator?: string;
  createEventId?: string;
  powerLevels: Record<string, unknown> | undefined;
  senderPower: number;
  senderMembership?: string;
  targetMembership?: string;
  joinRule: string;
}): EventAuthDecision {
  const { creator, createEventId, powerLevels, senderPower, senderMembership, targetMembership, joinRule } = context;
  const stateKey = event.state_key;
  // 4.1.
  if (stateKey === undefined || stateKey === '') return deny('v11-4.1: member event needs a state_key');
  const membership = event.content.membership;
  if (typeof membership !== 'string') return deny('v11-4.1: member event needs content.membership');

  // 4.2.2 needs a signature this deployment cannot check, so anything that depends
  // on it is refused — except a join that 4.3.5.1 already allows without it.
  if (event.content.join_authorised_via_users_server !== undefined) {
    const alreadyIn = targetMembership === 'join' || targetMembership === 'invite';
    if (!(membership === 'join' && alreadyIn)) {
      return deny('v11-4.2.2: restricted joins are not supported');
    }
  }

  if (membership === 'join') {
    // 4.3.1: the creator's first join, whose only parent is the create event.
    if (isCreateOnlyParent(event, createEventId) && stateKey === creator) {
      return allow('v11-4.3.1: the create event sender joins the room it created');
    }
    if (event.sender !== stateKey) return deny('v11-4.3.2: sender does not match state_key');
    if (senderMembership === 'ban') return deny('v11-4.3.3: sender is banned');
    if (joinRule === 'invite' || joinRule === 'knock') {
      return targetMembership === 'invite' || targetMembership === 'join'
        ? allow('v11-4.3.4: invited or already joined')
        : deny('v11-4.3.4: join_rule requires an invite');
    }
    if (joinRule === 'restricted' || joinRule === 'knock_restricted') {
      return targetMembership === 'join' || targetMembership === 'invite'
        ? allow('v11-4.3.5.1: already joined or invited')
        : deny('v11-4.3.5.2: restricted joins are not supported');
    }
    if (joinRule === 'public') return allow('v11-4.3.6: public room');
    return deny(`v11-4.3.7: unsupported join_rule ${joinRule}`);
  }

  if (membership === 'invite') {
    // 4.4.1: third-party invites are not supported by this deployment.
    if (event.content.third_party_invite !== undefined) {
      return deny('v11-4.4.1: third-party invites are not supported');
    }
    if (senderMembership !== 'join') return deny('v11-4.4.2: sender is not joined');
    if (targetMembership === 'join' || targetMembership === 'ban') {
      return deny('v11-4.4.3: target is already joined or banned');
    }
    return senderPower >= powerLevel(powerLevels, 'invite')
      ? allow('v11-4.4.4: sender may invite')
      : deny('v11-4.4.5: sender is below the invite level');
  }

  if (membership === 'leave') {
    if (event.sender === stateKey) {
      // 4.5.1: leaving, or declining an invite/knock, is a self-service action.
      return senderMembership === 'invite' || senderMembership === 'join' || senderMembership === 'knock'
        ? allow('v11-4.5.1: leaving a room the sender is in')
        : deny('v11-4.5.1: sender is not in the room');
    }
    if (senderMembership !== 'join') return deny('v11-4.5.2: sender is not joined');
    if (targetMembership === 'ban' && senderPower < powerLevel(powerLevels, 'ban')) {
      return deny('v11-4.5.3: sender may not unban');
    }
    const targetPower = userPowerLevel({ powerLevels, userId: stateKey, creator });
    return senderPower >= powerLevel(powerLevels, 'kick') && targetPower < senderPower
      ? allow('v11-4.5.4: kick allowed')
      : deny('v11-4.5.5: kick not permitted');
  }

  if (membership === 'ban') {
    if (senderMembership !== 'join') return deny('v11-4.6.1: sender is not joined');
    const targetPower = userPowerLevel({ powerLevels, userId: stateKey, creator });
    return senderPower >= powerLevel(powerLevels, 'ban') && targetPower < senderPower
      ? allow('v11-4.6.2: ban allowed')
      : deny('v11-4.6.3: ban not permitted');
  }

  if (membership === 'knock') {
    if (joinRule !== 'knock' && joinRule !== 'knock_restricted') {
      return deny('v11-4.7.1: room does not accept knocking');
    }
    if (event.sender !== stateKey) return deny('v11-4.7.2: sender does not match state_key');
    return senderMembership !== 'ban' && senderMembership !== 'invite' && senderMembership !== 'join'
      ? allow('v11-4.7.3: knock allowed')
      : deny('v11-4.7.4: sender is already banned, invited or joined');
  }

  return deny(`v11-4.8: unknown membership ${String(membership)}`);
}

/** 9. Power level changes must not exceed the sender's own power. */
function authorizePowerLevels(
  event: AuthorizableEvent,
  current: Record<string, unknown> | undefined,
  senderPower: number,
): EventAuthDecision {
  // 9.1 and 9.2: the shape of the content.
  for (const key of INVITE_LEVEL_KEYS) {
    if (event.content[key] !== undefined && !Number.isInteger(event.content[key])) {
      return deny(`v11-9.1: ${key} is not an integer`);
    }
  }
  for (const key of [ 'events', 'notifications' ]) {
    const value = event.content[key];
    if (value === undefined) continue;
    if (!isRecord(value)) return deny(`v11-9.2: ${key} is not an object`);
    if (Object.values(value).some(entry => !Number.isInteger(entry))) {
      return deny(`v11-9.2: ${key} has a non-integer value`);
    }
  }
  // 9.3.
  const users = event.content.users;
  if (users !== undefined) {
    if (!isRecord(users)) return deny('v11-9.3: users is not an object');
    for (const [ userId, level ] of Object.entries(users)) {
      if (!isUserId(userId) || !Number.isInteger(level)) {
        return deny('v11-9.3: users must map valid user IDs to integers');
      }
    }
  }
  // 9.4: the first power levels event in a room is allowed by this rule.
  if (current === undefined) return allow('v11-9.4: first power_levels event');

  // 9.5: scalar levels.
  for (const key of INVITE_LEVEL_KEYS) {
    const before = current[key];
    const after = event.content[key];
    if (before === after) continue;
    if (Number.isInteger(before) && (before as number) > senderPower) {
      return deny(`v11-9.5.1: ${key} currently exceeds the sender's power`);
    }
    if (Number.isInteger(after) && (after as number) > senderPower) {
      return deny(`v11-9.5.2: new ${key} exceeds the sender's power`);
    }
  }
  // 9.6 and 9.7: the events and notifications maps.
  for (const key of [ 'events', 'notifications' ]) {
    const before = asRecord(current[key]);
    const after = asRecord(event.content[key]);
    for (const [ name, value ] of Object.entries(before)) {
      if (after[name] === value) continue;
      if (Number.isInteger(value) && (value as number) > senderPower) {
        return deny(`v11-9.6: ${key}.${name} currently exceeds the sender's power`);
      }
    }
    for (const [ name, value ] of Object.entries(after)) {
      if (before[name] === value) continue;
      if (Number.isInteger(value) && (value as number) > senderPower) {
        return deny(`v11-9.7: new ${key}.${name} exceeds the sender's power`);
      }
    }
  }
  // 9.8 and 9.9: other users' entries, never the sender's own.
  const beforeUsers = asRecord(current.users);
  for (const [ userId, value ] of Object.entries(beforeUsers)) {
    if (userId === event.sender || users?.[userId] === value) continue;
    if (Number.isInteger(value) && (value as number) >= senderPower) {
      return deny(`v11-9.8: ${userId}'s current power is not below the sender's`);
    }
  }
  const afterUsers = asRecord(users);
  for (const [ userId, value ] of Object.entries(afterUsers)) {
    if (userId === event.sender || beforeUsers[userId] === value) continue;
    if (Number.isInteger(value) && (value as number) > senderPower) {
      return deny(`v11-9.9: new power for ${userId} exceeds the sender's`);
    }
  }
  return allow('v11-9.10: power_levels allowed');
}

/**
 * 4.3.1 needs "the only previous event is an m.room.create". That is an exact check
 * on the event's parents, not "at most one parent": a member event hanging off a
 * message is not the creator's initial join and must be judged by the later rules.
 */
function isCreateOnlyParent(event: AuthorizableEvent, createEventId: string | undefined): boolean {
  if (createEventId === undefined) return false;
  const prev = event.prev_events ?? [];
  return prev.length === 1 && prev[0] === createEventId;
}

function powerLevelsOf(authEvents: readonly AuthEvent[]): Record<string, unknown> | undefined {
  return authEvents.find(entry => entry.type === 'm.room.power_levels')?.content;
}

function joinRuleOf(authEvents: readonly AuthEvent[]): string {
  const joinRules = authEvents.find(entry => entry.type === 'm.room.join_rules')?.content;
  return typeof joinRules?.join_rule === 'string' ? joinRules.join_rule : 'invite';
}

function membershipOf(authEvents: readonly AuthEvent[], userId: string): string | undefined {
  const member = authEvents.find(entry => entry.type === 'm.room.member' && entry.state_key === userId);
  return typeof member?.content?.membership === 'string' ? member.content.membership : undefined;
}

/**
 * A user's power level: an explicit entry wins, then `users_default`, then — when the
 * room has no power levels event at all — the creator has 100 and everyone else 0.
 */
export function userPowerLevel(input: {
  powerLevels: Record<string, unknown> | undefined;
  userId: string;
  creator?: string;
}): number {
  const { powerLevels, userId, creator } = input;
  if (powerLevels === undefined) return creator !== undefined && userId === creator ? 100 : 0;
  const explicit = asRecord(powerLevels.users)[userId];
  if (Number.isInteger(explicit)) return explicit as number;
  const fallback = powerLevels.users_default;
  if (Number.isInteger(fallback)) return fallback as number;
  return DEFAULT_POWER_LEVELS.users_default;
}

/** The power level an event type needs: explicit entry, then state/events default. */
export function requiredPowerForEvent(
  powerLevels: Record<string, unknown> | undefined,
  type: string,
  isState: boolean,
): number {
  const explicit = powerLevels === undefined ? undefined : asRecord(powerLevels.events)[type];
  if (Number.isInteger(explicit)) return explicit as number;
  if (powerLevels === undefined) return isState ? DEFAULT_POWER_LEVELS.state_default : DEFAULT_POWER_LEVELS.events_default;
  const fallback = isState ? powerLevels.state_default : powerLevels.events_default;
  if (Number.isInteger(fallback)) return fallback as number;
  return isState ? DEFAULT_POWER_LEVELS.state_default : DEFAULT_POWER_LEVELS.events_default;
}

function powerLevel(powerLevels: Record<string, unknown> | undefined, key: keyof typeof DEFAULT_POWER_LEVELS): number {
  const value = powerLevels?.[key];
  return Number.isInteger(value) ? value as number : DEFAULT_POWER_LEVELS[key];
}

function slotOf(type: string, stateKey: string): string {
  return `${type}|${stateKey}`;
}

/** The server name half of `@user:server` or `!room:server`. */
export function serverNameOf(id: string | undefined): string | undefined {
  if (typeof id !== 'string') return undefined;
  const separator = id.indexOf(':');
  if (separator <= 0 || separator === id.length - 1) return undefined;
  return id.slice(separator + 1);
}

/** A Matrix user ID: `@localpart:server` with both halves non-empty. */
export function isUserId(value: string): boolean {
  if (!value.startsWith('@')) return false;
  const separator = value.indexOf(':');
  return separator > 1 && separator < value.length - 1;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function allow(reason: string): EventAuthDecision {
  return { allowed: true, reason };
}

function deny(reason: string): EventAuthDecision {
  return { allowed: false, reason };
}
