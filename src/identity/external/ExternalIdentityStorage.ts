import { createHash, randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { BadRequestHttpError, NotFoundHttpError, type IndexedStorage } from '@solid/community-server';
import { executePostgresLockedStatements, executeQuery, executeStatement, getIdentityDatabase,
  isDatabaseSqlite, lockIdentityAccount, withIdentityTransaction } from '../drizzle/db';

export const EXTERNAL_LOGIN_TYPE = 'external-login';
export const EXTERNAL_LOGIN_DESCRIPTION = {
  accountId: 'id:account', provider: 'string', namespace: 'string', subject: 'string', unionId: 'string?',
  createdAt: 'number', updatedAt: 'number',
} as const;
export interface ExternalIdentityRow {
  id: string; accountId: string; provider: string; namespace: string; subject: string; unionId?: string;
  createdAt: number; updatedAt: number;
}
const columns: Record<string, string> = {
  id: 'id', accountId: 'account_id', provider: 'provider', namespace: 'namespace', subject: 'subject',
  unionId: 'union_id', createdAt: 'created_at', updatedAt: 'updated_at',
};
const identityKeys = ['accountId', 'provider', 'namespace', 'subject'] as const;

/** CSS IndexedStorage adapter. External identities have exactly one authoritative SQL row. */
export class ExternalIdentityStorage implements IndexedStorage<any> {
  private readonly db;
  private ready?: Promise<void>;
  private migration?: Promise<void>;
  public constructor(private readonly source: IndexedStorage<any>, connectionString: string) {
    this.db = getIdentityDatabase(connectionString);
  }

  public initialize(): Promise<void> {
    return this.ready ??= this.initializeStorage();
  }

  private async initializeStorage(): Promise<void> {
    await this.source.defineType(EXTERNAL_LOGIN_TYPE, EXTERNAL_LOGIN_DESCRIPTION);
    const time = isDatabaseSqlite(this.db) ? 'INTEGER' : 'TIMESTAMPTZ';
    const ddl = [
      `CREATE TABLE IF NOT EXISTS identity_external_identities (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL CHECK (account_id <> ''),
        provider TEXT NOT NULL CHECK (provider <> ''), namespace TEXT NOT NULL CHECK (namespace <> ''),
        subject TEXT NOT NULL CHECK (subject <> ''), union_id TEXT,
        created_at ${time} NOT NULL, updated_at ${time} NOT NULL,
        CONSTRAINT identity_external_identities_subject_idx UNIQUE (provider, namespace, subject))`,
      'CREATE INDEX IF NOT EXISTS identity_external_identities_account_idx ON identity_external_identities (account_id)',
      'CREATE TABLE IF NOT EXISTS identity_external_identity_migration (version TEXT PRIMARY KEY, migrated_at BIGINT NOT NULL)',
    ];
    await executePostgresLockedStatements(this.db, 1_936_528_503, ddl);
  }

  /** Delay legacy reads until CSS has finished declaring all of its storage types. */
  public prepare(): Promise<void> {
    return this.migration ??= this.initialize().then(() => this.migrateLegacy());
  }

  private async legacyIndexExists(): Promise<boolean> {
    const result = isDatabaseSqlite(this.db)
      ? await executeQuery(this.db, sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'identity_external_login_index'`)
      : await executeQuery(this.db, sql`SELECT to_regclass('identity_external_login_index') AS name`);
    return Boolean(result.rows[0]?.name);
  }

  /** Run only with old workers stopped. A committed marker makes interrupted file cleanup resumable. */
  private async migrateLegacy(): Promise<void> {
    const legacy = await withIdentityTransaction(this.db, async () => {
      await lockIdentityAccount(this.db, 'external-identity-migration-v1');
      const rows: ExternalIdentityRow[] = [];
      for await (const row of this.source.entries(EXTERNAL_LOGIN_TYPE)) rows.push(row as unknown as ExternalIdentityRow);
      const migrated = (await executeQuery(this.db, sql`SELECT version FROM identity_external_identity_migration WHERE version = 'v1'`)).rows.length > 0;
      const hasIndex = await this.legacyIndexExists();
      const index = hasIndex ? (await executeQuery(this.db, sql`SELECT subject, login_id, lease_until FROM identity_external_login_index`)).rows : [];
      if (!migrated) {
        const migratedAt = Math.floor(Date.now() / 1000);
        const byId = new Map(rows.map(row => [row.id, row]));
        for (const entry of index) {
          if (Number(entry.lease_until) > 0) {
            if (Number(entry.lease_until) > Date.now()) throw new Error('EXTERNAL_IDENTITY_MIGRATION_BUSY: drain old login workers first');
            continue;
          }
          const row = byId.get(String(entry.login_id));
          if (!row || this.digest(row) !== entry.subject) throw new Error('EXTERNAL_IDENTITY_MIGRATION_INVALID_INDEX');
        }
        for (const row of rows) {
          this.validate({ ...row });
          if (!await this.source.has('account', row.accountId)
            || !index.some(entry => entry.login_id === row.id && entry.subject === this.digest(row) && Number(entry.lease_until) === 0)) {
            throw new Error('EXTERNAL_IDENTITY_MIGRATION_INVALID_BINDING');
          }
          await this.insert(row.id, row, migratedAt);
        }
        await executeStatement(this.db, sql`INSERT INTO identity_external_identity_migration (version, migrated_at) VALUES ('v1', ${Date.now()})`);
      } else {
        for (const row of rows) {
          const target = await this.select({ id: row.id });
          if (!target[0] || identityKeys.some(key => target[0][key] !== row[key]) || target[0].unionId !== row.unionId) {
            throw new Error('EXTERNAL_IDENTITY_MIGRATION_LEGACY_WRITER: stop old workers before upgrade');
          }
        }
        if (index.length) throw new Error('EXTERNAL_IDENTITY_MIGRATION_LEGACY_WRITER: old index recreated after migration');
      }
      if (hasIndex) await executeStatement(this.db, sql`DROP TABLE identity_external_login_index`);
      return rows;
    });
    // File-backed CSS stores cannot share a SQL transaction. The committed marker
    // makes these old rows cleanup-only; no runtime query ever falls back to them.
    for (const row of legacy) await this.source.delete(EXTERNAL_LOGIN_TYPE, row.id);
  }

  private digest(row: ExternalIdentityRow): string {
    return createHash('sha256').update(JSON.stringify([row.provider, row.namespace, row.subject])).digest('hex');
  }

  private validate(value: Record<string, unknown>): void {
    if (identityKeys.some(key => typeof value[key] !== 'string' || !(value[key] as string).length)
      || (value.unionId !== undefined && typeof value.unionId !== 'string')
      || Object.keys(value).some(key => !Object.prototype.hasOwnProperty.call(columns, key))) throw new BadRequestHttpError('INVALID_EXTERNAL_IDENTITY');
  }

  private time(value: number): SQL {
    return isDatabaseSqlite(this.db) ? sql`${value}` : sql`to_timestamp(${value})`;
  }

  private async insert(id: string, value: Pick<ExternalIdentityRow, 'accountId' | 'provider' | 'namespace' | 'subject' | 'unionId'>,
    now = Math.floor(Date.now() / 1000)): Promise<void> {
    await executeStatement(this.db, sql`INSERT INTO identity_external_identities
      (id, account_id, provider, namespace, subject, union_id, created_at, updated_at)
      VALUES (${id}, ${value.accountId}, ${value.provider}, ${value.namespace}, ${value.subject}, ${value.unionId ?? null}, ${this.time(now)}, ${this.time(now)})`);
  }

  private async select(query: Record<string, unknown>): Promise<ExternalIdentityRow[]> {
    const where: SQL[] = [];
    for (const [key, value] of Object.entries(query)) {
      if (!Object.prototype.hasOwnProperty.call(columns, key)) return [];
      // Nested account queries are resolved using the existing CSS account store.
      if (key === 'accountId' && value && typeof value === 'object') {
        const ids = await this.source.findIds('account', value);
        if (!ids.length) return [];
        where.push(sql`account_id IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})`);
      } else if (value === undefined) {
        if (key !== 'unionId') return [];
        where.push(sql`union_id IS NULL`);
      } else {
        if (typeof value !== 'string' && typeof value !== 'number') return [];
        const column = sql.identifier(columns[key]);
        where.push(sql`${column} = ${key === 'createdAt' || key === 'updatedAt' ? this.time(Number(value)) : sql`${value}`}`);
      }
    }
    const result = await executeQuery(this.db, sql`SELECT * FROM identity_external_identities
      ${where.length ? sql`WHERE ${sql.join(where, sql` AND `)}` : sql``}`);
    return result.rows.map(row => ({
      id: String(row.id), accountId: String(row.account_id), provider: String(row.provider),
      namespace: String(row.namespace), subject: String(row.subject),
      ...(row.union_id === null ? {} : { unionId: String(row.union_id) }),
      createdAt: this.parseTime(row.created_at), updatedAt: this.parseTime(row.updated_at),
    }));
  }

  private parseTime(value: unknown): number {
    return isDatabaseSqlite(this.db) ? Number(value) : Math.floor(new Date(value as string).getTime() / 1000);
  }

  public async defineType(type: string, description: any): Promise<void> {
    if (type !== EXTERNAL_LOGIN_TYPE) await this.source.defineType(type, description);
    await this.initialize();
  }
  public async createIndex(type: string, key: string): Promise<void> {
    await this.initialize();
    if (type !== EXTERNAL_LOGIN_TYPE) return this.source.createIndex(type, key);
    if (!Object.prototype.hasOwnProperty.call(columns, key)) throw new BadRequestHttpError('INVALID_EXTERNAL_IDENTITY_FIELD');
    await executePostgresLockedStatements(this.db, 1_936_528_503, [
      `CREATE INDEX IF NOT EXISTS identity_external_identities_${columns[key]}_idx ON identity_external_identities (${columns[key]})`,
    ]);
  }
  public async create(type: string, value: any): Promise<any> {
    await this.prepare();
    if (type !== EXTERNAL_LOGIN_TYPE) return this.source.create(type, value);
    const { id: _id, createdAt: _created, updatedAt: _updated, ...fields } = value;
    this.validate(fields);
    const id = randomUUID();
    try { await this.insert(id, fields); } catch (error) {
      const cause = (error as { cause?: unknown }).cause ?? error;
      if ((cause as { code?: string }).code === '23505'
        || /UNIQUE constraint failed: identity_external_identities/u.test(String((cause as Error).message))) {
        throw new BadRequestHttpError('EXTERNAL_IDENTITY_ALREADY_BOUND');
      }
      throw error;
    }
    return (await this.select({ id }))[0];
  }
  public async has(type: string, id: string): Promise<boolean> { return Boolean(await this.get(type, id)); }
  public async get(type: string, id: string): Promise<any> {
    await this.prepare();
    return type === EXTERNAL_LOGIN_TYPE ? (await this.select({ id }))[0] : this.source.get(type, id);
  }
  public async find(type: string, query: any): Promise<any[]> {
    await this.prepare();
    return type === EXTERNAL_LOGIN_TYPE ? this.select(query ?? {}) : this.source.find(type, query);
  }
  public async findIds(type: string, query: any): Promise<string[]> { return (await this.find(type, query)).map(row => row.id); }
  public async set(type: string, value: any): Promise<void> {
    await this.prepare();
    if (type !== EXTERNAL_LOGIN_TYPE) return this.source.set(type, value);
    this.validate(value);
    const original = (await this.select({ id: value.id }))[0];
    if (!original) throw new NotFoundHttpError('EXTERNAL_IDENTITY_NOT_FOUND');
    if (identityKeys.some(key => original[key] !== value[key])) throw new BadRequestHttpError('EXTERNAL_IDENTITY_IMMUTABLE');
    await executeStatement(this.db, sql`UPDATE identity_external_identities SET union_id = ${value.unionId ?? null},
      updated_at = ${this.time(Math.floor(Date.now() / 1000))} WHERE id = ${value.id}
      AND ${value.unionId === undefined ? sql`union_id IS NOT NULL` : sql`(union_id IS NULL OR union_id <> ${value.unionId})`}`);
  }
  public async setField(type: string, id: string, key: string, value: any): Promise<void> {
    await this.prepare();
    if (type !== EXTERNAL_LOGIN_TYPE) return this.source.setField(type, id, key, value);
    if (key !== 'unionId') throw new BadRequestHttpError('EXTERNAL_IDENTITY_IMMUTABLE');
    const original = await this.get(type, id);
    if (!original) throw new NotFoundHttpError('EXTERNAL_IDENTITY_NOT_FOUND');
    await this.set(type, { ...original, [key]: value });
  }
  public async delete(type: string, id: string): Promise<void> {
    await this.prepare();
    if (type === EXTERNAL_LOGIN_TYPE) {
      await executeStatement(this.db, sql`DELETE FROM identity_external_identities WHERE id = ${id}`);
    } else {
      await this.source.delete(type, id);
      if (type === 'account') await executeStatement(this.db, sql`DELETE FROM identity_external_identities WHERE account_id = ${id}`);
    }
  }
  public async *entries(type: string): AsyncIterableIterator<any> {
    await this.prepare();
    if (type === EXTERNAL_LOGIN_TYPE) { for (const row of await this.find(type, {})) yield row; }
    else yield* this.source.entries(type);
  }
}
