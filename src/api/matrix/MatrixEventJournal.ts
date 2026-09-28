import { sql } from 'drizzle-orm';
import {
  executeQuery,
  executeStatement,
  isDatabaseSqlite,
  type IdentityDatabase,
} from '../../identity/drizzle/db';

export interface MatrixTransactionReservation {
  eventId: string;
  createdAt: number;
  contentHash: string;
}

/**
 * The transaction key a stored event belongs to, rebuilt from the event itself.
 *
 * A reservation is addressed by this key, and the key names the device that sent it — the one part
 * of it an event does not otherwise carry, which is why the row stores `txnDevice`. Rebuilding it
 * here is what lets a carrier that keeps reservations per key (rather than an id index) answer
 * "which reservation does this event belong to" with one point lookup: the four lookups in
 * `PodMatrixStore` all hold the whole event.
 *
 * Returns `undefined` for an event that never came from a reserved transaction (a received event, a
 * state event written outside one), which is not an error: it simply has no receipt.
 */
export function reservationKeyForEvent(event: {
  roomId?: string;
  type?: string;
  txnId?: string;
  txnDevice?: string;
}): string | undefined {
  const { roomId, type, txnId, txnDevice } = event;
  if (!roomId || !type || !txnId || !txnDevice) return undefined;
  return JSON.stringify([ txnDevice, roomId, type, txnId ]);
}

/** Operational references only: event bodies and room state remain authoritative in the Pod. */
/**
 * What a caller has when it asks "which reservation produced this event".
 *
 * The whole event, not just its id: a reservation is addressed by
 * `[txnDevice, roomId, type, txnId]` (`reservationKeyForEvent`), and the id alone cannot rebuild
 * that. A carrier that keeps records by key can then answer with one point lookup, while one that
 * keeps an id index (the identity database today) reads `eventId` and ignores the rest.
 */
export interface MatrixReservationLookup {
  eventId: string;
  roomId?: string;
  type?: string;
  txnId?: string;
  txnDevice?: string;
}

/**
 * The Pod a reservation is written to, when the carrier needs one.
 *
 * Passed per call rather than resolved from the scope, because a reservation is written on the
 * **caller's** path: a client session writing its own Pod must carry the session's authority, and a
 * deployment writing for a participant must carry that participant's grant. Guessing one from the
 * scope gets the first case wrong — measured: wiring the service handle in made every caller write
 * fail with 403 on a real stack.
 */
export type MatrixReservationAuthority = import('./controlRecords').MatrixControlRecordTarget;

export interface MatrixEventJournal {
  reserveTransaction(
    scope: string,
    key: string,
    candidate: MatrixTransactionReservation,
    authority?: MatrixReservationAuthority,
  ): Promise<MatrixTransactionReservation>;
  /**
   * Replace an existing reservation entirely. Only valid for a reservation whose
   * output was never written, which callers must verify before taking one over:
   * an event's id is derived from the event, so a later attempt with different
   * content derives a different id and the reservation has to name the event
   * that will actually exist.
   */
  replaceReservation(
    scope: string,
    key: string,
    candidate: MatrixTransactionReservation,
    authority?: MatrixReservationAuthority,
  ): Promise<void>;
  registerEvent(scope: string, roomId: string, eventId: string): Promise<number>;
  /**
   * Register a page of events in one pass. Sequences are assigned in input
   * order, exactly as sequential `registerEvent` calls would, but the journal
   * round-trips stay bounded instead of growing with the page size.
   */
  registerEvents(scope: string, roomId: string, eventIds: readonly string[]): Promise<number[]>;
  /** Look up several receipts at once: recovery needs one per scanned event. */
  findReservations(
    scope: string,
    events: readonly MatrixReservationLookup[],
    authority?: MatrixReservationAuthority,
  ): Promise<Map<string, MatrixTransactionReservation>>;
  getHighWatermark(scope: string): Promise<number>;
  findReservation(
    scope: string,
    event: MatrixReservationLookup,
    authority?: MatrixReservationAuthority,
  ): Promise<MatrixTransactionReservation | undefined>;
}

