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
  registerEvent(scope: string, roomId: string, eventId: string): Promise<number>;
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
