import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';
import { eq, sql, and } from 'drizzle-orm';
import { getLoggerFor } from 'global-logger-factory';
import type { IdentityDatabase } from '../../identity/drizzle/db';
import { isDatabaseSqlite } from '../../identity/drizzle/db';
import { apiClientCredentials as pgApiClientCredentials } from '../../identity/drizzle/schema.pg';
import { apiClientCredentials as sqliteApiClientCredentials } from '../../identity/drizzle/schema.sqlite';
import type { ClientCredentialsRecord, ClientCredentialsStore } from '../auth/ClientCredentialsAuthenticator';

export interface DrizzleClientCredentialsStoreOptions {
  db: IdentityDatabase;
  /**
   * Encryption key for storing client secrets
   */
  encryptionKey: string;
}

/**
 * Storage for API Keys (client credentials) using Drizzle ORM
 * Supports both PostgreSQL and SQLite databases.
 */
export class DrizzleClientCredentialsStore implements ClientCredentialsStore {
  private readonly logger = getLoggerFor(this);
  private readonly db: IdentityDatabase;
  private readonly encryptionKey: Buffer;
  private readonly isSqlite: boolean;

  public constructor(options: DrizzleClientCredentialsStoreOptions) {
    this.db = options.db;
    this.encryptionKey = scryptSync(options.encryptionKey, 'xpod-api-salt', 32);
    this.isSqlite = isDatabaseSqlite(options.db);
  }

  /**
   * Get the appropriate table schema based on database type.
   */
  private get table() {
    return this.isSqlite ? sqliteApiClientCredentials : pgApiClientCredentials;
  }

  /**
   * Store client credentials (called when user creates API Key via frontend)
   */
  public async store(options: {
    clientId: string;
    clientSecret: string;
    webId: string;
    accountId: string;
    displayName?: string;
  }): Promise<void> {
    const encryptedSecret = this.encrypt(options.clientSecret);
    const table = this.table;

    // Check if record exists first
    const existing = await this.db
      .select({ clientId: table.clientId })
      .from(table)
      .where(eq(table.clientId, options.clientId))
      .limit(1);

    if (existing.length > 0) {
      // Update existing record
      await this.db
        .update(table)
        .set({
          clientSecretEncrypted: encryptedSecret,
          webId: options.webId,
          accountId: options.accountId,
          displayName: options.displayName ?? null,
        })
        .where(eq(table.clientId, options.clientId));
    } else {
      // Insert new record
      await this.db
        .insert(table)
        .values({
          clientId: options.clientId,
          clientSecretEncrypted: encryptedSecret,
          webId: options.webId,
          accountId: options.accountId,
          displayName: options.displayName ?? null,
        });
    }

    this.logger.info(`Stored API Key: ${options.clientId}`);
  }

  /**
   * Find by client_id (the "API Key")
   */
  public async findByClientId(clientId: string): Promise<ClientCredentialsRecord | undefined> {
    const table = this.table;
    const rows = await this.db
      .select()
      .from(table)
      .where(eq(table.clientId, clientId))
      .limit(1);

    if (rows.length === 0) {
      return undefined;
    }

    const row = rows[0];
    return {
      clientId: row.clientId,
      clientSecret: this.decrypt(row.clientSecretEncrypted),
      webId: row.webId,
      accountId: row.accountId,
      displayName: row.displayName ?? undefined,
      createdAt: this.normalizeTimestamp(row.createdAt),
    };
  }

  /**
   * List API Keys for an account (without secrets)
   */
  public async listByAccount(accountId: string): Promise<Array<{
    clientId: string;
    webId: string;
    displayName?: string;
    createdAt: Date;
  }>> {
    const table = this.table;
    const rows = await this.db
      .select({
        clientId: table.clientId,
        webId: table.webId,
        displayName: table.displayName,
        createdAt: table.createdAt,
      })
      .from(table)
      .where(eq(table.accountId, accountId))
      .orderBy(sql`${table.createdAt} DESC`);

    return rows.map((row: typeof rows[number]) => ({
      clientId: row.clientId,
      webId: row.webId,
      displayName: row.displayName ?? undefined,
      createdAt: this.normalizeTimestamp(row.createdAt),
    }));
  }

  /**
   * Find the most recently created API Key for an account (including secret).
   */
  public async findByAccountId(accountId: string): Promise<ClientCredentialsRecord | undefined> {
    const table = this.table;
    const rows = await this.db
      .select()
      .from(table)
      .where(eq(table.accountId, accountId))
      .orderBy(sql`${table.createdAt} DESC`)
      .limit(1);

    if (rows.length === 0) {
      return undefined;
    }

    const row = rows[0];
    return {
      clientId: row.clientId,
      clientSecret: this.decrypt(row.clientSecretEncrypted),
      webId: row.webId,
      accountId: row.accountId,
      displayName: row.displayName ?? undefined,
      createdAt: this.normalizeTimestamp(row.createdAt),
    };
  }

  /**
   * Delete an API Key
   */
  public async delete(clientId: string, accountId?: string): Promise<boolean> {
    const table = this.table;
    if (accountId) {
      await this.db
        .delete(table)
        .where(and(eq(table.clientId, clientId), eq(table.accountId, accountId)));
    } else {
      await this.db
        .delete(table)
        .where(eq(table.clientId, clientId));
    }
    return true;
  }

  /**
   * Normalize timestamp from database (SQLite stores as integer, PostgreSQL as Date)
   */
  private normalizeTimestamp(value: unknown): Date {
    if (value instanceof Date) {
      return value;
    }
    if (typeof value === 'number') {
      // SQLite stores as Unix timestamp (seconds)
      return new Date(value * 1000);
    }
    if (typeof value === 'string') {
      return new Date(value);
    }
    return new Date();
  }

  private encrypt(plaintext: string): string {
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-cbc', this.encryptionKey, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  }

  private decrypt(ciphertext: string): string {
    const [ivHex, encrypted] = ciphertext.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = createDecipheriv('aes-256-cbc', this.encryptionKey, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }
}