/** Isolated tests only. Production cursors and reservations must survive process restarts. */
export class InMemoryMatrixEventJournal implements MatrixEventJournal {
  private readonly transactions = new Map<string, MatrixTransactionReservation>();
  private readonly events = new Map<string, number>();
  private readonly highWatermarks = new Map<string, number>();
  private sequence = 0;

  public async reserveTransaction(scope: string, key: string, candidate: MatrixTransactionReservation): Promise<MatrixTransactionReservation> {
    const identity = JSON.stringify([ scope, key ]);
    const reservation = this.transactions.get(identity) ?? { ...candidate };
    this.transactions.set(identity, reservation);
    return { ...reservation };
  }

  public async findReservation(scope: string, event: MatrixReservationLookup): Promise<MatrixTransactionReservation | undefined> {
    const key = reservationKeyForEvent(event);
    if (key) {
      const exact = this.transactions.get(JSON.stringify([ scope, key ]));
      if (exact) return { ...exact };
    }
    for (const [stored,value] of this.transactions) if (JSON.parse(stored)[0] === scope && value.eventId === event.eventId) return {...value};
    return undefined;
  }

  public async replaceReservation(scope: string, key: string, candidate: MatrixTransactionReservation): Promise<void> {
    const identity = JSON.stringify([ scope, key ]);
    const existing = this.transactions.get(identity);
    if (existing) this.transactions.set(identity, { ...candidate });
  }

  public async registerEvent(scope: string, roomId: string, eventId: string): Promise<number> {
    const identity = JSON.stringify([ scope, roomId, eventId ]);
    const existing = this.events.get(identity);
    if (existing !== undefined) {
      return existing;
    }
    const sequence = ++this.sequence;
    this.events.set(identity, sequence);
    this.highWatermarks.set(scope, sequence);
    return sequence;
  }

  public async registerEvents(scope: string, roomId: string, eventIds: readonly string[]): Promise<number[]> {
    const sequences: number[] = [];
    for (const eventId of eventIds) sequences.push(await this.registerEvent(scope, roomId, eventId));
    return sequences;
  }

  public async findReservations(scope: string, events: readonly MatrixReservationLookup[]): Promise<Map<string, MatrixTransactionReservation>> {
    const wanted = new Set(events.map(event => event.eventId));
    const found = new Map<string, MatrixTransactionReservation>();
    for (const [ key, value ] of this.transactions) {
      if (JSON.parse(key)[0] === scope && wanted.has(value.eventId)) found.set(value.eventId, { ...value });
    }
    return found;
  }

  public async getHighWatermark(scope: string): Promise<number> {
    return this.highWatermarks.get(scope) ?? 0;
  }
}

export class SqlMatrixEventJournal implements MatrixEventJournal {
  private initialization?: Promise<void>;

  public constructor(private readonly db: IdentityDatabase) {}

  public async reserveTransaction(scope: string, key: string, candidate: MatrixTransactionReservation): Promise<MatrixTransactionReservation> {
    await this.ensureInitialized();
    await executeStatement(this.db, sql`
      INSERT INTO xpod_matrix_transactions (scope, transaction_key, event_id, created_at, content_hash)
      VALUES (${scope}, ${key}, ${candidate.eventId}, ${candidate.createdAt}, ${candidate.contentHash})
      ON CONFLICT (scope, transaction_key) DO NOTHING
    `);
    const result = await executeQuery<{ event_id: string; created_at: number | string; content_hash: string }>(this.db, sql`
      SELECT event_id, created_at, content_hash FROM xpod_matrix_transactions
      WHERE scope = ${scope} AND transaction_key = ${key}
    `);
    const row = result.rows[0];
    if (!row) {
      throw new Error('Matrix transaction reservation disappeared');
    }
    return { eventId: row.event_id, createdAt: Number(row.created_at), contentHash: row.content_hash };
  }

  public async replaceReservation(scope: string, key: string, candidate: MatrixTransactionReservation): Promise<void> {
    await this.ensureInitialized();
    await executeStatement(this.db, sql`
      UPDATE xpod_matrix_transactions
      SET event_id = ${candidate.eventId}, created_at = ${candidate.createdAt}, content_hash = ${candidate.contentHash}
      WHERE scope = ${scope} AND transaction_key = ${key}
    `);
  }

