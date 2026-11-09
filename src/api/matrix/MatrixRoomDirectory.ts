import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  executeQuery,
  executeStatement,
  isDatabaseSqlite,
  type IdentityDatabase,
} from '../../identity/drizzle/db';
import { chatResource, threadResource } from '@undefineds.co/models';
import { MatrixError } from './MatrixError';

/**
 * A room binding whose canonical root was checked against persisted ownership
 * records. It can only be produced by {@link verifyRoomBinding}; callers never
 * construct it from request input.
 */
export interface VerifiedRoomBinding {
  readonly storage: string;
  readonly verified: true;
}

/** Fields of one reference; invite-specific fields are checked before storage. */
export interface MatrixRoomReferenceInput {
  roomId: string;
  roomAlias?: string;
  roomName?: string;
  creatorWebId: string;
  inviteeWebId: string;
  /** Canonical MXID derived from `inviteeWebId`; never decoded back. */
  inviteeMatrixUserId: string;
  /**
   * Resource id of the single invite event document in the room's Pod. It is
   * read by exact id so verification never scans the room collection.
   */
  inviteResourceId: string;
  inviteEventId: string;
  createdAt: number;
}

export interface MatrixRoomReference extends MatrixRoomReferenceInput {
  sequence: number;
  binding: VerifiedRoomBinding;
  /** Source Pod of the reference; always equal to `binding.storage`. */
  sourceStorage: string;
  /** Canonical room *container* on the source Pod (trailing slash, no fragment). */
  roomContainer: string;
  /** Canonical chat subject IRI (`index.ttl#this`) on the source Pod. */
  chatIri: string;
  /** Canonical thread IRI on the source Pod. */
  threadIri: string;
}

/** One immutable discovery transition. */
export interface MatrixRoomDirectoryTransition extends MatrixRoomReference {
  transitionId: string;
}

/**
 * The persisted directory holds references only. Message bodies, timeline
 * membership and ACLs remain authoritative in the room's own Pod; a reference
 * never grants access by itself.
 */
export interface MatrixRoomDirectory {
  register(verified: VerifiedRoomBinding, input: MatrixRoomReferenceInput): Promise<MatrixRoomDirectoryTransition>;
  /** Latest transition per (storage, room) for exactly this invitee. */
  listForInvitee(inviteeWebId: string): Promise<MatrixRoomReference[]>;
  /**
   * Directory-ordered continuation for one invitee. The page is bounded, so a
   * caller older than the cap is not silently dropped: it advances an
   * `afterSequence` watermark and continues on the next call.
   */
  listForInviteeAfter(inviteeWebId: string, afterSequence: number, limit?: number): Promise<{
    references: MatrixRoomReference[];
    nextSequence: number;
    truncated: boolean;
  }>;
  /** Latest transition per (storage, room) where the caller is creator or invitee. */
  listForParticipant(webId: string): Promise<MatrixRoomReference[]>;
  /**
   * Raw directory-ordered transitions for a participant. Used for bounded
   * continuation over ALL known rooms; duplicates per room are resolved by
   * the caller.
   */
  listForParticipantAfter(webId: string, afterSequence: number, limit?: number): Promise<{
    references: MatrixRoomReference[];
    nextSequence: number;
    truncated: boolean;
  }>;
  /** Resolve one room for a participant; ambiguous cross-Pod ids are refused. */
  findForParticipant(webId: string, roomId: string): Promise<MatrixRoomReference | undefined>;
  /**
   * Resolve exactly one server-side reference by (storage, room) for a
   * participant. Used to rehydrate cursor hints; every returned field comes
   * from persisted data, never from the cursor.
   */
  findForParticipantKey(webId: string, storage: string, roomId: string): Promise<MatrixRoomReference | undefined>;
}

/** Bounds one caller's directory page; sequences are stable directory order. */
export const MATRIX_DIRECTORY_PAGE_LIMIT = 500;

/**
 * Canonical HTTP(S) storage root with its path preserved and exactly one
 * trailing slash. Query, fragment, credentials, dot segments and encoded
 * separators are rejected.
 *
 * Syntax alone cannot decide whether a path is a Pod: registration does. A
 * path-style root such as `https://pods.example/alice/` is valid; a child room
 * path is accepted only when the persisted lookup names that exact root.
 */
