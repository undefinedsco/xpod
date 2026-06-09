import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { getLoggerFor } from 'global-logger-factory';
import type { IdentityDatabase } from './db';
import { executeQuery, executeStatement, isDatabaseSqlite } from './db';

const ACCOUNT_DATA_DIR = path.resolve('.internal', 'accounts', 'data');
const IDENTITY_STORE_TABLE = 'identity_store';
const INTERNAL_KV_TABLE = 'internal_kv';

export interface AccountRoleContext {
  accountId: string;
  webId?: string;
  roles: string[];
}

interface AccountPayloadRecord {
  id: string;
  payload: Record<string, unknown>;
  source: 'identity-store' | 'internal-kv' | 'file';
  key?: string;
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

  const webIdLink = payload['**webIdLink**'] ?? payload.webIdLink;
  if (webIdLink && typeof webIdLink === 'object') {
    for (const entry of Object.values(webIdLink as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const webId = (entry as Record<string, unknown>).webId;
      if (typeof webId === 'string' && webId.trim().length > 0) {
        candidates.add(webId.trim());
      }
    }
  }

  const podMap = payload['**pod**'] ?? payload.pod;
  if (podMap && typeof podMap === 'object') {
    for (const pod of Object.values(podMap as Record<string, unknown>)) {
      if (!pod || typeof pod !== 'object') {
        continue;
      }
      const owner = (pod as Record<string, unknown>)['**owner**'] ?? (pod as Record<string, unknown>).owner;
      if (!owner || typeof owner !== 'object') {
        continue;
      }
      for (const entry of Object.values(owner as Record<string, unknown>)) {
        if (!entry || typeof entry !== 'object') {
          continue;
        }
        const webId = (entry as Record<string, unknown>).webId;
        if (typeof webId === 'string' && webId.trim().length > 0) {
          candidates.add(webId.trim());
        }
      }
    }
  }

  return Array.from(candidates);
}

function resolveRoles(payload: Record<string, unknown>): string[] {
  const roles = payload.roles;
  if (!Array.isArray(roles)) {
    return [];
  }
  return Array.from(new Set(
    roles
      .map((role) => typeof role === 'string' ? role.trim() : '')
      .filter((role) => role.length > 0),
  ));
}

function parsePayload(value: unknown): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
    } catch {
      return undefined;
    }
  }
  return typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

export class AccountRoleRepository {
  private readonly logger = getLoggerFor(this);

  public constructor(private readonly db: IdentityDatabase) {}

  public async findByAccountId(accountId: string): Promise<AccountRoleContext | undefined> {
    const record = await this.getAccountById(accountId);
    if (!record) {
      return undefined;
    }
    const [ webId ] = resolveWebIds(record.payload);
    return { accountId, webId, roles: resolveRoles(record.payload) };
  }

  public async findByWebId(webId: string): Promise<AccountRoleContext | undefined> {
    const accounts = await this.loadAllAccounts();
    for (const { id, payload } of accounts.values()) {
      const knownWebIds = resolveWebIds(payload);
      if (knownWebIds.includes(webId)) {
        return {
          accountId: id,
          webId,
          roles: resolveRoles(payload),
        };
      }
    }
    return undefined;
  }

  public async findByWebIdLoose(webId: string): Promise<AccountRoleContext | undefined> {
    return this.findByWebId(webId);
  }

  public async addRoles(accountId: string, roles: string[]): Promise<void> {
    const unique = Array.from(new Set(
      roles.map((role) => role.trim()).filter((role) => role.length > 0),
    ));
    if (unique.length === 0) {
      return;
    }
    const record = await this.getAccountById(accountId);
    if (!record) {
      this.logger.warn(`Cannot add roles for unknown account ${accountId}`);
      return;
    }
    const nextRoles = Array.from(new Set([ ...resolveRoles(record.payload), ...unique ]));
    await this.updateAccountRecord(record, { ...record.payload, roles: nextRoles });
  }

  private async getAccountById(accountId: string): Promise<AccountPayloadRecord | undefined> {
    const accounts = await this.loadAllAccounts();
    return accounts.get(accountId);
  }

  private async loadAllAccounts(): Promise<Map<string, AccountPayloadRecord>> {
    const accounts = new Map<string, AccountPayloadRecord>();
    await this.loadIdentityStoreAccounts(accounts);
    await this.loadInternalKvAccounts(accounts);
    for (const [id, payload] of await this.loadFileAccountMap()) {
      if (!accounts.has(id)) {
        accounts.set(id, { id, payload, source: 'file' });
      }
    }
    return accounts;
  }

