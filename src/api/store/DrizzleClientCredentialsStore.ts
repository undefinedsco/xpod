import { eq, sql } from 'drizzle-orm';
import { getLoggerFor } from 'global-logger-factory';
import type { IdentityDatabase } from '../../identity/drizzle/db';
import { apiClientCredentials as pgApiClientCredentials } from '../../identity/drizzle/schema.pg';
import { apiClientCredentials as sqliteApiClientCredentials } from '../../identity/drizzle/schema.sqlite';
import type { ClientCredentialsRecord, ClientCredentialsStore } from '../auth/ClientCredentialsAuthenticator';

export interface DrizzleClientCredentialsStoreOptions {
  db: IdentityDatabase;
  /**
   * Whether using SQLite (default: false for PostgreSQL)
   */
  isSqlite?: boolean;
}

/**
 * Storage for API Keys (client credentials) using Drizzle ORM
 *
 * Only stores clientId → webId/accountId mapping.
 * The actual clientSecret lives in the sk-xxx token and is never persisted.
 */
export class DrizzleClientCredentialsStore implements ClientCredentialsStore {
  private readonly logger = getLoggerFor(this);
  private readonly db: IdentityDatabase;
  private readonly apiClientCredentials: typeof pgApiClientCredentials | typeof sqliteApiClientCredentials;

  public constructor(options: DrizzleClientCredentialsStoreOptions) {
    this.db = options.db;
    this.apiClientCredentials = options.isSqlite ? sqliteApiClientCredentials : pgApiClientCredentials;
  }

  /**
   * Store API Key registration (called when user creates API Key via frontend)
   */
  public async store(options: {
    clientId: string;
    webId: string;
    accountId: string;
    displayName?: string;
  }): Promise<void> {
    await this.db
      .insert(this.apiClientCredentials)
      .values({
        clientId: options.clientId,
        webId: options.webId,
        accountId: options.accountId,
        displayName: options.displayName ?? null,
      })
      .onConflictDoUpdate({
        target: this.apiClientCredentials.clientId,
        set: {
          displayName: options.displayName ?? null,
        },
      });

    this.logger.info(`Stored API Key: ${options.clientId}`);
  }

  /**
   * Find by client_id (the "API Key")
   */
  public async findByClientId(clientId: string): Promise<ClientCredentialsRecord | undefined> {
    const rows = await this.db
      .select()
      .from(this.apiClientCredentials)
      .where(eq(this.apiClientCredentials.clientId, clientId))
      .limit(1);

    if (rows.length === 0) {
      return undefined;
    }

    const row = rows[0];
    return {
      clientId: row.clientId,
      webId: row.webId,
      accountId: row.accountId,
      displayName: row.displayName ?? undefined,
      createdAt: row.createdAt,
    };
  }

  /**
   * List API Keys for an account
   */
  public async listByAccount(accountId: string): Promise<Array<{
    clientId: string;
    webId: string;
    displayName?: string;
    createdAt: Date;
  }>> {
    const rows = await this.db
      .select({
        clientId: this.apiClientCredentials.clientId,
        webId: this.apiClientCredentials.webId,
        displayName: this.apiClientCredentials.displayName,
        createdAt: this.apiClientCredentials.createdAt,
      })
      .from(this.apiClientCredentials)
      .where(eq(this.apiClientCredentials.accountId, accountId))
      .orderBy(sql`${this.apiClientCredentials.createdAt} DESC`);

    return rows.map((row: typeof rows[number]) => ({
      clientId: row.clientId,
      webId: row.webId,
      displayName: row.displayName ?? undefined,
      createdAt: row.createdAt,
    }));
  }

  /**
   * Find the most recently created API Key for an account.
   */
  public async findByAccountId(accountId: string): Promise<ClientCredentialsRecord | undefined> {
    const rows = await this.db
      .select()
      .from(this.apiClientCredentials)
      .where(eq(this.apiClientCredentials.accountId, accountId))
      .orderBy(sql`${this.apiClientCredentials.createdAt} DESC`)
      .limit(1);

    if (rows.length === 0) {
      return undefined;
    }

    const row = rows[0];
    return {
      clientId: row.clientId,
      webId: row.webId,
      accountId: row.accountId,
      displayName: row.displayName ?? undefined,
      createdAt: row.createdAt,
    };
  }

  /**
   * Delete an API Key
   */
  public async delete(clientId: string, accountId?: string): Promise<boolean> {
    await this.db
      .delete(this.apiClientCredentials)
      .where(eq(this.apiClientCredentials.clientId, clientId));
    return true;
  }
}