export function canonicalStorageRoot(value: string): string | undefined {
  if (!value || value !== value.trim() || /[\s\\?#]/u.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
  if (/%(?:2f|5c)/iu.test(url.pathname) || url.pathname.includes('//')) return undefined;
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.some(segment => segment === '.' || segment === '..')) return undefined;
  url.pathname = segments.length ? `/${segments.join('/')}/` : '/';
  url.search = '';
  url.hash = '';
  return url.toString();
}

/**
 * Verify that a storage root is a registered Pod before it becomes a directory
 * binding or is used for routing. An absent verifier fails closed: an
 * unverified address is never marked `verified`.
 */
export async function verifyRoomBinding(
  storage: string,
  isRegisteredStorage: ((canonicalRoot: string) => Promise<boolean>) | undefined,
): Promise<VerifiedRoomBinding> {
  const canonical = canonicalStorageRoot(storage);
  if (!canonical) {
    throw new MatrixError(403, 'M_FORBIDDEN', 'Room storage must be a canonical HTTP(S) root');
  }
  if (!isRegisteredStorage || !(await isRegisteredStorage(canonical))) {
    throw new MatrixError(403, 'M_FORBIDDEN', 'Room storage is not a registered Pod');
  }
  return Object.freeze({ storage: canonical, verified: true as const });
}

interface DirectoryRow {
  sequence: number | string;
  transition_id: string;
  storage: string;
  room_id: string;
  room_alias?: string | null;
  room_name?: string | null;
  creator_web_id: string;
  invitee_web_id: string;
  invitee_matrix_user_id: string;
  invite_event_id: string;
  invite_resource_id: string;
  created_at: number | string;
}

/** Isolated tests only; persistence tests must use {@link SqlMatrixRoomDirectory}. */
export class InMemoryMatrixRoomDirectory implements MatrixRoomDirectory {
  private readonly transitions: MatrixRoomDirectoryTransition[] = [];
  private sequence = 0;

  /**
   * @param isRegisteredStorage persisted Pod lookup. Registration fails closed
   * when absent, so a self-declared `verified` flag is never enough on its own.
   */
  public constructor(
    private readonly isRegisteredStorage?: (canonicalRoot: string) => Promise<boolean>,
  ) {}

  public async register(verified: VerifiedRoomBinding, input: MatrixRoomReferenceInput): Promise<MatrixRoomDirectoryTransition> {
    await requireVerifiedBinding(verified, this.isRegisteredStorage);
    requireCompleteReference(input);
    const existing = this.transitions.find(row => row.sourceStorage === verified.storage
      && row.roomId === input.roomId && row.inviteeWebId === input.inviteeWebId
      && row.inviteEventId === input.inviteEventId);
    if (existing) return { ...existing };
    const row: MatrixRoomDirectoryTransition = {
      ...input,
      sourceStorage: verified.storage,
      chatIri: chatResource.buildIri(verified.storage, { id: surfaceId(input.roomId) }),
      roomContainer: roomContainerOf(chatResource.buildIri(verified.storage, { id: surfaceId(input.roomId) })),
      threadIri: threadResource.buildIri(verified.storage, {
        id: 'thread', parent: chatResource.buildIri(verified.storage, { id: surfaceId(input.roomId) }),
      }),
      sequence: ++this.sequence,
      transitionId: `transition-${this.sequence}`,
      binding: verified,
    };
    this.transitions.push(row);
    return { ...row };
  }

  public async listForInvitee(inviteeWebId: string): Promise<MatrixRoomReference[]> {
    return this.latest(rows => rows.filter(row => row.inviteeWebId === inviteeWebId));
  }

  public async listForInviteeAfter(inviteeWebId: string, afterSequence: number, limit = MATRIX_DIRECTORY_PAGE_LIMIT): Promise<{
    references: MatrixRoomReference[];
    nextSequence: number;
    truncated: boolean;
  }> {
    const page = this.transitions
      .filter(row => row.inviteeWebId === inviteeWebId && row.sequence > afterSequence)
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, Math.min(Math.max(limit, 1), MATRIX_DIRECTORY_PAGE_LIMIT));
    const nextSequence = page.length ? page[page.length - 1].sequence : afterSequence;
    const truncated = this.transitions.some(row => row.inviteeWebId === inviteeWebId && row.sequence > nextSequence);
    return { references: page.map(row => ({ ...row })), nextSequence, truncated };
  }

  public async listForParticipant(webId: string): Promise<MatrixRoomReference[]> {
    return this.latest(rows => rows.filter(row => row.inviteeWebId === webId || row.creatorWebId === webId));
  }

  public async listForParticipantAfter(webId: string, afterSequence: number, limit = MATRIX_DIRECTORY_PAGE_LIMIT): Promise<{
    references: MatrixRoomReference[];
    nextSequence: number;
    truncated: boolean;
  }> {
    const page = this.transitions
      .filter(row => (row.inviteeWebId === webId || row.creatorWebId === webId) && row.sequence > afterSequence)
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, Math.min(Math.max(limit, 1), MATRIX_DIRECTORY_PAGE_LIMIT));
    const nextSequence = page.length ? page[page.length - 1].sequence : afterSequence;
    const truncated = this.transitions.some(row =>
      (row.inviteeWebId === webId || row.creatorWebId === webId) && row.sequence > nextSequence);
    return { references: page.map(row => ({ ...row })), nextSequence, truncated };
  }

  public async findForParticipant(webId: string, roomId: string): Promise<MatrixRoomReference | undefined> {
    return uniqueMatch((await this.listForParticipant(webId)).filter(row => row.roomId === roomId));
  }

  public async findForParticipantKey(webId: string, storage: string, roomId: string): Promise<MatrixRoomReference | undefined> {
    const matches = (await this.listForParticipant(webId)).filter(row =>
      row.sourceStorage === storage && row.roomId === roomId);
    return uniqueMatch(matches);
  }

  private latest(select: (rows: MatrixRoomDirectoryTransition[]) => MatrixRoomDirectoryTransition[]): MatrixRoomReference[] {
    const byRoom = new Map<string, MatrixRoomDirectoryTransition>();
    for (const row of select(this.transitions)) {
      const key = JSON.stringify([row.sourceStorage, row.roomId]);
      const current = byRoom.get(key);
      if (!current || row.sequence > current.sequence) byRoom.set(key, row);
    }
    return [...byRoom.values()].map(row => ({ ...row }));
  }
}