  public async findReservation(scope: string, event: MatrixReservationLookup): Promise<MatrixTransactionReservation | undefined> {
    await this.ensureInitialized();
    const result = await executeQuery<{event_id:string;created_at:number|string;content_hash:string}>(this.db,sql`
      SELECT event_id,created_at,content_hash FROM xpod_matrix_transactions WHERE scope=${scope} AND event_id=${event.eventId}
    `);
    const row=result.rows[0];
    return row ? {eventId:row.event_id,createdAt:Number(row.created_at),contentHash:row.content_hash} : undefined;
  }

  public async registerEvent(scope: string, roomId: string, eventId: string): Promise<number> {
    await this.ensureInitialized();
    // Registered references are immutable. A committed hit needs no write lock;
    // concurrent misses still converge through the unique constraint below.
    const existing = await this.findEventSequence(this.db, scope, roomId, eventId);
    if (existing !== undefined) {
      return existing;
    }
    if (isDatabaseSqlite(this.db)) {
      return this.insertEvent(this.db, scope, roomId, eventId);
    }
    // BIGSERIAL allocation alone is insufficient: a later sequence could commit first,
    // allowing readers to advance past an uncommitted event. Serialize writers until commit.
    return this.db.transaction(async (transaction: IdentityDatabase): Promise<number> => {
      await executeStatement(transaction, sql`LOCK TABLE xpod_matrix_events IN SHARE ROW EXCLUSIVE MODE`);
      return this.insertEvent(transaction, scope, roomId, eventId);
    });
  }

  public async registerEvents(scope: string, roomId: string, eventIds: readonly string[]): Promise<number[]> {
    await this.ensureInitialized();
    if (eventIds.length === 0) return [];
    const unique = [...new Set(eventIds)];
    const known = await this.sequencesFor(this.db, scope, roomId, unique);
    const missing = unique.filter(eventId => !known.has(eventId));
    if (missing.length > 0) {
      if (isDatabaseSqlite(this.db)) {
        await this.insertEvents(this.db, scope, roomId, missing);
      } else {
        // One lock for the whole page instead of one per event; commit order is
        // still serialized so the high watermark cannot pass an uncommitted page.
        await this.db.transaction(async (transaction: IdentityDatabase): Promise<void> => {
          await executeStatement(transaction, sql`LOCK TABLE xpod_matrix_events IN SHARE ROW EXCLUSIVE MODE`);
          await this.insertEvents(transaction, scope, roomId, missing);
        });
      }
      for (const [ eventId, sequence ] of await this.sequencesFor(this.db, scope, roomId, missing)) {
        known.set(eventId, sequence);
      }
    }
    return eventIds.map(eventId => {
      const sequence = known.get(eventId);
      if (sequence === undefined) throw new Error('Matrix event registration disappeared');
      return sequence;
    });
  }

  public async findReservations(scope: string, events: readonly MatrixReservationLookup[]): Promise<Map<string, MatrixTransactionReservation>> {
    await this.ensureInitialized();
    const found = new Map<string, MatrixTransactionReservation>();
    const eventIds = events.map(event => event.eventId);
    if (eventIds.length === 0) return found;
    const result = await executeQuery<{ event_id: string; created_at: number | string; content_hash: string }>(this.db, sql`
      SELECT event_id, created_at, content_hash FROM xpod_matrix_transactions
      WHERE scope = ${scope} AND event_id IN (${sql.join([...new Set(eventIds)].map(id => sql`${id}`), sql`, `)})
    `);
    for (const row of result.rows) {
      found.set(row.event_id, { eventId: row.event_id, createdAt: Number(row.created_at), contentHash: row.content_hash });
    }
    return found;
  }

