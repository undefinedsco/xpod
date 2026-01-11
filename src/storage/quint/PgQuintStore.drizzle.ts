/**
 * PgQuintStore - PostgreSQL implementation of QuintStore
 * 
 * Features:
 * - Full ACID transactions
 * - Efficient graph prefix queries using btree index
 * - Connection pooling via pg Pool
 * - Vector embeddings stored as JSON
 */

import { Pool, type PoolConfig } from 'pg';
import { wrap, AsyncIterator } from 'asynciterator';
import type { Term } from '@rdfjs/types';

import { 
  rowToQuad, 
  parseVector,
  termToId,
  serializeObject,
} from './serialization';
import type {
  Quint,
  QuintPattern,
  QuintStore,
  QuintStoreOptions,
  QueryOptions,
  StoreStats,
  TermMatch,
  TermOperators,
} from './types';
import { isTerm } from './types';

export interface PgQuintStoreOptions extends QuintStoreOptions {
  /** PostgreSQL connection string */
  connectionString?: string;
  /** Maximum number of connections in pool */
  poolMax?: number;
  /** Idle timeout in milliseconds */
  poolIdleTimeoutMillis?: number;
  /** Connection timeout in milliseconds */
  poolConnectionTimeoutMillis?: number;
}

interface DbRow {
  graph: string;
  subject: string;
  predicate: string;
  object: string;
  embedding: string | null;
}

export class PgQuintStore {
  private pool: Pool | null = null;
  private options: PgQuintStoreOptions;

  constructor(options: PgQuintStoreOptions) {
    this.options = options;
  }

