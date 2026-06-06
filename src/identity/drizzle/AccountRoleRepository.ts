import { sql } from 'drizzle-orm';
import { getLoggerFor } from 'global-logger-factory';
import type { IdentityDatabase } from './db';
import { executeQuery } from './db';

export interface AccountRoleContext {
  accountId: string;
  webId?: string;
  roles: string[];
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

function resolveRoles(payload: Record<string, unknown>): string[] {
  const roles = payload.roles;
  if (Array.isArray(roles)) {
    return Array.from(new Set(roles
      .map((role) => typeof role === 'string' ? role.trim() : '')
      .filter((role) => role.length > 0)));
  }
  if (typeof roles === 'string' && roles.trim().length > 0) {
    return [ roles.trim() ];
  }
  return [];
}

export class AccountRoleRepository {
  private readonly logger = getLoggerFor(this);

  public constructor(private readonly db: IdentityDatabase) {}

  public async findByAccountId(accountId: string): Promise<AccountRoleContext | undefined> {
    const payload = await this.getAccountPayloadById(accountId);
    if (!payload) {
      return undefined;
    }
    const [ webId ] = resolveWebIds(payload);
    const roles = resolveRoles(payload);
    return { accountId, webId, roles };
  }

  public async findByWebId(webId: string): Promise<AccountRoleContext | undefined> {
    const accounts = await this.loadAllAccounts();
    for (const { id, payload } of accounts) {
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

  private async getAccountPayloadById(accountId: string): Promise<Record<string, unknown> | undefined> {
    try {
      const accountResult = await executeQuery<{ payload?: unknown }>(this.db, sql`
        SELECT payload
        FROM identity_store
        WHERE container = 'account'
          AND id = ${accountId}
        LIMIT 1
      `);
      if (accountResult.rows.length > 0) {
        return parsePayload(accountResult.rows[0]?.payload);
      }
    } catch (error: unknown) {
      if (!this.isTableMissing(error)) {
        throw error;
      }
      this.logger.debug(`identity_store unavailable while reading account ${accountId}: ${(error as Error).message}`);
    }
    return undefined;
  }

  private async loadAllAccounts(): Promise<Array<{ id: string; payload: Record<string, unknown> }>> {
    try {
      const result = await executeQuery<{ id: string; payload: unknown }>(this.db, sql`
        SELECT id, payload
        FROM identity_store
        WHERE container = 'account'
      `);
      return result.rows.flatMap((row) => {
        const payload = parsePayload(row.payload);
        return payload ? [{ id: row.id, payload }] : [];
      });
    } catch (error: unknown) {
      if (!this.isTableMissing(error)) {
        throw error;
      }
      this.logger.debug(`identity_store unavailable while scanning account roles: ${(error as Error).message}`);
      return [];
    }
  }

  private isTableMissing(error: unknown): boolean {
    const message = String((error as Error).message ?? error);
    return /no such table|does not exist|undefined_table/i.test(message);
  }
}
