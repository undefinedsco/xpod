import { sql } from 'drizzle-orm';
import { getLoggerFor } from 'global-logger-factory';
import type { IdentityDatabase } from './db';
import { executeQuery, executeStatement } from './db';

const INTERNAL_KV_TABLE = 'internal_kv';

export interface AccountRoleContext {
  accountId: string;
  webId?: string;
  roles: string[];
}

interface AccountPayloadRecord {
  id: string;
  payload: Record<string, unknown>;
  source: 'internal-kv';
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
      const unwrapped = unwrapStoredValue(parsed);
      return unwrapped && typeof unwrapped === 'object' ? unwrapped as Record<string, unknown> : undefined;
    } catch {
      return undefined;
    }
  }
  const unwrapped = unwrapStoredValue(value);
  return typeof unwrapped === 'object' ? unwrapped as Record<string, unknown> : undefined;
}

function unwrapStoredValue(value: unknown): unknown {
  if (value && typeof value === 'object' && 'key' in value && 'payload' in value) {
    return (value as Record<string, unknown>).payload;
  }
  return value;
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
    await this.loadInternalKvAccounts(accounts);
    return accounts;
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

  private async updateAccountRecord(record: AccountPayloadRecord, payload: Record<string, unknown>): Promise<void> {
    if (record.source === 'internal-kv' && record.key) {
      const tableId = sql.identifier(INTERNAL_KV_TABLE);
      await executeStatement(this.db, sql`
        UPDATE ${tableId}
        SET value = ${JSON.stringify(payload)}
        WHERE key = ${record.key}
      `);
    }
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

function extractAccountIdFromKey(key: string): string | undefined {
  const marker = 'accounts/data/';
  const index = key.indexOf(marker);
  if (index < 0) {
    return undefined;
  }
  const accountId = key.slice(index + marker.length).replace(/\.json$/u, '');
  return accountId || undefined;
}