  async open(): Promise<void> {
    const poolConfig: PoolConfig = {
      connectionString: this.options.connectionString,
      max: this.options.poolMax ?? 20,
      idleTimeoutMillis: this.options.poolIdleTimeoutMillis ?? 30000,
      connectionTimeoutMillis: this.options.poolConnectionTimeoutMillis ?? 2000,
    };

    this.pool = new Pool(poolConfig);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS quints (
        graph TEXT NOT NULL,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        embedding TEXT,
        PRIMARY KEY (graph, subject, predicate, object)
      );

      CREATE INDEX IF NOT EXISTS idx_pg_spog ON quints (subject, predicate, object, graph);
      CREATE INDEX IF NOT EXISTS idx_pg_ogsp ON quints (object, graph, subject, predicate);
      CREATE INDEX IF NOT EXISTS idx_pg_gspo ON quints (graph, subject, predicate, object);
      CREATE INDEX IF NOT EXISTS idx_pg_sopg ON quints (subject, object, predicate, graph);
      CREATE INDEX IF NOT EXISTS idx_pg_pogs ON quints (predicate, object, graph, subject);
      CREATE INDEX IF NOT EXISTS idx_pg_gpos ON quints (graph, predicate, object, subject);
      CREATE INDEX IF NOT EXISTS idx_pg_graph_prefix ON quints (graph text_pattern_ops);
    `);
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  async get(pattern: QuintPattern, options?: QueryOptions): Promise<Quint[]> {
    this.ensureOpen();

    const { whereClause, params } = this.buildWhereClause(pattern);
    
    let queryText = `SELECT graph, subject, predicate, object, embedding FROM quints`;
    if (whereClause) {
      queryText += ` WHERE ${whereClause}`;
    }

    if (options?.limit) {
      queryText += ` LIMIT ${options.limit}`;
    }
    if (options?.offset) {
      queryText += ` OFFSET ${options.offset}`;
    }

    const result = await this.pool!.query<DbRow>(queryText, params);
    return result.rows.map(row => this.rowToQuint(row));
  }

  match(
    subject?: Term | null,
    predicate?: Term | null,
    object?: Term | null,
    graph?: Term | null,
  ): AsyncIterator<Quint> {
    const pattern: QuintPattern = {};
    if (subject) pattern.subject = subject;
    if (predicate) pattern.predicate = predicate;
    if (object) pattern.object = object;
    if (graph) pattern.graph = graph;

    return wrap(this.get(pattern));
  }

  async getByGraphPrefix(prefix: string, options?: QueryOptions): Promise<Quint[]> {
    return this.get({ graph: { $startsWith: prefix } }, options);
  }

  async count(pattern: QuintPattern): Promise<number> {
    this.ensureOpen();

    const { whereClause, params } = this.buildWhereClause(pattern);
    
    let queryText = `SELECT count(*)::int as count FROM quints`;
    if (whereClause) {
      queryText += ` WHERE ${whereClause}`;
    }

    const result = await this.pool!.query<{ count: number }>(queryText, params);
    return result.rows[0]?.count ?? 0;
  }

  async put(quint: Quint): Promise<void> {
    this.ensureOpen();

    const row = this.quintToRow(quint);

    await this.pool!.query(`
      INSERT INTO quints (graph, subject, predicate, object, embedding)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (graph, subject, predicate, object)
      DO UPDATE SET embedding = EXCLUDED.embedding
    `, [row.graph, row.subject, row.predicate, row.object, row.embedding]);
  }

  async multiPut(quints: Quint[]): Promise<void> {
    this.ensureOpen();

    if (quints.length === 0) return;

    const client = await this.pool!.connect();
    try {
      await client.query('BEGIN');

      for (const quint of quints) {
        const row = this.quintToRow(quint);
        await client.query(`
          INSERT INTO quints (graph, subject, predicate, object, embedding)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (graph, subject, predicate, object)
          DO UPDATE SET embedding = EXCLUDED.embedding
        `, [row.graph, row.subject, row.predicate, row.object, row.embedding]);
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async updateEmbedding(pattern: QuintPattern, embedding: number[]): Promise<number> {
    this.ensureOpen();

    const { whereClause, params } = this.buildWhereClause(pattern);
    const embeddingJson = JSON.stringify(embedding);

    let queryText = `UPDATE quints SET embedding = $${params.length + 1}`;
    if (whereClause) {
      queryText += ` WHERE ${whereClause}`;
    }

    const result = await this.pool!.query(queryText, [...params, embeddingJson]);
    return result.rowCount ?? 0;
  }

  async del(pattern: QuintPattern): Promise<number> {
    this.ensureOpen();

    const { whereClause, params } = this.buildWhereClause(pattern);

    let queryText = `DELETE FROM quints`;
    if (whereClause) {
      queryText += ` WHERE ${whereClause}`;
    }

    const result = await this.pool!.query(queryText, params);
    return result.rowCount ?? 0;
  }

  async multiDel(quints: Quint[]): Promise<void> {
    this.ensureOpen();

    if (quints.length === 0) return;

    const client = await this.pool!.connect();
    try {
      await client.query('BEGIN');

      for (const quint of quints) {
        const g = termToId(quint.graph as any);
        const s = termToId(quint.subject as any);
        const p = termToId(quint.predicate as any);
        const o = serializeObject(quint.object as any);

        await client.query(`
          DELETE FROM quints 
          WHERE graph = $1 AND subject = $2 AND predicate = $3 AND object = $4
        `, [g, s, p, o]);
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async stats(): Promise<StoreStats> {
    this.ensureOpen();

    const totalResult = await this.pool!.query<{ count: number }>(
      `SELECT count(*)::int as count FROM quints`
    );

    const vectorResult = await this.pool!.query<{ count: number }>(
      `SELECT count(*)::int as count FROM quints WHERE embedding IS NOT NULL`
    );

    const graphResult = await this.pool!.query<{ count: number }>(
      `SELECT COUNT(DISTINCT graph)::int as count FROM quints`
    );

    return {
      totalCount: totalResult.rows[0]?.count ?? 0,
      vectorCount: vectorResult.rows[0]?.count ?? 0,
      graphCount: graphResult.rows[0]?.count ?? 0,
    };
  }

  async clear(): Promise<void> {
    this.ensureOpen();
    await this.pool!.query('DELETE FROM quints');
  }

  async optimize(): Promise<void> {
    this.ensureOpen();
    await this.pool!.query('VACUUM ANALYZE quints');
  }

  private ensureOpen(): void {
    if (!this.pool) {
      throw new Error('Store not open. Call open() first.');
    }
  }

  private buildWhereClause(pattern: QuintPattern): { whereClause: string; params: (string | number | string[])[] } {
    const conditions: string[] = [];
    const params: (string | number | string[])[] = [];

    // Helper to serialize operator value
    const serializeOpValue = (value: any, isObject: boolean): string | number => {
      if (typeof value === 'object' && 'termType' in value) {
        return isObject ? serializeObject(value as any) : termToId(value as any);
      }
      if (typeof value === 'number') {
        return String(value);
      }
      return value;
    };

    const addTermConditions = (column: string, match: TermMatch | undefined, isObject: boolean = false) => {
      if (!match) return;

      if (isTerm(match)) {
        // Exact Term match
        params.push(isObject ? serializeObject(match as any) : termToId(match as any));
        conditions.push(`${column} = $${params.length}`);
      } else {
        // Operator match
        const ops = match as TermOperators;

        if (ops.$eq !== undefined) {
          params.push(serializeOpValue(ops.$eq, isObject));
          conditions.push(`${column} = $${params.length}`);
        }
        if (ops.$ne !== undefined) {
          params.push(serializeOpValue(ops.$ne, isObject));
          conditions.push(`${column} != $${params.length}`);
        }
        if (ops.$gt !== undefined) {
          params.push(serializeOpValue(ops.$gt, isObject));
          conditions.push(`${column} > $${params.length}`);
        }
        if (ops.$gte !== undefined) {
          params.push(serializeOpValue(ops.$gte, isObject));
          conditions.push(`${column} >= $${params.length}`);
        }
        if (ops.$lt !== undefined) {
          params.push(serializeOpValue(ops.$lt, isObject));
          conditions.push(`${column} < $${params.length}`);
        }
        if (ops.$lte !== undefined) {
          params.push(serializeOpValue(ops.$lte, isObject));
          conditions.push(`${column} <= $${params.length}`);
        }
        if (ops.$in !== undefined && ops.$in.length > 0) {
          const startIdx = params.length;
          for (const val of ops.$in) {
            params.push(serializeOpValue(val, isObject));
          }
          const inPlaceholders = ops.$in.map((_, i) => `$${startIdx + i + 1}`).join(', ');
          conditions.push(`${column} IN (${inPlaceholders})`);
        }
        if (ops.$notIn !== undefined && ops.$notIn.length > 0) {
          const startIdx = params.length;
          for (const val of ops.$notIn) {
            params.push(serializeOpValue(val, isObject));
          }
          const notInPlaceholders = ops.$notIn.map((_, i) => `$${startIdx + i + 1}`).join(', ');
          conditions.push(`${column} NOT IN (${notInPlaceholders})`);
        }
        if (ops.$startsWith !== undefined) {
          // Use range query for prefix matching (index-friendly)
          params.push(ops.$startsWith);
          params.push(ops.$startsWith + '\uffff');
          conditions.push(`${column} >= $${params.length - 1} AND ${column} < $${params.length}`);
        }
        if (ops.$endsWith !== undefined) {
          params.push(`%${ops.$endsWith}`);
          conditions.push(`${column} LIKE $${params.length}`);
        }
        if (ops.$contains !== undefined) {
          params.push(`%${ops.$contains}%`);
          conditions.push(`${column} LIKE $${params.length}`);
        }
        if (ops.$regex !== undefined) {
          params.push(ops.$regex);
          conditions.push(`${column} ~ $${params.length}`);
        }
        if (ops.$isNull === true) {
          conditions.push(`${column} IS NULL`);
        }
        if (ops.$isNull === false) {
          conditions.push(`${column} IS NOT NULL`);
        }
      }
    };

    addTermConditions('graph', pattern.graph);
    addTermConditions('subject', pattern.subject);
    addTermConditions('predicate', pattern.predicate);
    addTermConditions('object', pattern.object, true);

    return {
      whereClause: conditions.length > 0 ? conditions.join(' AND ') : '',
      params,
    };
  }

  private quintToRow(quint: Quint): DbRow {
    return {
      graph: termToId(quint.graph as any),
      subject: termToId(quint.subject as any),
      predicate: termToId(quint.predicate as any),
      object: serializeObject(quint.object as any),
      embedding: quint.vector ? JSON.stringify(quint.vector) : null,
    };
  }

  private rowToQuint(row: DbRow): Quint {
    const quad = rowToQuad({
      graph: row.graph,
      subject: row.subject,
      predicate: row.predicate,
      object: row.object,
    });
    const quint: Quint = quad as Quint;
    if (row.embedding) {
      quint.vector = parseVector(row.embedding);
    }
    return quint;
  }
}
