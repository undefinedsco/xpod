import type { PGlite } from '@electric-sql/pglite';

export interface PostgresRdfSqlExecutor {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string, params?: unknown[]): Promise<void>;
  transaction<T>(fn: (tx: PostgresRdfSqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const PG_STRING_ESCAPE = '\u001f';

export class PgliteRdfSqlExecutor implements PostgresRdfSqlExecutor {
  public constructor(private readonly db: PGlite) {}

  public async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.db.query(sql, normalizePgParams(params));
    return (result.rows as T[]).map((row) => restorePgRow(row));
  }

  public async exec(sql: string, params: unknown[] = []): Promise<void> {
    if (params.length === 0) {
      await this.db.exec(sql);
      return;
    }
    await this.db.query(sql, normalizePgParams(params));
  }

  public async transaction<T>(fn: (tx: PostgresRdfSqlExecutor) => Promise<T>): Promise<T> {
    await this.db.query('BEGIN');
    try {
      const result = await fn(this);
      await this.db.query('COMMIT');
      return result;
    } catch (error) {
      await this.db.query('ROLLBACK');
      throw error;
    }
  }

  public async close(): Promise<void> {
    await this.db.close();
  }
}

export class PgPoolRdfSqlExecutor implements PostgresRdfSqlExecutor {
  public constructor(private readonly pool: any, private readonly client?: any) {}

  public async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = this.client
      ? await this.client.query(sql, normalizePgParams(params))
      : await this.pool.query(sql, normalizePgParams(params));
    return (result.rows as T[]).map((row: T) => restorePgRow(row));
  }

  public async exec(sql: string, params: unknown[] = []): Promise<void> {
    if (this.client) {
      await this.client.query(sql, normalizePgParams(params));
      return;
    }
    await this.pool.query(sql, normalizePgParams(params));
  }

  public async transaction<T>(fn: (tx: PostgresRdfSqlExecutor) => Promise<T>): Promise<T> {
    if (this.client) {
      return await fn(this);
    }
    const client = await this.pool.connect();
    const tx = new PgPoolRdfSqlExecutor(this.pool, client);
    try {
      await client.query('BEGIN');
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async close(): Promise<void> {
    // Caller-owned pools are not closed here. Shared pools are released by the
    // index class before this executor is asked to close.
  }
}

function normalizePgParams(params: unknown[]): unknown[] {
  return params.map((value) => normalizePgValue(value));
}

function normalizePgValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return toPgSafe(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizePgValue(item));
  }
  return value;
}

function toPgSafe(value: string): string {
  return value
    .replaceAll(PG_STRING_ESCAPE, `${PG_STRING_ESCAPE}${PG_STRING_ESCAPE}`)
    .replaceAll('\u0000', `${PG_STRING_ESCAPE}0`);
}

function fromPgSafe(value: string): string {
  let result = '';
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char !== PG_STRING_ESCAPE) {
      result += char;
      continue;
    }
    const next = value[i + 1];
    if (next === '0') {
      result += '\u0000';
      i += 1;
    } else if (next === PG_STRING_ESCAPE) {
      result += PG_STRING_ESCAPE;
      i += 1;
    } else {
      result += '\u0000';
    }
  }
  return result;
}

function restorePgRow<T>(row: T): T {
  if (!row || typeof row !== 'object') {
    return row;
  }
  const restored: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    restored[key] = typeof value === 'string' ? fromPgSafe(value) : value;
  }
  return restored as T;
}
