/**
 * The stripped state a server sends with an invite or a knock.
 *
 * A server that is not in the room still has to let its user see what they are being invited to,
 * and the only state it can show is what the inviting server chose to send. The shape is the
 * Client-Server API's **stripped state event**: only `type`, `state_key`, `sender` and `content`.
 * That is not a convenience — a receiver cannot verify the rest (it has no room to check parents or
 * auth events against), so the fields that would make it look like a verifiable event are left out
 * rather than sent unverifiable.
 *
 * Which events: `m.room.create` is required (Matrix 1.16: the receiver needs the room's version
 * and its creator) and the display events are the ones the specification names — "if they are set
 * on the room, at least the state for `m.room.avatar`, `m.room.canonical_alias`,
 * `m.room.join_rules`, and `m.room.name` SHOULD be included". Two more are included because they
 * are the other things that decide whether the receiver's user wants in: the topic, and whether the
 * room is encrypted (named for `knock_room_state`, and just as relevant to an invite). The list
 * stays closed, so a room cannot push arbitrary state at a server that does not have the room.
 *
 * Validation is reported, not enforced: for room versions 1–11 the specification says a server
 * SHOULD warn about invites whose `invite_room_state` fails these rules rather than error, and this
 * deployment serves room version 11. `strippedStateWarnings` is that answer, so the caller can log
 * it and keep the invite usable.
 */
import { resolveRoomState } from '../roomState';
import type { MatrixEventRecord } from '../types';

/** The state events an invite or knock carries, in the order they are sent. */
export const STRIPPED_STATE_TYPES = [
  'm.room.create',
  'm.room.name',
  'm.room.avatar',
  'm.room.canonical_alias',
  'm.room.join_rules',
  'm.room.topic',
  'm.room.encryption',
] as const;

/** The room's current state, stripped to the four fields a receiver may rely on. */
export function strippedRoomState(records: readonly MatrixEventRecord[]): Record<string, unknown>[] {
  const state = resolveRoomState(records);
  const events: Record<string, unknown>[] = [];
  for (const type of STRIPPED_STATE_TYPES) {
    const record = state.get(type);
    if (!record) continue;
    events.push({
      type: record.type,
      state_key: record.stateKey ?? '',
      sender: record.sender,
      content: record.content,
    });
  }
  return events;
}

/**
 * What is wrong with a received `invite_room_state`, as reasons to log — empty means nothing is.
 *
 * `undefined` is fine: the field is optional, and an invite without it is still an invite. A
 * missing `m.room.create` is reported because Matrix 1.16 requires it, but only as a warning for
 * the room version this deployment serves (see the note above).
 */
export function strippedStateWarnings(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return [ 'invite_room_state is not an array' ];
  const warnings: string[] = [];
  let hasCreate = false;
  for (const [ index, entry ] of value.entries()) {
    if (!isRecord(entry)) {
      warnings.push(`invite_room_state[${index}] is not an object`);
      continue;
    }
    const missing = [ 'type', 'state_key', 'sender', 'content' ].filter(field => entry[field] === undefined);
    if (missing.length > 0) {
      warnings.push(`invite_room_state[${index}] is not a stripped state event: no ${missing.join(', ')}`);
      continue;
    }
    if (typeof entry.type !== 'string' || typeof entry.state_key !== 'string' || typeof entry.sender !== 'string') {
      warnings.push(`invite_room_state[${index}] has a state event whose type, state_key or sender is not a string`);
      continue;
    }
    if (!isRecord(entry.content)) {
      warnings.push(`invite_room_state[${index}] has no content object`);
      continue;
    }
    if (entry.type === 'm.room.create') hasCreate = true;
  }
  if (value.length > 0 && !hasCreate) warnings.push('invite_room_state does not contain the room\'s create event');
  return warnings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
