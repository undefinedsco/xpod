/**
 * SqliteQuintStore - SQLite implementation of QuintStore using Drizzle ORM
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Term } from '@rdfjs/types';

import { BaseQuintStore, type QuintRow, type SqlExecutor } from './BaseQuintStore';
import type { NewQuintRow } from './schema';
import {
  rowToQuad,
  parseVector,
  termToId,
  serializeObject,
  isSerializedDateTimeLiteral,
  isSerializedNumericLiteral,
  SEP,
} from './serialization';
import { getSqliteRuntime, type SqliteDatabase } from '../SqliteRuntime';
import type {
  QuintStoreOptions,
  StoreStats,
  StoreSpaceObject,
  QuintPattern,
  QueryOptions,
  Quint,
  TermMatch,
  TermOperators,
  OperatorValue,
} from './types';
import {
  getPredicateObjectDataType,
  objectIndexFieldsFromSerialized,
  objectIndexFieldsFromTerm,
  type ObjectIndexFields,
  type PredicateObjectDataType,
} from './value-types';

const SQLITE_UNBOUNDED_LIMIT = Number.MAX_SAFE_INTEGER;

interface SqliteIndexedQuintRow extends NewQuintRow {
  graph: string;
  subject: string;
  predicate: string;
  object: string;
  vector: string | null;
  objectKind: PredicateObjectDataType;
  objectKey: string | null;
  objectText: string | null;
  objectDigest: string | null;
}

function digestObject(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface SqliteQuintStoreOptions extends QuintStoreOptions {
  /** SQLite database file path, use ':memory:' for in-memory database */
  path: string;
}

class SqliteExecutor implements SqlExecutor {
  constructor(private readonly db: SqliteDatabase) {}

  async query<T = any>(sqlText: string, params?: any[]): Promise<T[]> {
    return this.db.prepare<T>(sqlText).all(...(params ?? []));
  }

  async execute(sqlText: string, params?: any[]): Promise<number> {
    return this.db.prepare(sqlText).run(...(params ?? [])).changes;
  }

  async executeInTransaction(statements: { sql: string; params?: any[] }[]): Promise<void> {
    this.db.transaction(() => {
      for (const statement of statements) {
        this.db.prepare(statement.sql).run(...(statement.params ?? []));
      }
    })();
  }

  async exec(sqlText: string): Promise<void> {
    this.db.exec(sqlText);
  }
}

export class SqliteQuintStore extends BaseQuintStore {
  private sqlite: SqliteDatabase | null = null;
  private readonly sqliteRuntime = getSqliteRuntime();
  private readonly path: string;

  constructor(options: SqliteQuintStoreOptions) {
    const path = options.path.startsWith('sqlite:') ? options.path.slice(7) : options.path;
    super(options);
    this.path = path;
  }

