/**
 * SqliteQuintStore - SQLite implementation of QuintStore using Drizzle ORM
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq, ne, and, gte, gt, lt, lte, like, inArray, notInArray, isNull, isNotNull, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { wrap, AsyncIterator } from 'asynciterator';
import { DataFactory } from 'n3';
import type { Term, Quad } from '@rdfjs/types';

import { quints, type QuintRow, type NewQuintRow } from './schema';
import { 
  quadToRow, 
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

export interface SqliteQuintStoreOptions extends QuintStoreOptions {
  /** SQLite database file path, use ':memory:' for in-memory database */
  path: string;
}

export class SqliteQuintStore {
  private sqlite: Database.Database | null = null;
  private db: BetterSQLite3Database | null = null;
  private options: SqliteQuintStoreOptions;

  constructor(options: SqliteQuintStoreOptions) {
    // Handle sqlite: prefix
    let path = options.path;
    if (path.startsWith('sqlite:')) {
      path = path.slice(7);
    }
    this.options = { ...options, path };
  }

  // ============================================
  // Lifecycle
  // ============================================

  async open(): Promise<void> {
    // Idempotent: if already open, do nothing
    if (this.sqlite) {
      return;
    }

    const dbPath = this.options.path;
    
    // Ensure directory exists (unless it's in-memory)
    if (dbPath !== ':memory:') {
      const dir = dirname(dbPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
    
    this.sqlite = new Database(dbPath);
    this.db = drizzle(this.sqlite);

    // Create table and indexes
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS quints (
        graph TEXT NOT NULL,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        vector TEXT,
        PRIMARY KEY (graph, subject, predicate, object)
      );

      CREATE INDEX IF NOT EXISTS idx_spog ON quints (subject, predicate, object, graph);
      CREATE INDEX IF NOT EXISTS idx_ogsp ON quints (object, graph, subject, predicate);
      CREATE INDEX IF NOT EXISTS idx_gspo ON quints (graph, subject, predicate, object);
      CREATE INDEX IF NOT EXISTS idx_sopg ON quints (subject, object, predicate, graph);
      CREATE INDEX IF NOT EXISTS idx_pogs ON quints (predicate, object, graph, subject);
      CREATE INDEX IF NOT EXISTS idx_gpos ON quints (graph, predicate, object, subject);
    `);
  }

  async close(): Promise<void> {
    if (this.sqlite) {
      this.sqlite.close();
      this.sqlite = null;
      this.db = null;
    }
  }

  // ============================================
  // Query Operations
  // ============================================

  async get(pattern: QuintPattern, options?: QueryOptions): Promise<Quint[]> {
    this.ensureOpen();

    const conditions = this.buildConditions(pattern);
    
    let query = this.db!.select().from(quints);
    
    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }

    if (options?.limit) {
      query = query.limit(options.limit) as any;
    }
    if (options?.offset) {
      // SQLite requires LIMIT when using OFFSET
      if (!options?.limit) {
        query = query.limit(-1) as any; // -1 means no limit in SQLite
      }
      query = query.offset(options.offset) as any;
    }

    const rows = await query;
    return rows.map(row => this.rowToQuint(row));
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

    const conditions = this.buildConditions(pattern);

    let query = this.db!.select({ count: sql<number>`count(*)` }).from(quints);

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }

    const result = await query;
    return result[0]?.count ?? 0;
  }

  // ============================================
  // Write Operations
  // ============================================

  async put(quint: Quint): Promise<void> {
    this.ensureOpen();

    const row = this.quintToRow(quint);

    await this.db!.insert(quints)
      .values(row)
      .onConflictDoUpdate({
        target: [quints.graph, quints.subject, quints.predicate, quints.object],
        set: { vector: row.vector },
      });
  }

  async multiPut(quintList: Quint[]): Promise<void> {
    this.ensureOpen();

    if (quintList.length === 0) return;

    const rows = quintList.map(q => this.quintToRow(q));

    // Use transaction for batch insert
    this.sqlite!.transaction(() => {
      for (const row of rows) {
        this.db!.insert(quints)
          .values(row)
          .onConflictDoUpdate({
            target: [quints.graph, quints.subject, quints.predicate, quints.object],
            set: { vector: row.vector },
          })
          .run();
      }
    })();
  }

  async updateEmbedding(pattern: QuintPattern, embedding: number[]): Promise<number> {
    this.ensureOpen();

    const conditions = this.buildConditions(pattern);
    const vectorJson = JSON.stringify(embedding);

    if (conditions.length === 0) {
      const result = await this.db!.update(quints)
        .set({ vector: vectorJson });
      return result.changes;
    }

    const result = await this.db!.update(quints)
      .set({ vector: vectorJson })
      .where(and(...conditions));

    return result.changes;
  }

  // ============================================
  // Delete Operations
  // ============================================

  async del(pattern: QuintPattern): Promise<number> {
    this.ensureOpen();

    const conditions = this.buildConditions(pattern);

    if (conditions.length === 0) {
      // Delete all - dangerous!
      const result = await this.db!.delete(quints);
      return result.changes;
    }

    const result = await this.db!.delete(quints).where(and(...conditions));
    return result.changes;
  }

  async multiDel(quintList: Quint[]): Promise<void> {
    this.ensureOpen();

    if (quintList.length === 0) return;

    this.sqlite!.transaction(() => {
      for (const quint of quintList) {
        const g = termToId(quint.graph as any);
        const s = termToId(quint.subject as any);
        const p = termToId(quint.predicate as any);
        const o = serializeObject(quint.object as any);

        this.db!.delete(quints)
          .where(
            and(
              eq(quints.graph, g),
              eq(quints.subject, s),
              eq(quints.predicate, p),
              eq(quints.object, o),
            ),
          )
          .run();
      }
    })();
  }

  // ============================================
  // Management
  // ============================================

  async stats(): Promise<StoreStats> {
    this.ensureOpen();

    const totalResult = await this.db!
      .select({ count: sql<number>`count(*)` })
      .from(quints);

    const vectorResult = await this.db!
      .select({ count: sql<number>`count(*)` })
      .from(quints)
      .where(sql`${quints.vector} IS NOT NULL`);

    const graphResult = await this.db!
      .select({ count: sql<number>`COUNT(DISTINCT ${quints.graph})` })
      .from(quints);

    return {
      totalCount: totalResult[0]?.count ?? 0,
      vectorCount: vectorResult[0]?.count ?? 0,
      graphCount: graphResult[0]?.count ?? 0,
    };
  }

  async clear(): Promise<void> {
    this.ensureOpen();
    await this.db!.delete(quints);
  }

  // ============================================
  // Private Helpers
  // ============================================

  private ensureOpen(): void {
    if (!this.db) {
      throw new Error('Store not open. Call open() first.');
    }
  }

  private buildConditions(pattern: QuintPattern): SQL[] {
    const conditions: SQL[] = [];

    const addTermConditions = (
      column: typeof quints.graph | typeof quints.subject | typeof quints.predicate | typeof quints.object,
      match: TermMatch | undefined,
      isObject: boolean = false
    ) => {
      if (!match) return;

      if (isTerm(match)) {
        // Exact Term match
        conditions.push(eq(column, isObject ? serializeObject(match as any) : termToId(match as any)));
      } else {
        // Operator match
        const ops = match as TermOperators;

        if (ops.$eq !== undefined) {
          conditions.push(eq(column, ops.$eq));
        }
        if (ops.$ne !== undefined) {
          conditions.push(ne(column, ops.$ne));
        }
        if (ops.$gt !== undefined) {
          conditions.push(gt(column, ops.$gt));
        }
        if (ops.$gte !== undefined) {
          conditions.push(gte(column, ops.$gte));
        }
        if (ops.$lt !== undefined) {
          conditions.push(lt(column, ops.$lt));
        }
        if (ops.$lte !== undefined) {
          conditions.push(lte(column, ops.$lte));
        }
        if (ops.$in !== undefined && ops.$in.length > 0) {
          conditions.push(inArray(column, ops.$in));
        }
        if (ops.$notIn !== undefined && ops.$notIn.length > 0) {
          conditions.push(notInArray(column, ops.$notIn));
        }
        if (ops.$startsWith !== undefined) {
          // Use range query for prefix matching (index-friendly)
          conditions.push(gte(column, ops.$startsWith));
          conditions.push(lt(column, ops.$startsWith + '\uffff'));
        }
        if (ops.$endsWith !== undefined) {
          conditions.push(like(column, `%${ops.$endsWith}`));
        }
        if (ops.$contains !== undefined) {
          conditions.push(like(column, `%${ops.$contains}%`));
        }
        if (ops.$regex !== undefined) {
          // SQLite uses GLOB as regex approximation
          conditions.push(sql`${column} GLOB ${ops.$regex.replace(/\.\*/g, '*').replace(/\./g, '?')}`);
        }
        if (ops.$isNull === true) {
          conditions.push(isNull(column));
        }
        if (ops.$isNull === false) {
          conditions.push(isNotNull(column));
        }
      }
    };

    addTermConditions(quints.graph, pattern.graph);
    addTermConditions(quints.subject, pattern.subject);
    addTermConditions(quints.predicate, pattern.predicate);
    addTermConditions(quints.object, pattern.object, true);

    return conditions;
  }

  private quintToRow(quint: Quint): NewQuintRow {
    return {
      graph: termToId(quint.graph as any),
      subject: termToId(quint.subject as any),
      predicate: termToId(quint.predicate as any),
      object: serializeObject(quint.object as any),
      vector: quint.vector ? JSON.stringify(quint.vector) : null,
    };
  }

  private rowToQuint(row: QuintRow): Quint {
    const quad = rowToQuad(row);
    const quint: Quint = quad as Quint;
    if (row.vector) {
      quint.vector = parseVector(row.vector);
    }
    return quint;
  }
}