  private async loadIdentityStoreAccounts(accounts: Map<string, AccountPayloadRecord>): Promise<void> {
    const tableId = sql.identifier(IDENTITY_STORE_TABLE);
    let rows: Array<{ container?: string; id?: string; payload?: unknown }> = [];
    try {
      const result = await executeQuery<{ container?: string; id?: string; payload?: unknown }>(this.db, sql`
        SELECT container, id, payload
        FROM ${tableId}
        WHERE container IN ('account', 'pod', 'owner', 'webIdLink')
      `);
      rows = result.rows;
    } catch (error: unknown) {
      if (!this.isTableMissing(error)) {
        throw error;
      }
      return;
    }

    const podAccountIds = new Map<string, string>();
    const webIdsByAccount = new Map<string, Set<string>>();

    for (const row of rows) {
      if (!row.id || !row.container) {
        continue;
      }
      const payload = parsePayload(row.payload);
      if (!payload) {
        continue;
      }
      if (row.container === 'account') {
        accounts.set(row.id, { id: row.id, payload, source: 'identity-store' });
      } else if (row.container === 'pod') {
        const accountId = typeof payload.accountId === 'string' ? payload.accountId : undefined;
        if (accountId) {
          podAccountIds.set(row.id, accountId);
        }
      }
    }

    for (const row of rows) {
      const payload = parsePayload(row.payload);
      if (!row.container || !payload) {
        continue;
      }
      if (row.container === 'webIdLink') {
        const accountId = typeof payload.accountId === 'string' ? payload.accountId : undefined;
        const webId = typeof payload.webId === 'string' ? payload.webId : undefined;
        if (accountId && webId) {
          appendWebId(webIdsByAccount, accountId, webId);
        }
      } else if (row.container === 'owner') {
        const podId = typeof payload.podId === 'string' ? payload.podId : undefined;
        const webId = typeof payload.webId === 'string' ? payload.webId : undefined;
        const accountId = podId ? podAccountIds.get(podId) : undefined;
        if (accountId && webId) {
          appendWebId(webIdsByAccount, accountId, webId);
        }
      }
    }

    for (const [accountId, webIds] of webIdsByAccount) {
      const record = accounts.get(accountId);
      if (!record) {
        continue;
      }
      record.payload = {
        ...record.payload,
        webIdLink: Object.fromEntries(Array.from(webIds).map((webId, index) => [
          `webid-${index}`,
          { accountId, webId },
        ])),
      };
    }
  }

  private async loadInternalKvAccounts(accounts: Map<string, AccountPayloadRecord>): Promise<void> {
    const tableId = sql.identifier(INTERNAL_KV_TABLE);
    try {
      const result = await executeQuery<{ key?: string; value?: unknown }>(this.db, sql`
        SELECT key, value
        FROM ${tableId}
        WHERE key LIKE 'accounts/data/%'
           OR key LIKE '/.internal/accounts/data/%'
      `);
      for (const row of result.rows) {
        if (!row.key) {
          continue;
        }
        const accountId = extractAccountIdFromKey(row.key);
        const payload = parsePayload(row.value);
        if (!accountId || !payload || accounts.has(accountId)) {
          continue;
        }
        accounts.set(accountId, { id: accountId, payload, source: 'internal-kv', key: row.key });
      }
    } catch (error: unknown) {
      if (!this.isTableMissing(error)) {
        throw error;
      }
    }
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

  private async updateAccountRecord(record: AccountPayloadRecord, payload: Record<string, unknown>): Promise<void> {
    if (record.source === 'identity-store') {
      const tableId = sql.identifier(IDENTITY_STORE_TABLE);
      await executeStatement(this.db, sql`
        UPDATE ${tableId}
        SET payload = ${this.toJsonSql(payload)}
        WHERE container = 'account' AND id = ${record.id}
      `);
      return;
    }
    if (record.source === 'internal-kv' && record.key) {
      const tableId = sql.identifier(INTERNAL_KV_TABLE);
      await executeStatement(this.db, sql`
        UPDATE ${tableId}
        SET value = ${JSON.stringify(payload)}
        WHERE key = ${record.key}
      `);
    }
  }

  private toJsonSql(payload: Record<string, unknown>): unknown {
    const serialized = JSON.stringify(payload);
    return isDatabaseSqlite(this.db) ? sql`${serialized}` : sql`${serialized}::jsonb`;
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
    return /does not exist|no such table/u.test(message);
  }
}

function appendWebId(target: Map<string, Set<string>>, accountId: string, webId: string): void {
  const values = target.get(accountId) ?? new Set<string>();
  values.add(webId);
  target.set(accountId, values);
}

function extractAccountIdFromKey(key: string): string | undefined {
  const marker = 'accounts/data/';
  const index = key.indexOf(marker);
  if (index < 0) {
    return undefined;
  }
  const accountId = key.slice(index + marker.length).replace(/\.json$/u, '');
  return accountId || undefined;
}
