import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { getLoggerFor } from 'global-logger-factory';
import type { IdentityDatabase } from './db';
import { executeQuery, executeStatement, isDatabaseSqlite } from './db';

const ACCOUNT_DATA_DIR = path.resolve('.internal', 'accounts', 'data');

export interface AccountRoleContext {
  accountId: string;
  webId?: string;
  roles: string[];
}

function resolveWebIds(payload: Record<string, unknown>): string[] {
  const candidates = new Set<string>();
  const possibleKeys = [ 'webId', 'webid', 'primaryWebId', 'primary_webid' ];
  for (const key of possibleKeys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      candidates.add(value.trim());
    }
  }
  const settings = payload.settings;
  if (settings && typeof settings === 'object') {
    const webId = (settings as Record<string, unknown>).webId;
    if (typeof webId === 'string' && webId.trim().length > 0) {
      candidates.add(webId.trim());
    }
  }
  const pods = payload.pods;
  if (Array.isArray(pods)) {
    for (const entry of pods) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const webId = (entry as Record<string, unknown>).webId;
      if (typeof webId === 'string' && webId.trim().length > 0) {
        candidates.add(webId.trim());
      }
    }
  }
  return [ ...candidates ];
}

export class AccountRoleRepository {
  private readonly ready: Promise<void>;
  private readonly logger = getLoggerFor(this);

  public constructor(private readonly db: IdentityDatabase) {
    this.ready = this.ensureSchema();
  }

  public async findByAccountId(accountId: string): Promise<AccountRoleContext | undefined> {
    await this.ready;
    const payload = await this.getAccountPayloadById(accountId);
    if (!payload) {
      const rolesFallback = await this.fetchRoles(accountId);
      if (rolesFallback.length === 0) {
        return undefined;
      }
      return { accountId, roles: rolesFallback };
    }
    const [ webId ] = resolveWebIds(payload);
    const roles = await this.fetchRoles(accountId);
    return { accountId, webId, roles };
  }

  public async findByWebId(webId: string): Promise<AccountRoleContext | undefined> {
    await this.ready;
    const accounts = await this.loadAllAccounts();
    for (const { id, payload } of accounts) {
      const knownWebIds = resolveWebIds(payload);
      if (knownWebIds.includes(webId)) {
        const roles = await this.fetchRoles(id);
        return {
          accountId: id,
          webId,
          roles,
        };
      }
    }
    return undefined;
  }

  public async findByWebIdLoose(webId: string): Promise<AccountRoleContext | undefined> {
    return this.findByWebId(webId);
  }

  public async addRoles(accountId: string, roles: string[]): Promise<void> {
    await this.ready;
    const unique = Array.from(new Set(
      roles.map((role) => role.trim()).filter((role) => role.length > 0),
    ));
    if (unique.length === 0) {
      return;
    }
    for (const role of unique) {
      await executeStatement(this.db, sql`
        INSERT INTO identity_account_role (account_id, role)
        VALUES (${accountId}, ${role})
        ON CONFLICT (account_id, role) DO NOTHING
      `);
    }
  }

  private async ensureSchema(): Promise<void> {
    try {
      if (isDatabaseSqlite(this.db)) {
        // SQLite syntax
        await executeStatement(this.db, sql`
          CREATE TABLE IF NOT EXISTS identity_account_role (
            account_id TEXT NOT NULL,
            role TEXT NOT NULL,
            created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
            PRIMARY KEY (account_id, role)
          )
        `);
      } else {
        // PostgreSQL syntax
        await executeStatement(this.db, sql`
          CREATE TABLE IF NOT EXISTS identity_account_role (
            account_id TEXT NOT NULL,
            role TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (account_id, role)
          )
        `);
      }
    } catch (error: unknown) {
      if (!this.isDuplicateDefinitionError(error)) {
        throw error;
      }
      this.logger.debug('identity_account_role schema already present, skipping creation.');
    }
  }

  private async fetchRoles(accountId: string): Promise<string[]> {
    const result = await executeQuery<{ role?: unknown }>(this.db, sql`
      SELECT role
      FROM identity_account_role
      WHERE account_id = ${accountId}
    `);
    return result.rows.map((row) => {
      const value = typeof row.role === 'string' ? row.role.trim() : '';
      return value;
    }).filter((value) => value.length > 0);
  }

  private async getAccountPayloadById(accountId: string): Promise<Record<string, unknown> | undefined> {
    try {
      const accountResult = await executeQuery<{ payload?: unknown }>(this.db, sql`
        SELECT payload
        FROM identity_account
        WHERE id = ${accountId}
        LIMIT 1
      `);
      if (accountResult.rows.length > 0) {
        const payload = accountResult.rows[0]?.payload;
        if (payload && typeof payload === 'object') {
          return payload as Record<string, unknown>;
        }
      }
    } catch (error: unknown) {
      if (!this.isTableMissing(error)) {
        throw error;
      }
    }
    const files = await this.loadFileAccountMap();
    return files.get(accountId);
  }

  private async loadAllAccounts(): Promise<Array<{ id: string; payload: Record<string, unknown> }>> {
    try {
      const result = await executeQuery<{ id: string; payload: unknown }>(this.db, sql`SELECT id, payload FROM identity_account`);
      return result.rows.map((row) => ({
        id: row.id,
        payload: (row.payload ?? {}) as Record<string, unknown>,
      }));
    } catch (error: unknown) {
      if (!this.isTableMissing(error)) {
        throw error;
      }
    }
    const files = await this.loadFileAccountMap();
    return Array.from(files.entries()).map(([ id, payload ]) => ({ id, payload }));
  }

  private async loadFileAccountMap(): Promise<Map<string, Record<string, unknown>>> {
    const map = new Map<string, Record<string, unknown>>();
    try {
      const files = await fs.readdir(ACCOUNT_DATA_DIR);
      for (const file of files) {
        if (!file.endsWith('.json')) {
          continue;
        }
        const fullPath = path.join(ACCOUNT_DATA_DIR, file);
        try {
          const raw = await fs.readFile(fullPath, 'utf8');
          const parsed = JSON.parse(raw) as { payload?: unknown };
          const payload = parsed?.payload;
          if (!payload || typeof payload !== 'object') {
            continue;
          }
          const accountId = (payload as Record<string, unknown>).id;
          if (typeof accountId === 'string' && accountId.trim().length > 0) {
            map.set(accountId, payload as Record<string, unknown>);
          }
        } catch (error: unknown) {
          this.logger.debug(`Skipping account file ${fullPath}: ${(error as Error).message}`);
        }
      }
    } catch (error: unknown) {
      this.logger.debug(`Account data directory unavailable (${ACCOUNT_DATA_DIR}): ${(error as Error).message}`);
    }
    return map;
  }

  private isTableMissing(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }
    const code = (error as { code?: string }).code;
    if (code === '42P01') {
      return true;
    }
    const message = (error as { message?: string }).message ?? '';
    return /does not exist/u.test(message);
  }

  private isDuplicateDefinitionError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }
    const code = (error as { code?: string }).code;
    if (code && [ '23505', '42P07', '42710' ].includes(code)) {
      return true;
    }
    const message = (error as { message?: string }).message ?? '';
    return /already exists/u.test(message);
  }
}