  private async sequencesFor(db: IdentityDatabase, scope: string, roomId: string, eventIds: readonly string[]): Promise<Map<string, number>> {
    const sequences = new Map<string, number>();
    if (eventIds.length === 0) return sequences;
    const result = await executeQuery<{ event_id: string; sequence: number | string }>(db, sql`
      SELECT event_id, sequence FROM xpod_matrix_events
      WHERE scope = ${scope} AND room_id = ${roomId}
        AND event_id IN (${sql.join([...eventIds].map(id => sql`${id}`), sql`, `)})
    `);
    for (const row of result.rows) sequences.set(row.event_id, this.toSequence(row.sequence));
    return sequences;
  }

  private async insertEvents(db: IdentityDatabase, scope: string, roomId: string, eventIds: readonly string[]): Promise<void> {
    // Values are bound as parameters, so embedded quotes cannot break out.
    const rows = eventIds.map(eventId => sql`(${scope}, ${roomId}, ${eventId})`);
    await executeStatement(db, sql`
      INSERT INTO xpod_matrix_events (scope, room_id, event_id)
      VALUES ${sql.join(rows, sql`, `)}
      ON CONFLICT (scope, room_id, event_id) DO NOTHING
    `);
  }

  public async getHighWatermark(scope: string): Promise<number> {
    await this.ensureInitialized();
    const result = await executeQuery<{ sequence: number | string }>(this.db, sql`
      SELECT COALESCE(MAX(sequence), 0) AS sequence FROM xpod_matrix_events WHERE scope = ${scope}
    `);
    return this.toSequence(result.rows[0]?.sequence ?? 0);
  }

  private async insertEvent(db: IdentityDatabase, scope: string, roomId: string, eventId: string): Promise<number> {
    await executeStatement(db, sql`
      INSERT INTO xpod_matrix_events (scope, room_id, event_id) VALUES (${scope}, ${roomId}, ${eventId})
      ON CONFLICT (scope, room_id, event_id) DO NOTHING
    `);
    const sequence = await this.findEventSequence(db, scope, roomId, eventId);
    if (sequence === undefined) {
      throw new Error('Matrix event registration disappeared');
    }
    return sequence;
  }

  private async findEventSequence(db: IdentityDatabase, scope: string, roomId: string, eventId: string): Promise<number | undefined> {
    const result = await executeQuery<{ sequence: number | string }>(db, sql`
      SELECT sequence FROM xpod_matrix_events WHERE scope = ${scope} AND room_id = ${roomId} AND event_id = ${eventId}
    `);
    return result.rows[0] ? this.toSequence(result.rows[0].sequence) : undefined;
  }

  private toSequence(value: number | string): number {
    const sequence = Number(value);
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new Error('Matrix event sequence exceeds the supported cursor range');
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
    // Honor the shared identity database's readiness before opening a transaction.
    await executeQuery(this.db, sql`SELECT 1`);
    await this.db.transaction(async (transaction: IdentityDatabase): Promise<void> => {
      // IF NOT EXISTS alone races on PostgreSQL catalog types during cold starts.
      await executeQuery(transaction, sql`SELECT pg_advisory_xact_lock(hashtext('xpod_matrix_journal_schema'))`);
      await this.createTables(transaction);
    });
  }

  private async createTables(db: IdentityDatabase): Promise<void> {
    await executeStatement(db, sql`
      CREATE TABLE IF NOT EXISTS xpod_matrix_transactions (
        scope TEXT NOT NULL,
        transaction_key TEXT NOT NULL,
        event_id TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        content_hash TEXT NOT NULL,
        PRIMARY KEY (scope, transaction_key)
      )
    `);
    await executeStatement(db, sql`CREATE INDEX IF NOT EXISTS xpod_matrix_transaction_event ON xpod_matrix_transactions (scope, event_id)`);
    const sequenceType = isDatabaseSqlite(db)
      ? sql.raw('INTEGER PRIMARY KEY AUTOINCREMENT')
      : sql.raw('BIGSERIAL PRIMARY KEY');
    await executeStatement(db, sql`
      CREATE TABLE IF NOT EXISTS xpod_matrix_events (
        sequence ${sequenceType},
        scope TEXT NOT NULL,
        room_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        UNIQUE (scope, room_id, event_id)
      )
    `);
  }
}
