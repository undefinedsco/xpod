import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm/sql';
import { getLoggerFor } from 'global-logger-factory';
import type { IdentityDatabase } from './db';
import { executeQuery, executeStatement, isDatabaseSqlite, jsonFieldEquals, jsonFieldExtract } from './db';

const IDENTITY_STORE_TABLE = 'identity_store';
const INTERNAL_KV_TABLE = 'internal_kv';

export interface AccountRoleContext {
  accountId: string;
  webId?: string;
  roles: string[];
}

export interface AccountRoleRepositoryOptions {
  /**
   * CSS 文件存储时代的账户目录（`.internal/accounts/data`）。
   * 仅在迁移期兜底读取；默认按进程 CWD 惰性解析，桌面/集群部署应显式注入。
   */
  legacyAccountDataDir?: string;
}

interface AccountPayloadRecord {
  id: string;
  payload: Record<string, unknown>;
  source: 'identity-store' | 'internal-kv' | 'file';
  key?: string;
}

function isWebIdString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim() && !/[\r\n\t]/u.test(value);
}

function resolveWebIds(payload: Record<string, unknown>): string[] {
  const candidates = new Set<string>();
  const possibleKeys = [ 'webId', 'webid', 'primaryWebId', 'primary_webid' ];
  for (const key of possibleKeys) {
    const value = payload[key];
    if (isWebIdString(value)) {
      candidates.add(value);
    }
  }
  const settings = payload.settings;
  if (settings && typeof settings === 'object') {
    const webId = (settings as Record<string, unknown>).webId;
    if (isWebIdString(webId)) {
      candidates.add(webId);
    }
  }
  const pods = payload.pods;
  if (Array.isArray(pods)) {
    for (const entry of pods) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const webId = (entry as Record<string, unknown>).webId;
      if (isWebIdString(webId)) {
        candidates.add(webId);
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
      if (isWebIdString(webId)) {
        candidates.add(webId);
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
        if (isWebIdString(webId)) {
          candidates.add(webId);
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
  private readonly legacyAccountDataDir?: string;

  public constructor(
    private readonly db: IdentityDatabase,
    options: AccountRoleRepositoryOptions = {},
  ) {
    this.legacyAccountDataDir = options.legacyAccountDataDir;
  }

  public async findByAccountId(accountId: string): Promise<AccountRoleContext | undefined> {
    // 快路径：按主键直查 account 行，再按 accountId 反查链接表，避免全表扫描。
    const record = await this.getIdentityStoreAccount(accountId);
    if (record) {
      const linked = await this.findWebIdsForAccount(accountId);
      const webId = linked[0] ?? resolveWebIds(record.payload)[0];
      return { accountId, webId, roles: resolveRoles(record.payload) };
    }

    const legacy = await this.loadLegacyAccounts();
    const fallback = legacy.get(accountId);
    if (!fallback) {
      return undefined;
    }
    return { accountId, webId: resolveWebIds(fallback.payload)[0], roles: resolveRoles(fallback.payload) };
  }

  public async findByWebId(webId: string): Promise<AccountRoleContext | undefined> {
    if (!isWebIdString(webId)) {
      return undefined;
    }
    // 快路径：webIdLink / owner→pod 链路的字段下推查询。
    const accountId = await this.findAccountIdByWebId(webId);
    if (accountId) {
      const context = await this.findByAccountId(accountId);
      if (context) {
        return { ...context, webId };
      }
    }

    // 兜底：legacy kv/文件来源及历史 payload 形状，保持原有全扫描行为。
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

  public async listAccounts(): Promise<AccountRoleContext[]> {
    const accounts = await this.loadAllAccounts();
    return Array.from(accounts.values()).map((record) => ({
      accountId: record.id,
      webId: resolveWebIds(record.payload)[0],
      roles: resolveRoles(record.payload),
    }));
  }

  public async addRoles(accountId: string, roles: string[]): Promise<void> {
    const unique = Array.from(new Set(
      roles.map((role) => role.trim()).filter((role) => role.length > 0),
    ));
    if (unique.length === 0) {
      return;
    }
    let record = await this.getIdentityStoreAccount(accountId);
    if (!record) {
      record = (await this.loadLegacyAccounts()).get(accountId);
    }
    if (!record) {
      this.logger.warn(`Cannot add roles for unknown account ${accountId}`);
      return;
    }
    const nextRoles = Array.from(new Set([ ...resolveRoles(record.payload), ...unique ]));
    await this.updateAccountRecord(record, { ...record.payload, roles: nextRoles });
  }

  /**
   * 按主键直查 identity_store 中的 account 行；表不存在时返回 undefined（由调用方走兜底）。
   */
  private async getIdentityStoreAccount(accountId: string): Promise<AccountPayloadRecord | undefined> {
    const tableId = sql.identifier(IDENTITY_STORE_TABLE);
    try {
      const result = await executeQuery<{ payload?: unknown }>(this.db, sql`
        SELECT payload
        FROM ${tableId}
        WHERE container = 'account' AND id = ${accountId}
        LIMIT 1
      `);
      const payload = parsePayload(result.rows[0]?.payload);
      return payload ? { id: accountId, payload, source: 'identity-store' } : undefined;
    } catch (error: unknown) {
      if (!this.isTableMissing(error)) {
        throw error;
      }
      return undefined;
    }
  }

  /**
   * 按 CSS 行契约（webIdLink.accountId、pod.accountId、owner.podId）下推查询账户的 WebID。
   */
  private async findWebIdsForAccount(accountId: string): Promise<string[]> {
    const tableId = sql.identifier(IDENTITY_STORE_TABLE);
    const webIds = new Set<string>();
    try {
      const links = await executeQuery<{ payload?: unknown }>(this.db, sql`
        SELECT payload FROM ${tableId}
        WHERE container = 'webIdLink' AND ${jsonFieldEquals(this.db, 'accountId', accountId)}
      `);
      for (const row of links.rows) {
        const webId = parsePayload(row.payload)?.webId;
        if (isWebIdString(webId)) {
          webIds.add(webId);
        }
      }

      const owners = await executeQuery<{ payload?: unknown }>(this.db, sql`
        SELECT o.payload FROM ${tableId} o
        WHERE o.container = 'owner' AND EXISTS (
          SELECT 1 FROM ${tableId} p
          WHERE p.container = 'pod'
            AND ${jsonFieldEquals(this.db, 'accountId', accountId, 'p')}
            AND ${this.ownerPodJoin()}
        )
      `);
      for (const row of owners.rows) {
        const webId = parsePayload(row.payload)?.webId;
        if (isWebIdString(webId)) {
          webIds.add(webId);
        }
      }
    } catch (error: unknown) {
      if (!this.isTableMissing(error)) {
        throw error;
      }
    }
    return Array.from(webIds);
  }

  /**
   * WebID → accountId 的下推解析：webIdLink 优先，其次 account 行内嵌 webId 字段，
   * 最后 owner→pod 链路。全部 miss 返回 undefined（调用方再走全量兜底）。
   */
  private async findAccountIdByWebId(webId: string): Promise<string | undefined> {
    const tableId = sql.identifier(IDENTITY_STORE_TABLE);
    try {
      const links = await executeQuery<{ payload?: unknown }>(this.db, sql`
        SELECT payload FROM ${tableId}
        WHERE container = 'webIdLink' AND ${jsonFieldEquals(this.db, 'webId', webId)}
        LIMIT 1
      `);
      const linkedAccount = parsePayload(links.rows[0]?.payload)?.accountId;
      if (typeof linkedAccount === 'string' && linkedAccount.length > 0) {
        return linkedAccount;
      }

      for (const field of [ 'webId', 'webid', 'primaryWebId', 'primary_webid' ]) {
        const accounts = await executeQuery<{ id?: string }>(this.db, sql`
          SELECT id FROM ${tableId}
          WHERE container = 'account' AND ${jsonFieldEquals(this.db, field, webId)}
          LIMIT 1
        `);
        if (accounts.rows[0]?.id) {
          return accounts.rows[0].id;
        }
      }

      const owners = await executeQuery<{ payload?: unknown }>(this.db, sql`
        SELECT payload FROM ${tableId}
        WHERE container = 'owner' AND ${jsonFieldEquals(this.db, 'webId', webId)}
        LIMIT 1
      `);
      const podId = parsePayload(owners.rows[0]?.payload)?.podId;
      if (typeof podId === 'string' && podId.length > 0) {
        const pods = await executeQuery<{ payload?: unknown }>(this.db, sql`
          SELECT payload FROM ${tableId}
          WHERE container = 'pod' AND id = ${podId}
          LIMIT 1
        `);
        const ownerAccount = parsePayload(pods.rows[0]?.payload)?.accountId;
        if (typeof ownerAccount === 'string' && ownerAccount.length > 0) {
          return ownerAccount;
        }
      }
    } catch (error: unknown) {
      if (!this.isTableMissing(error)) {
        throw error;
      }
    }
    return undefined;
  }

  /**
   * owner→pod 链路里把 owner 行的 podId 与 pod 行的 id 对齐。
   */
  private ownerPodJoin(): SQL {
    return sql`${jsonFieldExtract(this.db, 'podId', 'o')} = p.id`;
  }

  /**
   * legacy 来源：internal_kv 与文件账户（迁移期兜底），不含 identity_store。
   */
  private async loadLegacyAccounts(): Promise<Map<string, AccountPayloadRecord>> {
    const accounts = new Map<string, AccountPayloadRecord>();
    await this.loadInternalKvAccounts(accounts);
    for (const [id, payload] of await this.loadFileAccountMap()) {
      if (!accounts.has(id)) {
        accounts.set(id, { id, payload, source: 'file' });
      }
    }
    return accounts;
  }

  private async loadAllAccounts(): Promise<Map<string, AccountPayloadRecord>> {
    const accounts = new Map<string, AccountPayloadRecord>();
    await this.loadIdentityStoreAccounts(accounts);
    for (const [id, record] of await this.loadLegacyAccounts()) {
      if (!accounts.has(id)) {
        accounts.set(id, record);
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
    // 目录在使用时才解析（而不是模块加载时）：桌面/测试进程的 CWD 与模块加载时机无关。
    const accountDataDir = this.legacyAccountDataDir ?? path.resolve('.internal', 'accounts', 'data');
    const map = new Map<string, Record<string, unknown>>();
    try {
      const files = await fs.readdir(accountDataDir);
      for (const file of files) {
        if (!file.endsWith('.json')) {
          continue;
        }
        const fullPath = path.join(accountDataDir, file);
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
      this.logger.debug(`Account data directory unavailable (${accountDataDir}): ${(error as Error).message}`);
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
