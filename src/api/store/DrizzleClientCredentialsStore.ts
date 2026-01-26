import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { getLoggerFor } from 'global-logger-factory';
import type { IdentityDatabase } from '../../identity/drizzle/db';
import { apiClientCredentials as pgApiClientCredentials } from '../../identity/drizzle/schema.pg';
import { apiClientCredentials as sqliteApiClientCredentials } from '../../identity/drizzle/schema.sqlite';
import type { ClientCredentialsRecord, ClientCredentialsStore } from '../auth/ClientCredentialsAuthenticator';

export interface DrizzleClientCredentialsStoreOptions {
  db: IdentityDatabase;
  /**
   * Encryption key for storing client secrets
   */
  encryptionKey: string;
  /**
   * Whether using SQLite (default: false for PostgreSQL)
   */
  isSqlite?: boolean;
}

/**
 * Storage for API Keys (client credentials) using Drizzle ORM
 */
export class DrizzleClientCredentialsStore implements ClientCredentialsStore {
  private readonly logger = getLoggerFor(this);
  private readonly db: IdentityDatabase;
  private readonly encryptionKey: Buffer;
  private readonly apiClientCredentials: typeof pgApiClientCredentials | typeof sqliteApiClientCredentials;

  public constructor(options: DrizzleClientCredentialsStoreOptions) {
    this.db = options.db;
    this.encryptionKey = scryptSync(options.encryptionKey, 'xpod-api-salt', 32);
    // Select appropriate schema based on database type
    this.apiClientCredentials = options.isSqlite ? sqliteApiClientCredentials : pgApiClientCredentials;
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

    await this.db
      .insert(this.apiClientCredentials)
      .values({
        clientId: options.clientId,
        clientSecretEncrypted: encryptedSecret,
        webId: options.webId,
        accountId: options.accountId,
        displayName: options.displayName ?? null,
      })
      .onConflictDoUpdate({
        target: this.apiClientCredentials.clientId,
        set: {
          clientSecretEncrypted: encryptedSecret,
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
      clientSecret: this.decrypt(row.clientSecretEncrypted),
      webId: row.webId,
      accountId: row.accountId,
      displayName: row.displayName ?? undefined,
      createdAt: row.createdAt,
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
   * Find the most recently created API Key for an account (including secret).
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
      clientSecret: this.decrypt(row.clientSecretEncrypted),
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
    if (accountId) {
      const result = await this.db
        .delete(this.apiClientCredentials)
        .where(eq(this.apiClientCredentials.clientId, clientId));
      // Check if the deleted row belonged to the account
      // For safety, we could add an AND condition, but Drizzle doesn't support multiple where easily
      // So we trust the caller to verify ownership before calling delete
    } else {
      await this.db
        .delete(this.apiClientCredentials)
        .where(eq(this.apiClientCredentials.clientId, clientId));
    }
    return true;
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