export class SqlMatrixRoomDirectory implements MatrixRoomDirectory {
  private initialization?: Promise<void>;

  /**
   * @param isRegisteredStorage persisted Pod lookup. Registration fails closed
   * when absent; re-checking here means a stale or hand-built binding never
   * becomes a persisted "verified" row.
   */
  public constructor(
    private readonly db: IdentityDatabase,
    private readonly isRegisteredStorage?: (canonicalRoot: string) => Promise<boolean>,
  ) {}

  public async register(verified: VerifiedRoomBinding, input: MatrixRoomReferenceInput): Promise<MatrixRoomDirectoryTransition> {
    await requireVerifiedBinding(verified, this.isRegisteredStorage);
    requireCompleteReference(input);
    await this.ensureInitialized();
    await executeStatement(this.db, sql`
      INSERT INTO xpod_matrix_room_directory (
        transition_id, storage, room_id, room_alias, room_name, creator_web_id, invitee_web_id,
        invitee_matrix_user_id, invite_event_id, invite_resource_id, created_at
      ) VALUES (
        ${input.inviteEventId}, ${verified.storage}, ${input.roomId}, ${input.roomAlias ?? null}, ${input.roomName ?? null},
        ${input.creatorWebId}, ${input.inviteeWebId}, ${input.inviteeMatrixUserId},
        ${input.inviteEventId}, ${input.inviteResourceId}, ${input.createdAt}
      )
      ON CONFLICT (storage, room_id, invitee_web_id, invite_event_id) DO NOTHING
    `);
    const result = await executeQuery<DirectoryRow>(this.db, sql`
      SELECT sequence, transition_id, storage, room_id, room_alias, room_name, creator_web_id,
             invitee_web_id, invitee_matrix_user_id, invite_event_id, invite_resource_id, created_at
      FROM xpod_matrix_room_directory
      WHERE storage = ${verified.storage} AND room_id = ${input.roomId}
        AND invitee_web_id = ${input.inviteeWebId} AND invite_event_id = ${input.inviteEventId}
    `);
    const row = result.rows[0];
    if (!row) throw new Error('Matrix room directory transition disappeared');
    return this.toTransition(row);
  }

