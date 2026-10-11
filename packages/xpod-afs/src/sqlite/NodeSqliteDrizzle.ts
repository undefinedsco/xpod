import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { entityKind } from 'drizzle-orm/entity';
import { DefaultLogger, NoopLogger } from 'drizzle-orm/logger';
import { createTableRelationsHelpers, extractTablesRelationalConfig } from 'drizzle-orm/relations';
import {
  BaseSQLiteDatabase,
  SQLitePreparedQuery as PreparedQueryBase,
  SQLiteSession,
  SQLiteSyncDialect,
  SQLiteTransaction,
} from 'drizzle-orm/sqlite-core';
import { fillPlaceholders, sql } from 'drizzle-orm/sql/sql';

const { mapResultRow } = require('drizzle-orm/utils') as {
  mapResultRow: (fields: any, row: any, joinsNotNullableMap: any) => any;
};

type NodeSqliteDrizzleConfig = Record<string, any>;

type NodeSqliteClientConfig = {
  source: string;
} & Record<string, any>;

function getDatabaseSyncCtor(): typeof DatabaseSync {
  return require('node:sqlite').DatabaseSync as typeof DatabaseSync;
}

function looksLikeDatabaseClient(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }

  return typeof (value as DatabaseSync).prepare === 'function';
}

function isDrizzleConfig(value: unknown): boolean {
  if (!value || typeof value !== 'object' || looksLikeDatabaseClient(value)) {
    return false;
  }

  return 'connection' in value
    || 'client' in value
    || 'schema' in value
    || 'logger' in value
    || 'casing' in value;
}

class NodeSqliteDatabase extends BaseSQLiteDatabase<'sync', any, Record<string, never>> {
  public static override readonly [entityKind] = 'NodeSqliteDatabase';

  public declare $client: DatabaseSync;
}

class NodeSqliteSession extends SQLiteSession<'sync', any, Record<string, unknown>, any> {
  public static override readonly [entityKind] = 'NodeSqliteSession';

  private readonly logger;

  public constructor(
    private readonly client: DatabaseSync,
    dialect: SQLiteSyncDialect,
    private readonly schema: any,
    options: { logger?: any } = {},
  ) {
    super(dialect);
    this.logger = options.logger ?? new NoopLogger();
  }

  public override prepareQuery(
    query: any,
    fields: any,
    executeMethod: any,
    isResponseInArrayMode: boolean,
    customResultMapper?: (rows: unknown[][]) => unknown,
  ): NodeSqlitePreparedQuery {
    const objectStatement = this.client.prepare(query.sql);
    const arrayStatement = this.client.prepare(query.sql);
    const supportsReturnArrays = typeof (arrayStatement as StatementSync & { setReturnArrays?: (enabled: boolean) => unknown }).setReturnArrays === 'function';
    if (supportsReturnArrays) {
      (arrayStatement as StatementSync & { setReturnArrays: (enabled: boolean) => unknown }).setReturnArrays(true);
    }
    return new NodeSqlitePreparedQuery(
      objectStatement,
      arrayStatement,
      query,
      this.logger,
      fields,
      executeMethod,
      isResponseInArrayMode,
      supportsReturnArrays,
      customResultMapper,
    );
  }

  public override transaction<T>(transaction: (tx: any) => T, config: { behavior?: 'deferred' | 'immediate' | 'exclusive' } = {}): T {
    const tx = new NodeSqliteTransaction('sync', (this as any).dialect, this, this.schema);
    const behavior = config.behavior ?? 'deferred';
    const beginSql = behavior === 'immediate'
      ? 'begin immediate'
      : behavior === 'exclusive'
        ? 'begin exclusive'
        : 'begin';
    this.run(sql.raw(beginSql));
    try {
      const result = transaction(tx);
      this.run(sql.raw('commit'));
      return result;
    } catch (error) {
      this.run(sql.raw('rollback'));
      throw error;
    }
  }
}

class NodeSqliteTransaction extends SQLiteTransaction<'sync', any, Record<string, unknown>, any> {
  public static override readonly [entityKind] = 'NodeSqliteTransaction';

  public override transaction<T>(transaction: (tx: NodeSqliteTransaction) => T): T {
    const savepointName = `sp${(this as any).nestedIndex}`;
    const tx = new NodeSqliteTransaction('sync', (this as any).dialect, (this as any).session, (this as any).schema, (this as any).nestedIndex + 1);
    (this as any).session.run(sql.raw(`savepoint ${savepointName}`));
    try {
      const result = transaction(tx);
      (this as any).session.run(sql.raw(`release savepoint ${savepointName}`));
      return result;
    } catch (error) {
      (this as any).session.run(sql.raw(`rollback to savepoint ${savepointName}`));
      throw error;
    }
  }
}