  protected async createExecutor(): Promise<SqlExecutor> {
    const dbPath = this.path;
    if (dbPath !== ':memory:') {
      const dir = dirname(dbPath);
      if (dir && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    this.sqlite = this.sqliteRuntime.openDatabase(dbPath);
    return new SqliteExecutor(this.sqlite);
  }

  protected async closeExecutor(): Promise<void> {
    if (this.sqlite) {
      this.sqlite.close();
      this.sqlite = null;
    }
  }

  protected override async openOnce(): Promise<void> {
    const executor = await this.createExecutor();
    this.executor = executor;

    try {
      await executor.exec(`
        CREATE TABLE IF NOT EXISTS quints (
          object_kind TEXT,
          object_key TEXT,
          object_text TEXT,
          object_digest TEXT,
          graph TEXT NOT NULL,
          subject TEXT NOT NULL,
          predicate TEXT NOT NULL,
          object TEXT NOT NULL,
          vector TEXT
        );
      `);

      await this.ensureTypedObjectSchema();
      await this.createTypedObjectIndexes();
      this.opened = true;
    } catch (error) {
      await this.closeExecutor().catch(() => {});
      if (this.executor === executor) {
        this.executor = null;
      }
      this.opened = false;
      throw error;
    }
  }

  protected override buildSelectQuery(pattern: QuintPattern, options?: QueryOptions): { sql: string; params: any[] } {
    const { whereClause, params } = this.buildWhereClause(pattern);

    let sqlText = `SELECT * FROM quints${whereClause}`;

    if (options?.order && options.order.length > 0) {
      const orderCols = options.order.map(field => {
        if (field === 'object') {
          const objectType = this.resolveObjectDataTypeForPattern(pattern);
          if (objectType === 'longText') {
            throw new Error('ORDER BY object is not supported for longText predicates');
          }
          return 'object_key';
        }
        return field;
      }).join(', ');
      sqlText += ` ORDER BY ${orderCols}`;
      if (options.reverse) {
        sqlText += ' DESC';
      }
    }

    if (options?.limit !== undefined) {
      sqlText += ` LIMIT ?`;
      params.push(options.limit);
    }

    if (options?.offset !== undefined) {
      if (options.limit === undefined) {
        sqlText += ` LIMIT ?`;
        params.push(SQLITE_UNBOUNDED_LIMIT);
      }
      sqlText += ` OFFSET ?`;
      params.push(options.offset);
    }

    return { sql: sqlText, params };
  }

  override async stats(): Promise<StoreStats> {
    const stats = await super.stats();
    return {
      totalCount: Number(stats.totalCount),
      vectorCount: Number(stats.vectorCount),
      graphCount: Number(stats.graphCount),
      ...this.sqliteSpaceStats(),
    };
  }

  override async clear(): Promise<void> {
    this.ensureOpen();
    await this.executor!.execute('DELETE FROM quints');
  }

  private async ensureTypedObjectSchema(): Promise<void> {
    await this.addColumnIfMissing('object_kind', 'TEXT');
    await this.addColumnIfMissing('object_key', 'TEXT');
    await this.addColumnIfMissing('object_text', 'TEXT');
    await this.addColumnIfMissing('object_digest', 'TEXT');

    for (const indexName of ['idx_spog', 'idx_ogsp', 'idx_gspo', 'idx_sopg', 'idx_pogs', 'idx_gpos']) {
      await this.executor!.exec(`DROP INDEX IF EXISTS ${indexName}`);
    }

    await this.backfillMissingObjectIndexFields();
    await this.executor!.exec(`
      UPDATE quints
      SET object_kind = 'text'
      WHERE object_kind = 'shortText'
    `);
  }

  private async addColumnIfMissing(name: string, definition: string): Promise<void> {
    const columns = new Set(
      this.sqlite!.prepare<{ name: string }>('PRAGMA table_info(quints)').all().map(row => row.name),
    );
    if (!columns.has(name)) {
      await this.executor!.exec(`ALTER TABLE quints ADD COLUMN ${name} ${definition}`);
    }
  }

  private async createTypedObjectIndexes(): Promise<void> {
    await this.executor!.exec(`
      CREATE INDEX IF NOT EXISTS idx_quints_graph ON quints (graph);
      CREATE INDEX IF NOT EXISTS idx_quints_subject ON quints (subject);
      CREATE INDEX IF NOT EXISTS idx_quints_predicate ON quints (predicate);
      CREATE INDEX IF NOT EXISTS idx_quints_object_key ON quints (object_kind, object_key);
      CREATE INDEX IF NOT EXISTS idx_quints_predicate_object_key ON quints (predicate, object_kind, object_key);
      CREATE INDEX IF NOT EXISTS idx_quints_predicate_object_digest ON quints (predicate, object_kind, object_digest);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_quints_gspo_key
        ON quints (graph, subject, predicate, object_kind, object_key)
        WHERE object_key IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_quints_gspo_digest
        ON quints (graph, subject, predicate, object_kind, object_digest)
        WHERE object_digest IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_quints_gsp ON quints (graph, subject, predicate);
      CREATE INDEX IF NOT EXISTS idx_quints_sp ON quints (subject, predicate);
      CREATE INDEX IF NOT EXISTS idx_quints_gp ON quints (graph, predicate);
    `);
  }

  private async backfillMissingObjectIndexFields(): Promise<void> {
    const rows = await this.executor!.query<{
      graph: string;
      subject: string;
      predicate: string;
      object: string;
    }>(`
      SELECT graph, subject, predicate, object
      FROM quints
      WHERE object_kind IS NULL
         OR (object_key IS NULL AND object_digest IS NULL)
    `);

    for (const row of rows) {
      const objectIndex = this.objectIndexForSerialized(row.predicate, row.object);
      await this.executor!.execute(`
        UPDATE quints
        SET object_kind = ?,
            object_key = ?,
            object_text = ?,
            object_digest = ?
        WHERE graph = ?
          AND subject = ?
          AND predicate = ?
          AND object = ?
      `, [
        objectIndex.objectKind,
        objectIndex.objectKey,
        objectIndex.objectText,
        this.objectDigestForIndex(row.object, objectIndex),
        row.graph,
        row.subject,
        row.predicate,
        row.object,
      ]);
    }
  }

  private sqliteSpaceStats(): Pick<StoreStats, 'databaseBytes' | 'tableBytes' | 'indexBytes' | 'spaceObjects'> {
    const spaceObjects = this.collectSpaceObjects();
    const databaseBytes = this.estimateDatabaseBytes();
    const accountedBytes = spaceObjects.reduce((sum, object) => sum + object.bytes, 0);
    return {
      databaseBytes: databaseBytes || accountedBytes,
      tableBytes: sumStoreSpaceObjects(spaceObjects, 'table'),
      indexBytes: sumStoreSpaceObjects(spaceObjects, 'index'),
      spaceObjects,
    };
  }

  private estimateDatabaseBytes(): number {
    try {
      const pageCount = this.sqlite!.prepare<{ page_count: number }>('PRAGMA page_count').get()?.page_count ?? 0;
      const pageSize = this.sqlite!.prepare<{ page_size: number }>('PRAGMA page_size').get()?.page_size ?? 0;
      return pageCount * pageSize;
    } catch {
      return 0;
    }
  }

  private collectSpaceObjects(): StoreSpaceObject[] {
    try {
      const schemaRows = this.sqlite!.prepare<{ name: string; type: string; tbl_name: string }>(`
        SELECT name, type, tbl_name
        FROM sqlite_schema
        WHERE type IN ('table', 'index')
      `).all();
      const rows = this.sqlite!.prepare<{ name: string; pages: number; bytes: number | null }>(`
        SELECT name, COUNT(*) AS pages, SUM(pgsize) AS bytes
        FROM dbstat
        GROUP BY name
        ORDER BY name
      `).all();

      if (rows.length > 0) {
        const schema = new Map(schemaRows.map((row) => [row.name, row]));
        return rows.map((row) => {
          const object = schema.get(row.name);
          const kind = quintSpaceObjectKind(row.name, object?.type, object?.tbl_name);
          return {
            name: row.name,
            kind,
            ...(object?.tbl_name && object.tbl_name !== row.name ? { tableName: object.tbl_name } : {}),
            pages: row.pages,
            bytes: row.bytes ?? 0,
          };
        });
      }

      return this.estimateSpaceObjectsFromSchema(schemaRows);
    } catch {
      try {
        const schemaRows = this.sqlite!.prepare<{ name: string; type: string; tbl_name: string }>(`
          SELECT name, type, tbl_name
          FROM sqlite_schema
          WHERE type IN ('table', 'index')
        `).all();
        return this.estimateSpaceObjectsFromSchema(schemaRows);
      } catch {
        return [];
      }
    }
  }

  private estimateSpaceObjectsFromSchema(schemaRows: Array<{ name: string; type: string; tbl_name: string }>): StoreSpaceObject[] {
    const pageSize = this.estimatePageSize();
    return schemaRows.map((object) => ({
      name: object.name,
      kind: quintSpaceObjectKind(object.name, object.type, object.tbl_name),
      ...(object.tbl_name && object.tbl_name !== object.name ? { tableName: object.tbl_name } : {}),
      pages: 1,
      bytes: pageSize,
    }));
  }

  private estimatePageSize(): number {
    try {
      return this.sqlite!.prepare<{ page_size: number }>('PRAGMA page_size').get()?.page_size ?? 4096;
    } catch {
      return 4096;
    }
  }

  private objectIndexForSerialized(predicate: string, object: string): ObjectIndexFields {
    return objectIndexFieldsFromSerialized(object, {
      predicate,
      predicateObjectDataTypes: this.options.predicateObjectDataTypes,
      textMaxBytes: this.options.textMaxBytes,
    });
  }

  private objectDigestForIndex(serialized: string, fields: ObjectIndexFields): string | null {
    return fields.objectKey === null ? digestObject(serialized) : null;
  }

  protected override resolveObjectDataTypeForPattern(pattern: QuintPattern): PredicateObjectDataType | undefined {
    const predicate = this.extractExactPredicate(pattern.predicate);
    if (predicate) {
      return getPredicateObjectDataType(predicate, this.options.predicateObjectDataTypes);
    }
    if (pattern.object && typeof pattern.object === 'object' && 'termType' in pattern.object) {
      return this.objectIndexForTerm(predicate, pattern.object as Term).objectKind;
    }
    return undefined;
  }

  protected override buildWhereClause(pattern: QuintPattern): { whereClause: string; params: any[] } {
    const conditions: string[] = [];
    const params: any[] = [];
    const predicate = this.extractExactPredicate(pattern.predicate);

    this.addTermConditions(conditions, params, 'graph', pattern.graph, false);
    this.addTermConditions(conditions, params, 'subject', pattern.subject, false);
    this.addTermConditions(conditions, params, 'predicate', pattern.predicate, false);
    if (pattern.object) {
      this.addObjectConditions(conditions, params, undefined, pattern.object, predicate);
    }

    return {
      whereClause: conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '',
      params,
    };
  }

  protected override addTermConditions(
    conditions: string[],
    params: any[],
    column: string,
    match: TermMatch | undefined,
    isObject: boolean,
  ): void {
    this.addConditions(conditions, params, column, match, isObject);
  }

  protected override addAliasedConditions(
    conditions: string[],
    params: any[],
    alias: string,
    pattern: QuintPattern,
  ): void {
    this.addTermConditions(conditions, params, `${alias}.graph`, pattern.graph, false);
    this.addTermConditions(conditions, params, `${alias}.subject`, pattern.subject, false);
    this.addTermConditions(conditions, params, `${alias}.predicate`, pattern.predicate, false);
    if (pattern.object) {
      this.addObjectConditions(
        conditions,
        params,
        alias,
        pattern.object,
        this.extractExactPredicate(pattern.predicate),
      );
    }
  }

  private addObjectConditions(
    conditions: string[],
    params: any[],
    alias: string | undefined,
    match: TermMatch,
    predicate: string | undefined,
  ): void {
    const column = (name: string) => alias ? `${alias}.${name}` : name;

    if (typeof match === 'object' && 'termType' in match) {
      this.addObjectExactCondition(conditions, params, column, match, predicate);
      return;
    }

    const ops = match as TermOperators;
    if (ops.$eq !== undefined) {
      this.addObjectExactValueCondition(conditions, params, column, ops.$eq, '$eq', predicate);
    }
    if (ops.$ne !== undefined) {
      this.addObjectExactValueCondition(conditions, params, column, ops.$ne, '$ne', predicate);
    }
    if (ops.$gt !== undefined) {
      this.addObjectComparableCondition(conditions, params, column, '>', ops.$gt, '$gt', predicate);
    }
    if (ops.$gte !== undefined) {
      this.addObjectComparableCondition(conditions, params, column, '>=', ops.$gte, '$gte', predicate);
    }
    if (ops.$lt !== undefined) {
      this.addObjectComparableCondition(conditions, params, column, '<', ops.$lt, '$lt', predicate);
    }
    if (ops.$lte !== undefined) {
      this.addObjectComparableCondition(conditions, params, column, '<=', ops.$lte, '$lte', predicate);
    }
    if (ops.$in !== undefined && ops.$in.length > 0) {
      const predicates = ops.$in.map((value) => this.objectPredicateForOperatorValue(value, '$in', predicate));
      const placeholders = predicates.map((item) => {
        if (item.fields.objectKey === null) {
          return `(${column('object_kind')} = ? AND ${column('object_digest')} = ? AND ${column('object')} = ?)`;
        }
        return `(${column('object_kind')} = ? AND ${column('object_key')} = ?)`;
      }).join(' OR ');
      conditions.push(`(${placeholders})`);
      for (const item of predicates) {
        if (item.fields.objectKey === null) {
          params.push(item.fields.objectKind, this.objectDigestForIndex(item.serialized, item.fields), item.serialized);
        } else {
          params.push(item.fields.objectKind, item.fields.objectKey);
        }
      }
    }
    if (ops.$notIn !== undefined && ops.$notIn.length > 0) {
      for (const value of ops.$notIn) {
        conditions.push(`${column('object')} != ?`);
        params.push(this.objectPredicateForOperatorValue(value, '$notIn', predicate).serialized);
      }
    }
    if (ops.$startsWith !== undefined) {
      const fields = this.objectFieldsForPrefix(ops.$startsWith, predicate);
      this.assertComparableObject(fields, '$startsWith');
      conditions.push(`${column('object_kind')} = ?`);
      params.push(fields.objectKind);
      conditions.push(`${column('object_key')} >= ? AND ${column('object_key')} < ?`);
      params.push(ops.$startsWith, ops.$startsWith + '\uffff');
    }
    if (ops.$endsWith !== undefined) {
      this.addObjectTextCondition(conditions, params, column, 'LIKE', `%${ops.$endsWith}`, predicate);
    }
    if (ops.$contains !== undefined) {
      this.addObjectTextCondition(conditions, params, column, 'LIKE', `%${ops.$contains}%`, predicate);
    }
    if (ops.$regex !== undefined) {
      this.addObjectTextCondition(conditions, params, column, 'GLOB', ops.$regex.replace(/\.\*/g, '*').replace(/\./g, '?'), predicate);
    }
    if (ops.$strStartsWith !== undefined) {
      this.addObjectLexicalStringCondition(conditions, params, column, 'startsWith', ops.$strStartsWith);
    }
    if (ops.$strEndsWith !== undefined) {
      this.addObjectLexicalStringCondition(conditions, params, column, 'endsWith', ops.$strEndsWith);
    }
    if (ops.$strContains !== undefined) {
      this.addObjectLexicalStringCondition(conditions, params, column, 'contains', ops.$strContains);
    }
    if (ops.$strRegex !== undefined) {
      this.addObjectLexicalStringCondition(conditions, params, column, 'regex', ops.$strRegex);
    }
    if (ops.$language !== undefined) {
      this.addObjectLanguageCondition(conditions, params, column, ops.$language);
    }
    if (ops.$isNull === true) {
      conditions.push(`${column('object')} IS NULL`);
    }
    if (ops.$isNull === false) {
      conditions.push(`${column('object')} IS NOT NULL`);
    }
  }

  private addObjectExactCondition(
    conditions: string[],
    params: any[],
    column: (name: string) => string,
    object: Term,
    predicate: string | undefined,
  ): void {
    const serialized = serializeObject(object);
    const fields = this.objectIndexForTerm(this.predicateForIndex(predicate), object);
    this.addObjectExactSerializedCondition(conditions, params, column, serialized, fields);
  }

  private addObjectExactValueCondition(
    conditions: string[],
    params: any[],
    column: (name: string) => string,
    value: OperatorValue,
    op: '$eq' | '$ne',
    predicate: string | undefined,
  ): void {
    const item = this.objectPredicateForOperatorValue(value, op, predicate);
    if (op === '$ne') {
      conditions.push(`${column('object')} != ?`);
      params.push(item.serialized);
      return;
    }
    this.addObjectExactSerializedCondition(conditions, params, column, item.serialized, item.fields);
  }

  private addObjectExactSerializedCondition(
    conditions: string[],
    params: any[],
    column: (name: string) => string,
    serialized: string,
    fields: ObjectIndexFields,
  ): void {
    if (fields.objectKey !== null) {
      conditions.push(`${column('object_kind')} = ?`);
      params.push(fields.objectKind);
      conditions.push(`${column('object_key')} = ?`);
      params.push(fields.objectKey);
      return;
    }

    conditions.push(`${column('object_kind')} = ?`);
    params.push(fields.objectKind);
    conditions.push(`${column('object_digest')} = ?`);
    params.push(this.objectDigestForIndex(serialized, fields));
    conditions.push(`${column('object')} = ?`);
    params.push(serialized);
  }

  private addObjectComparableCondition(
    conditions: string[],
    params: any[],
    column: (name: string) => string,
    sqlOperator: string,
    value: OperatorValue,
    op: string,
    predicate: string | undefined,
  ): void {
    const item = this.objectPredicateForOperatorValue(value, op, predicate);
    this.assertComparableObject(item.fields, op);
    conditions.push(`${column('object_kind')} = ?`);
    params.push(item.fields.objectKind);
    conditions.push(`${column('object_key')} ${sqlOperator} ?`);
    params.push(item.serialized);
  }

  private addObjectTextCondition(
    conditions: string[],
    params: any[],
    column: (name: string) => string,
    sqlOperator: string,
    value: string,
    predicate: string | undefined,
  ): void {
    const declaredType = getPredicateObjectDataType(predicate, this.options.predicateObjectDataTypes);
    if (declaredType) {
      if (!['text', 'longText', 'literal'].includes(declaredType)) {
        throw new Error(`Object text search is not supported for ${declaredType}`);
      }
      conditions.push(`${column('object_kind')} = ?`);
      params.push(declaredType);
    }
    conditions.push(`${column('object_text')} ${sqlOperator} ?`);
    params.push(value);
  }

  private addObjectLexicalStringCondition(
    conditions: string[],
    params: any[],
    column: (name: string) => string,
    op: 'startsWith' | 'endsWith' | 'contains' | 'regex',
    value: string,
  ): void {
    const lexical = this.objectLexicalSql(column);
    if (op === 'startsWith') {
      conditions.push(`(${lexical} >= ? AND ${lexical} < ?)`);
      params.push(value, value + '\uffff');
      return;
    }
    if (op === 'endsWith') {
      conditions.push(`${lexical} LIKE ?`);
      params.push(`%${value}`);
      return;
    }
    if (op === 'contains') {
      conditions.push(`${lexical} LIKE ?`);
      params.push(`%${value}%`);
      return;
    }
    conditions.push(`${lexical} GLOB ?`);
    params.push(value.replace(/\.\*/g, '*').replace(/\./g, '?'));
  }

  private addObjectLanguageCondition(
    conditions: string[],
    params: any[],
    column: (name: string) => string,
    lang: string,
  ): void {
    const languageLiteralKinds = `${column('object_kind')} IN ('text', 'longText', 'literal')`;
    if (lang === '*') {
      conditions.push(`(${languageLiteralKinds} AND lower(${column('object')}) LIKE ?)`);
      params.push('%"@%');
      return;
    }
    conditions.push(`(${languageLiteralKinds} AND (lower(${column('object')}) LIKE ? OR lower(${column('object')}) LIKE ?))`);
    params.push(`%"@${lang.toLowerCase()}`, `%"@${lang.toLowerCase()}-%`);
  }

  private objectLexicalSql(column: (name: string) => string): string {
    const object = column('object');
    return `CASE
      WHEN ${column('object_text')} IS NOT NULL THEN ${column('object_text')}
      WHEN ${column('object_kind')} IN ('iri', 'blankNode') THEN ${column('object_key')}
      WHEN ${column('object_kind')} = 'numeric' THEN substr(${object}, length('N${SEP}') + instr(substr(${object}, length('N${SEP}') + 1), '${SEP}') + instr(substr(${object}, length('N${SEP}') + instr(substr(${object}, length('N${SEP}') + 1), '${SEP}') + 1), '${SEP}') + 1)
      WHEN ${column('object_kind')} = 'dateTime' THEN substr(${object}, length('D${SEP}') + instr(substr(${object}, length('D${SEP}') + 1), '${SEP}') + 1)
      ELSE NULL
    END`;
  }

  private objectPredicateForOperatorValue(
    value: OperatorValue,
    op: string,
    predicate: string | undefined,
  ): { serialized: string; fields: ObjectIndexFields } {
    const serialized = this.serializeOpValue(value, true, op);
    return {
      serialized,
      fields: this.objectFieldsForOperatorValue(value, serialized, op, predicate),
    };
  }

  private objectFieldsForOperatorValue(
    value: OperatorValue,
    serialized: string,
    op: string,
    predicate: string | undefined,
  ): ObjectIndexFields {
    const declaredType = getPredicateObjectDataType(predicate, this.options.predicateObjectDataTypes);
    if (declaredType) {
      if (declaredType === 'longText') {
        return { objectKind: 'longText', objectKey: null, objectText: String(value) };
      }
      return { objectKind: declaredType, objectKey: serialized, objectText: null };
    }

    if (typeof value === 'number' && !['$eq', '$ne', '$in', '$notIn'].includes(op)) {
      return { objectKind: 'numeric', objectKey: serialized, objectText: null };
    }

    if (!['$eq', '$ne', '$in', '$notIn'].includes(op)) {
      if (isSerializedNumericLiteral(serialized)) {
        return { objectKind: 'numeric', objectKey: serialized, objectText: null };
      }
      if (isSerializedDateTimeLiteral(serialized)) {
        return { objectKind: 'dateTime', objectKey: serialized, objectText: null };
      }
    }

    return this.objectIndexForSerialized(predicate ?? '', serialized);
  }

  private objectIndexForTerm(predicate: string | undefined, object: Term): ObjectIndexFields {
    return objectIndexFieldsFromTerm(object, {
      predicate,
      predicateObjectDataTypes: this.options.predicateObjectDataTypes,
      textMaxBytes: this.options.textMaxBytes,
    });
  }

  private objectFieldsForPrefix(prefix: string, predicate: string | undefined): ObjectIndexFields {
    const declaredType = getPredicateObjectDataType(predicate, this.options.predicateObjectDataTypes);
    if (declaredType) {
      if (declaredType === 'longText') {
        return { objectKind: 'longText', objectKey: null, objectText: prefix };
      }
      return { objectKind: declaredType, objectKey: prefix, objectText: null };
    }
    if (isSerializedNumericLiteral(prefix)) {
      return { objectKind: 'numeric', objectKey: prefix, objectText: null };
    }
    if (isSerializedDateTimeLiteral(prefix)) {
      return { objectKind: 'dateTime', objectKey: prefix, objectText: null };
    }
    if (prefix.startsWith('"')) {
      return { objectKind: 'text', objectKey: prefix, objectText: null };
    }
    if (prefix.startsWith('_:')) {
      return { objectKind: 'blankNode', objectKey: prefix, objectText: null };
    }
    return { objectKind: 'iri', objectKey: prefix, objectText: null };
  }

  private assertComparableObject(fields: ObjectIndexFields, op: string): void {
    if (fields.objectKey !== null && fields.objectKind !== 'longText') {
      return;
    }
    throw new Error(`Object ${op} is not supported for ${fields.objectKind}; declare/use a comparable data type instead of longText`);
  }

  private predicateForIndex(predicate: string | undefined): string | undefined {
    return predicate;
  }

  override async put(quint: Quint): Promise<void> {
    this.ensureOpen();

    const row = this.quintToRow(quint);
    const statement = this.writeStatementForRow(row);
    await this.executor!.execute(statement.sql, statement.params);
  }

  override async multiPut(quintList: Quint[]): Promise<void> {
    this.ensureOpen();

    if (quintList.length === 0) return;

    const statements = quintList.map(quint => this.writeStatementForRow(this.quintToRow(quint)));
    await this.executor!.executeInTransaction(statements);
  }

  private writeStatementForRow(row: SqliteIndexedQuintRow): { sql: string; params?: any[] } {
    const params = [
      row.objectKind,
      row.objectKey,
      row.objectText,
      row.objectDigest,
      row.graph,
      row.subject,
      row.predicate,
      row.object,
      row.vector,
    ];

    if (row.objectKey !== null) {
      return {
        sql: `
          INSERT INTO quints (
            object_kind, object_key, object_text, object_digest,
            graph, subject, predicate, object, vector
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (graph, subject, predicate, object_kind, object_key)
            WHERE object_key IS NOT NULL
          DO UPDATE SET
            vector = excluded.vector,
            object_text = excluded.object_text,
            object_digest = excluded.object_digest
          WHERE quints.object = excluded.object
        `,
        params,
      };
    }

    return {
      sql: `
        INSERT INTO quints (
          object_kind, object_key, object_text, object_digest,
          graph, subject, predicate, object, vector
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (graph, subject, predicate, object_kind, object_digest)
          WHERE object_digest IS NOT NULL
        DO UPDATE SET
          vector = excluded.vector,
          object_text = excluded.object_text
        WHERE quints.object = excluded.object
      `,
      params,
    };
  }

  protected override quintToRow(quint: Quint): SqliteIndexedQuintRow {
    const predicate = termToId(quint.predicate as any);
    const object = serializeObject(quint.object as any);
    const objectIndex = this.objectIndexForTerm(predicate, quint.object as Term);
    return {
      graph: termToId(quint.graph as any),
      subject: termToId(quint.subject as any),
      predicate,
      object,
      vector: quint.vector ? JSON.stringify(quint.vector) : null,
      objectKind: objectIndex.objectKind,
      objectKey: objectIndex.objectKey,
      objectText: objectIndex.objectText,
      objectDigest: this.objectDigestForIndex(object, objectIndex),
    };
  }

  protected override rowToQuint(row: QuintRow): Quint {
    const quad = rowToQuad(row);
    const quint: Quint = quad as Quint;
    if (row.vector) {
      quint.vector = parseVector(row.vector);
    }
    return quint;
  }
}

function sumStoreSpaceObjects(objects: StoreSpaceObject[], kind: StoreSpaceObject['kind']): number {
  return objects
    .filter((object) => object.kind === kind)
    .reduce((sum, object) => sum + object.bytes, 0);
}

function quintSpaceObjectKind(name: string, schemaType?: string, tableName?: string): StoreSpaceObject['kind'] {
  if (schemaType === 'table' && name === 'quints') {
    return 'table';
  }
  if (schemaType === 'index' && (name.startsWith('idx_') || tableName === 'quints')) {
    return 'index';
  }
  if (name.startsWith('sqlite_')) {
    return 'internal';
  }
  return 'unknown';
}