  public async listForInvitee(inviteeWebId: string): Promise<MatrixRoomReference[]> {
    await this.ensureInitialized();
    return this.listLatest(sql`invitee_web_id = ${inviteeWebId}`);
  }

  public async listForInviteeAfter(inviteeWebId: string, afterSequence: number, limit = MATRIX_DIRECTORY_PAGE_LIMIT): Promise<{
    references: MatrixRoomReference[];
    nextSequence: number;
    truncated: boolean;
  }> {
    await this.ensureInitialized();
    const bounded = Math.min(Math.max(limit, 1), MATRIX_DIRECTORY_PAGE_LIMIT);
    const result = await executeQuery<DirectoryRow>(this.db, sql`
      SELECT sequence, storage, room_id, room_alias, room_name, creator_web_id,
             invitee_web_id, invitee_matrix_user_id, invite_event_id, invite_resource_id, created_at
      FROM xpod_matrix_room_directory
      WHERE invitee_web_id = ${inviteeWebId} AND sequence > ${afterSequence}
      ORDER BY sequence
      LIMIT ${bounded}
    `);
    const references = result.rows.map(row => this.toReference(row));
    const nextSequence = references.length ? references[references.length - 1].sequence : afterSequence;
    const truncated = references.length === bounded && await this.hasOlderInvites(inviteeWebId, nextSequence);
    return { references, nextSequence, truncated };
  }

  public async listForParticipant(webId: string): Promise<MatrixRoomReference[]> {
    await this.ensureInitialized();
    return this.listLatest(sql`(invitee_web_id = ${webId} OR creator_web_id = ${webId})`);
  }

  public async listForParticipantAfter(webId: string, afterSequence: number, limit = MATRIX_DIRECTORY_PAGE_LIMIT): Promise<{
    references: MatrixRoomReference[];
    nextSequence: number;
    truncated: boolean;
  }> {
    await this.ensureInitialized();
    const bounded = Math.min(Math.max(limit, 1), MATRIX_DIRECTORY_PAGE_LIMIT);
    const result = await executeQuery<DirectoryRow>(this.db, sql`
      SELECT sequence, storage, room_id, room_alias, room_name, creator_web_id,
             invitee_web_id, invitee_matrix_user_id, invite_event_id, invite_resource_id, created_at
      FROM xpod_matrix_room_directory
      WHERE (invitee_web_id = ${webId} OR creator_web_id = ${webId}) AND sequence > ${afterSequence}
      ORDER BY sequence
      LIMIT ${bounded}
    `);
    const references = result.rows.map(row => this.toReference(row));
    const nextSequence = references.length ? references[references.length - 1].sequence : afterSequence;
    const truncated = references.length === bounded && await this.hasOlderParticipantRows(webId, nextSequence);
    return { references, nextSequence, truncated };
  }

  private async hasOlderParticipantRows(webId: string, afterSequence: number): Promise<boolean> {
    const result = await executeQuery<{ present: number }>(this.db, sql`
      SELECT 1 AS present FROM xpod_matrix_room_directory
      WHERE (invitee_web_id = ${webId} OR creator_web_id = ${webId}) AND sequence > ${afterSequence}
      LIMIT 1
    `);
    return result.rows.length > 0;
  }

  private async hasOlderInvites(inviteeWebId: string, afterSequence: number): Promise<boolean> {
    const result = await executeQuery<{ present: number }>(this.db, sql`
      SELECT 1 AS present FROM xpod_matrix_room_directory
      WHERE invitee_web_id = ${inviteeWebId} AND sequence > ${afterSequence}
      LIMIT 1
    `);
    return result.rows.length > 0;
  }

