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

/** Operational references only: event bodies and room state remain authoritative in the Pod. */
export interface MatrixEventJournal {
  reserveTransaction(scope: string, key: string, candidate: MatrixTransactionReservation): Promise<MatrixTransactionReservation>;
  /**
   * Replace the content hash of an existing reservation while keeping its event
   * id and time. Only valid for a reservation whose output was never written;
   * callers must verify that before taking one over.
   */
  updateReservation(scope: string, key: string, contentHash: string): Promise<void>;
  registerEvent(scope: string, roomId: string, eventId: string): Promise<number>;
  /**
   * Register a page of events in one pass. Sequences are assigned in input
   * order, exactly as sequential `registerEvent` calls would, but the journal
   * round-trips stay bounded instead of growing with the page size.
   */
  registerEvents(scope: string, roomId: string, eventIds: readonly string[]): Promise<number[]>;
  /** Look up several receipts at once: recovery needs one per scanned event. */
  findReservations(scope: string, eventIds: readonly string[]): Promise<Map<string, MatrixTransactionReservation>>;
  getHighWatermark(scope: string): Promise<number>;
  findReservation(scope: string, eventId: string): Promise<MatrixTransactionReservation | undefined>;
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

  public async findReservation(scope: string, eventId: string): Promise<MatrixTransactionReservation | undefined> {
    for (const [key,value] of this.transactions) if (JSON.parse(key)[0] === scope && value.eventId === eventId) return {...value};
    return undefined;
  }

  public async updateReservation(scope: string, key: string, contentHash: string): Promise<void> {
    const identity = JSON.stringify([ scope, key ]);
    const existing = this.transactions.get(identity);
    if (existing) this.transactions.set(identity, { ...existing, contentHash });
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

  public async findReservations(scope: string, eventIds: readonly string[]): Promise<Map<string, MatrixTransactionReservation>> {
    const wanted = new Set(eventIds);
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

  public async updateReservation(scope: string, key: string, contentHash: string): Promise<void> {
    await this.ensureInitialized();
    await executeStatement(this.db, sql`
      UPDATE xpod_matrix_transactions SET content_hash = ${contentHash}
      WHERE scope = ${scope} AND transaction_key = ${key}
    `);
  }

  public async findReservation(scope: string, eventId: string): Promise<MatrixTransactionReservation | undefined> {
    await this.ensureInitialized();
    const result = await executeQuery<{event_id:string;created_at:number|string;content_hash:string}>(this.db,sql`
      SELECT event_id,created_at,content_hash FROM xpod_matrix_transactions WHERE scope=${scope} AND event_id=${eventId}
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

  public async findReservations(scope: string, eventIds: readonly string[]): Promise<Map<string, MatrixTransactionReservation>> {
    await this.ensureInitialized();
    const found = new Map<string, MatrixTransactionReservation>();
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
