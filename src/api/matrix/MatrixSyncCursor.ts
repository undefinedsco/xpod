import { MatrixError } from './MatrixError';

/**
 * Sync cursor versions.
 *
 * `v2_<n>` remains a Pod-scoped journal cursor for one selected Pod. It is kept
 * readable so existing clients do not have to reset after upgrade.
 *
 * `v3.<base64url(json)>` adds stable, independent cursors for (a) the dispatch
 * directory sequence used to discover invites and (b) the journal sequence of
 * each remote room binding. Sequences come from different Pod journals and are
 * never compared with or folded into one another.
 */
export interface MatrixSyncCursor {
  version: 3;
  /** Journal sequence of the caller-selected Pod. */
  local: number;
  /** Dispatch-directory sequence for this invitee + selected Pod. */
  invites: number;
  /**
   * Journal sequence keyed by canonical storage root. Each Pod owns an
   * independent journal scope; sequences from different roots are never
   * compared with each other or folded into `local`.
   */
  rooms: Record<string, number>;
  /**
   * Per-room journal positions, keyed by the JSON pair [storage, roomId].
   * This is authoritative when present; `rooms`/`local` remain aggregate
   * fields so v3 cursors written before this field still advance.
   */
  roomSequences?: Record<string, number>;
  /**
   * Position hints only: keys of remote rooms the caller believes it joined.
   *
   * Fields are never authority. On read every key is re-resolved through the
   * persisted directory for the authenticated WebID; missing/mismatched rows
   * are omitted without any fetch, and all routing/provenance values come from
   * the server-side reference, not from this client-supplied object.
   */
  bindings?: Record<string, MatrixJoinedBinding>;
}

export interface MatrixJoinedBinding {
  storage: string;
  roomId: string;
  roomContainer: string;
  chatIri: string;
  threadIri: string;
  roomAlias?: string;
  roomName?: string;
  creatorWebId: string;
  createdAt: number;
}

const V2 = /^v2_(\d+)$/u;
const V3 = /^v3\.([A-Za-z0-9_-]+)$/u;
/**
 * Untrusted cursor bounds, applied before Buffer decode/JSON parse so a
 * caller cannot force unbounded allocation. A legitimate cursor grows with
 * joined rooms, but room count and encoded size stay far below these caps.
 */
export const MAX_SYNC_CURSOR_BYTES = 32 * 1024;
export const MAX_SYNC_CURSOR_ENTRIES = 2_000;

export function encodeSyncCursor(cursor: MatrixSyncCursor): string {
  const rooms = Object.fromEntries(Object.entries(cursor.rooms)
    .filter(([root, sequence]) => /^https?:\/\/[^\s]+$/u.test(root) && isSequence(sequence))
    .sort(([left], [right]) => left.localeCompare(right)));
  const roomSequences = Object.fromEntries(Object.entries(cursor.roomSequences ?? {})
    .filter(([key, sequence]) => isRoomSequenceKey(key) && isSequence(sequence))
    .sort(([left], [right]) => left.localeCompare(right)));
  const bindings = Object.fromEntries(Object.entries(cursor.bindings ?? {})
    .filter(([key, value]) => isRoomSequenceKey(key) && isJoinedBinding(value))
    .sort(([left], [right]) => left.localeCompare(right)));
  return `v3.${Buffer.from(JSON.stringify({ local: cursor.local, invites: cursor.invites, rooms, roomSequences, bindings }), 'utf8')
    .toString('base64url')}`;
}

export function parseSyncCursor(token: string | undefined): MatrixSyncCursor {
  if (!token) {
    return { version: 3, local: 0, invites: 0, rooms: {} };
  }
  const legacy = V2.exec(token);
  if (legacy) {
    const local = Number(legacy[1]);
    if (!Number.isSafeInteger(local)) throw unknownPosition();
    // A v2 cursor has no directory watermark, so already-known invites are
    // discovered once and become part of the next v3 cursor.
    return { version: 3, local, invites: 0, rooms: {}, roomSequences: {}, bindings: {} };
  }
  const current = V3.exec(token);
  if (!current) throw unknownPosition();
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(current[1], 'base64url').toString('utf8'));
  } catch {
    throw unknownPosition();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unknownPosition();
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some(key => !['local', 'invites', 'rooms', 'roomSequences', 'bindings'].includes(key))) throw unknownPosition();
  const local = candidate.local;
  const invites = candidate.invites;
  if (!isSequence(local) || !isSequence(invites)) throw unknownPosition();
  const rooms = candidate.rooms;
  if (!rooms || typeof rooms !== 'object' || Array.isArray(rooms)) throw unknownPosition();
  const parsedRooms: Record<string, number> = {};
  for (const [root, sequence] of Object.entries(rooms)) {
    if (!/^https?:\/\/[^\s]+$/u.test(root) || !isSequence(sequence)) throw unknownPosition();
    parsedRooms[root] = sequence;
  }
  if (Object.keys(rooms).length > MAX_SYNC_CURSOR_ENTRIES) throw unknownPosition();
  const sequences = candidate.roomSequences;
  const parsedSequences: Record<string, number> = {};
  if (sequences !== undefined) {
    if (!sequences || typeof sequences !== 'object' || Array.isArray(sequences)) throw unknownPosition();
    for (const [key, value] of Object.entries(sequences)) {
      if (!isRoomSequenceKey(key) || !isSequence(value)) throw unknownPosition();
      parsedSequences[key] = value;
    }
    if (Object.keys(sequences).length > MAX_SYNC_CURSOR_ENTRIES) throw unknownPosition();
  }
  const bindings = candidate.bindings;
  const parsedBindings: Record<string, MatrixJoinedBinding> = {};
  if (bindings !== undefined) {
    if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) throw unknownPosition();
    for (const [key, value] of Object.entries(bindings)) {
      if (!isRoomSequenceKey(key) || !isJoinedBinding(value)) throw unknownPosition();
      parsedBindings[key] = value;
    }
    if (Object.keys(bindings).length > MAX_SYNC_CURSOR_ENTRIES) throw unknownPosition();
  }
  return { version: 3, local, invites, rooms: parsedRooms, roomSequences: parsedSequences, bindings: parsedBindings };
}

function isJoinedBinding(value: unknown): value is MatrixJoinedBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const keys = Object.keys(entry);
  if (keys.some(key => !['storage', 'roomId', 'roomContainer', 'chatIri', 'threadIri', 'roomAlias', 'roomName', 'creatorWebId', 'createdAt'].includes(key))) return false;
  return typeof entry.storage === 'string' && /^https?:\/\/[^\s]+$/u.test(entry.storage)
    && typeof entry.roomId === 'string' && entry.roomId.length > 0
    && typeof entry.roomContainer === 'string' && /^https?:\/\/[^\s]+\/$/u.test(entry.roomContainer)
    && typeof entry.chatIri === 'string' && entry.chatIri.includes('#this')
    && typeof entry.threadIri === 'string' && entry.threadIri.includes('#thread')
    && typeof entry.creatorWebId === 'string' && typeof entry.createdAt === 'number'
    && (entry.roomAlias === undefined || typeof entry.roomAlias === 'string')
    && (entry.roomName === undefined || typeof entry.roomName === 'string');
}

function isRoomSequenceKey(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.length === 2
      && typeof parsed[0] === 'string' && /^https?:\/\/[^\s]+$/u.test(parsed[0])
      && typeof parsed[1] === 'string' && parsed[1].length > 0;
  } catch {
    return false;
  }
}

function isSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function unknownPosition(): MatrixError {
  return new MatrixError(400, 'M_UNKNOWN_POS', 'Cursor version changed; start a fresh sync');
}