  public async findForParticipant(webId: string, roomId: string): Promise<MatrixRoomReference | undefined> {
    await this.ensureInitialized();
    return uniqueMatch(await this.listLatest(
      sql`(invitee_web_id = ${webId} OR creator_web_id = ${webId}) AND room_id = ${roomId}`,
    ));
  }

  public async findForParticipantKey(webId: string, storage: string, roomId: string): Promise<MatrixRoomReference | undefined> {
    await this.ensureInitialized();
    const exactStorage = canonicalStorageRoot(storage);
    if (!exactStorage || exactStorage !== storage) return undefined;
    return uniqueMatch(await this.listLatest(
      sql`storage = ${exactStorage} AND room_id = ${roomId}
          AND (invitee_web_id = ${webId} OR creator_web_id = ${webId})`,
    ));
  }

  private async listLatest(where: ReturnType<typeof sql>): Promise<MatrixRoomReference[]> {
    // Window function keeps latest-per-room selection in SQL; LIMIT bounds a
    // caller's discovery page. Sequences are directory order, not event time
    // and not comparable with any Pod journal sequence.
    const result = await executeQuery<DirectoryRow>(this.db, sql`
      SELECT sequence, storage, room_id, room_alias, room_name, creator_web_id,
             invitee_web_id, invitee_matrix_user_id, invite_event_id, invite_resource_id, created_at
      FROM (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY storage, room_id ORDER BY sequence DESC
        ) AS rank
        FROM xpod_matrix_room_directory
        WHERE ${where}
      ) latest
      WHERE rank = 1
      ORDER BY sequence
      LIMIT ${MATRIX_DIRECTORY_PAGE_LIMIT}
    `);
    return result.rows.map(row => this.toReference(row));
  }

  private toReference(row: DirectoryRow): MatrixRoomReference {
    const binding = verifyCanonicalBinding(row.storage);
    return {
      sequence: this.toSequence(row.sequence),
      roomId: row.room_id,
      roomAlias: row.room_alias ?? undefined,
      roomName: row.room_name ?? undefined,
      creatorWebId: row.creator_web_id,
      inviteeWebId: row.invitee_web_id,
      inviteeMatrixUserId: row.invitee_matrix_user_id,
      inviteResourceId: row.invite_resource_id,
      inviteEventId: row.invite_event_id,
      createdAt: Number(row.created_at),
      sourceStorage: row.storage,
      binding,
      // Rebuilt from the canonical root + room id; layout belongs to models.
      chatIri: chatResource.buildIri(row.storage, { id: surfaceId(row.room_id) }),
      roomContainer: roomContainerOf(chatResource.buildIri(row.storage, { id: surfaceId(row.room_id) })),
      threadIri: threadResource.buildIri(row.storage, {
        id: 'thread', parent: chatResource.buildIri(row.storage, { id: surfaceId(row.room_id) }),
      }),
    };
  }

  private toTransition(row: DirectoryRow): MatrixRoomDirectoryTransition {
    const reference = this.toReference(row);
    return { ...reference, transitionId: row.transition_id ?? reference.inviteEventId };
  }