class NodeSqlitePreparedQuery extends PreparedQueryBase<{
  type: 'sync';
  run: any;
  all: any;
  get: any;
  values: any;
  execute: any;
}> {
  public static override readonly [entityKind] = 'NodeSqlitePreparedQuery';

  public constructor(
    private readonly objectStatement: StatementSync,
    private readonly arrayStatement: StatementSync,
    query: any,
    private readonly logger: any,
    private readonly fields: any,
    executeMethod: any,
    private readonly _isResponseInArrayMode: boolean,
    private readonly supportsReturnArrays: boolean,
    private readonly customResultMapper?: (rows: unknown[][]) => unknown,
  ) {
    super('sync', executeMethod, query);
  }

  public override run(placeholderValues?: Record<string, unknown>): any {
    const params = fillPlaceholders(this.query.params, placeholderValues ?? {}) as any[];
    this.logger.logQuery(this.query.sql, params);
    return this.objectStatement.run(...params);
  }

  public override all(placeholderValues?: Record<string, unknown>): any {
    const { fields, query, logger, objectStatement, customResultMapper } = this;
    const joinsNotNullableMap = (this as any).joinsNotNullableMap;
    if (!fields && !customResultMapper) {
      const params = fillPlaceholders(query.params, placeholderValues ?? {}) as any[];
      logger.logQuery(query.sql, params);
      return objectStatement.all(...params);
    }
    const rows = this.values(placeholderValues);
    if (customResultMapper) {
      return customResultMapper(rows);
    }
    return rows.map((row) => mapResultRow(fields, row, joinsNotNullableMap));
  }

  public override get(placeholderValues?: Record<string, unknown>): any {
    const params = fillPlaceholders(this.query.params, placeholderValues ?? {}) as any[];
    this.logger.logQuery(this.query.sql, params);
    const { fields, customResultMapper, objectStatement, arrayStatement } = this;
    const joinsNotNullableMap = (this as any).joinsNotNullableMap;
    if (!fields && !customResultMapper) {
      return objectStatement.get(...params);
    }
    const row = this.toArrayRow(arrayStatement.get(...params));
    if (!row) {
      return undefined;
    }
    if (customResultMapper) {
      return customResultMapper([ row ]);
    }
    return mapResultRow(fields, row, joinsNotNullableMap);
  }

  public override values(placeholderValues?: Record<string, unknown>): unknown[][] {
    const params = fillPlaceholders(this.query.params, placeholderValues ?? {}) as any[];
    this.logger.logQuery(this.query.sql, params);
    const rows = this.arrayStatement.all(...params) as unknown[];
    return rows.map((row) => this.toArrayRow(row) ?? []);
  }

  public isResponseInArrayMode(): boolean {
    return this._isResponseInArrayMode;
  }

  private toArrayRow(row: unknown): unknown[] | undefined {
    if (row === undefined) {
      return undefined;
    }
    if (this.supportsReturnArrays) {
      return row as unknown[];
    }
    return Object.values(row as Record<string, unknown>);
  }
}

function constructNodeSqliteDb(client: DatabaseSync, config: NodeSqliteDrizzleConfig = {}): any {
  const dialect = new SQLiteSyncDialect();
  const logger = config.logger === true
    ? new DefaultLogger()
    : config.logger === false
      ? undefined
      : config.logger;

  let schema: any;
  if (config.schema) {
    const tablesConfig = extractTablesRelationalConfig(config.schema, createTableRelationsHelpers);
    schema = {
      fullSchema: config.schema,
      schema: tablesConfig.tables,
      tableNamesMap: tablesConfig.tableNamesMap,
    };
  }

  const session = new NodeSqliteSession(client, dialect, schema, { logger });
  const db = new NodeSqliteDatabase('sync', dialect, session, schema) as NodeSqliteDatabase;
  db.$client = client;
  return db;
}

export function drizzleNodeSqlite(...params: any[]): any {
  const DatabaseCtor = getDatabaseSyncCtor();

  if (params[0] === undefined || typeof params[0] === 'string') {
    const instance = new DatabaseCtor(params[0] ?? ':memory:');
    return constructNodeSqliteDb(instance, params[1]);
  }

  if (isDrizzleConfig(params[0])) {
    const { connection, client, ...drizzleConfig } = params[0];
    if (client) {
      return constructNodeSqliteDb(client, drizzleConfig);
    }
    if (connection && typeof connection === 'object') {
      const { source, ...rest } = connection as NodeSqliteClientConfig;
      const options = Object.values(rest).some((value) => value !== undefined) ? rest : undefined;
      const instance = new DatabaseCtor(source, options);
      return constructNodeSqliteDb(instance, drizzleConfig);
    }
    const instance = new DatabaseCtor(connection);
    return constructNodeSqliteDb(instance, drizzleConfig);
  }

  return constructNodeSqliteDb(params[0], params[1]);
}