  private toSequence(value: number | string): number {
    const sequence = Number(value);
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new Error('Matrix directory sequence exceeds the supported cursor range');
    }
    return sequence;
  }

  private ensureInitialized(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.initialize().catch((error: unknown) => {
        this.initialization = undefined;
        throw error;
      });
    }
    return this.initialization;
  }

  private async initialize(): Promise<void> {
    if (isDatabaseSqlite(this.db)) {
      await this.createTables(this.db);
      return;
    }
    await executeQuery(this.db, sql`SELECT 1`);
    await this.db.transaction(async (transaction: IdentityDatabase): Promise<void> => {
      await executeQuery(transaction, sql`SELECT pg_advisory_xact_lock(hashtext('xpod_matrix_directory_schema'))`);
      await this.createTables(transaction);
    });
  }

  private async createTables(db: IdentityDatabase): Promise<void> {
    const sequenceType = isDatabaseSqlite(db)
      ? sql.raw('INTEGER PRIMARY KEY AUTOINCREMENT')
      : sql.raw('BIGSERIAL PRIMARY KEY');
    await executeStatement(db, sql`
      CREATE TABLE IF NOT EXISTS xpod_matrix_room_directory (
        sequence ${sequenceType},
        transition_id TEXT NOT NULL,
        storage TEXT NOT NULL,
        room_id TEXT NOT NULL,
        room_alias TEXT,
        room_name TEXT,
        creator_web_id TEXT NOT NULL,
        invitee_web_id TEXT NOT NULL,
        invitee_matrix_user_id TEXT NOT NULL,
        invite_event_id TEXT NOT NULL,
        invite_resource_id TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        UNIQUE (storage, room_id, invitee_web_id, invite_event_id)
      )
    `);
    await executeStatement(db, sql`
      CREATE INDEX IF NOT EXISTS xpod_matrix_room_directory_invitee
      ON xpod_matrix_room_directory (invitee_web_id, storage, room_id, sequence)
    `);
    await executeStatement(db, sql`
      CREATE INDEX IF NOT EXISTS xpod_matrix_room_directory_sequence
      ON xpod_matrix_room_directory (invitee_web_id, sequence)
    `);
    await executeStatement(db, sql`
      CREATE INDEX IF NOT EXISTS xpod_matrix_room_directory_participant
      ON xpod_matrix_room_directory (creator_web_id, room_id, sequence)
    `);
  }
}

/** A binding enters storage only after canonical and registered checks. */
async function requireVerifiedBinding(
  binding: VerifiedRoomBinding,
  isRegisteredStorage: ((canonicalRoot: string) => Promise<boolean>) | undefined,
): Promise<void> {
  const canonical = canonicalStorageRoot(binding.storage);
  if (binding.verified !== true || !canonical || canonical !== binding.storage) {
    throw new MatrixError(403, 'M_FORBIDDEN', 'Directory requires a verified canonical storage binding');
  }
  if (!isRegisteredStorage || !(await isRegisteredStorage(canonical))) {
    throw new MatrixError(403, 'M_FORBIDDEN', 'Room storage is not a registered Pod');
  }
}

function requireCompleteReference(input: MatrixRoomReferenceInput): void {
  if (!input.roomId || !input.creatorWebId || !input.inviteeWebId || !input.inviteeMatrixUserId
    || !input.inviteEventId || !input.inviteResourceId) {
    throw new MatrixError(400, 'M_BAD_JSON', 'Directory reference is incomplete');
  }
}

/**
 * Containing container of a canonical resource IRI. This is a generic
 * RFC3986 path operation: drop the fragment, then the last path segment.
 * Model layout is still produced by `chatResource.buildIri`.
 */
export function roomContainerOf(iri: string): string {
  const parsed = new URL(iri);
  parsed.hash = '';
  const path = parsed.pathname.endsWith('/') ? parsed.pathname : parsed.pathname.slice(0, parsed.pathname.lastIndexOf('/') + 1);
  if (path === '/') throw new Error('Room IRI has no containing container');
  parsed.pathname = path;
  return parsed.toString();
}

/** Matches PodMatrixStore's canonical room surface id derivation. */
function surfaceId(roomId: string): string {
  return `matrix-${createHash('sha256').update(roomId).digest('hex').slice(0, 16)}`;
}

/** Rows read back from SQL must still be canonical; never trust storage text. */
function verifyCanonicalBinding(storage: string): VerifiedRoomBinding {
  const canonical = canonicalStorageRoot(storage);
  if (!canonical || canonical !== storage) {
    throw new Error('Matrix directory contains a non-canonical storage binding');
  }
  return Object.freeze({ storage, verified: true as const });
}

function uniqueMatch(matches: MatrixRoomReference[]): MatrixRoomReference | undefined {
  if (matches.length <= 1) return matches[0];
  if (new Set(matches.map(match => match.sourceStorage)).size !== 1) {
    throw new MatrixError(409, 'M_CONFLICT', 'Room id resolves to multiple registered storage bindings');
  }
  return matches[0];
}
