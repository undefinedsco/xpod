import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp as pgTimestamp } from 'drizzle-orm/pg-core';
import { integer } from 'drizzle-orm/pg-core/columns/integer';
import { sqliteTable, text as sqliteText, integer as sqliteInteger } from 'drizzle-orm/sqlite-core';

/**
 * Task-layer credential records: the runtime's own copy of a user's CSS client credentials.
 *
 * This table belongs to the task layer, not to the API: the API only ever uses a credential the
 * caller brought with that request, while background execution needs one on file when nobody is
 * present. Keeping it in its own database (local mode: its own SQLite file) is what makes that
 * boundary real instead of a naming convention.
 *
 * `sealed_secret` is encrypted with the deployment key (decision 6), and the row records which
 * key sealed it so rotation keeps old rows decryptable.
 */
export const taskCredentialsSqlite = sqliteTable('task_credential', {
  credentialId: sqliteText('credential_id').primaryKey(),
  ownerWebId: sqliteText('owner_web_id').notNull(),
  issuer: sqliteText('issuer').notNull(),
  clientId: sqliteText('client_id').notNull(),
  sealedSecret: sqliteText('sealed_secret').notNull(),
  sealedSecretKeyId: sqliteText('sealed_secret_key_id').notNull(),
  credentialVersion: sqliteInteger('credential_version').notNull().default(1),
  status: sqliteText('status').notNull(),
  createdAt: sqliteInteger('created_at').notNull(),
  rotatedAt: sqliteInteger('rotated_at'),
  lastUsedAt: sqliteInteger('last_used_at'),
  expiresAt: sqliteInteger('expires_at'),
});

export const taskCredentialsPg = pgTable('task_credential', {
  credentialId: text('credential_id').primaryKey(),
  ownerWebId: text('owner_web_id').notNull(),
  issuer: text('issuer').notNull(),
  clientId: text('client_id').notNull(),
  sealedSecret: text('sealed_secret').notNull(),
  sealedSecretKeyId: text('sealed_secret_key_id').notNull(),
  credentialVersion: integer('credential_version').notNull().default(1),
  status: text('status').notNull(),
  createdAt: pgTimestamp('created_at', { withTimezone: true }).notNull(),
  rotatedAt: pgTimestamp('rotated_at', { withTimezone: true }),
  lastUsedAt: pgTimestamp('last_used_at', { withTimezone: true }),
  expiresAt: pgTimestamp('expires_at', { withTimezone: true }),
});

export const taskCredentialSchema = {
  sqlite: { taskCredentials: taskCredentialsSqlite },
  pg: { taskCredentials: taskCredentialsPg },
};

/**
 * Creates the task-layer table and its index on a fresh database; existing rows are left untouched.
 *
 * PostgreSQL catalog types race when two connections issue `CREATE TABLE IF NOT EXISTS` at the same
 * time (`pg_type_typname_nsp_index`), so table and index DDL run in one transaction on one pinned
 * connection behind a transaction-scoped advisory lock. SQLite has a single local writer, so its DDL
 * is already serialized. This function is the one awaited initializer; callers open the raw handle
 * without touching schema.
 */
export async function ensureTaskCredentialTables(db: any): Promise<void> {
  if (typeof db.run === 'function') {
    db.run(sql`
      CREATE TABLE IF NOT EXISTS task_credential (
        credential_id TEXT PRIMARY KEY,
        owner_web_id TEXT NOT NULL,
        issuer TEXT NOT NULL,
        client_id TEXT NOT NULL,
        sealed_secret TEXT NOT NULL,
        sealed_secret_key_id TEXT NOT NULL,
        credential_version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        rotated_at INTEGER,
        last_used_at INTEGER,
        expires_at INTEGER
      )
    `);
    db.run(sql`CREATE INDEX IF NOT EXISTS task_credential_owner ON task_credential (owner_web_id)`);
    return;
  }
  await db.transaction(async (transaction: any): Promise<void> => {
    // One transaction-scoped lock, released on commit/rollback, so repeated Stores and processes
    // cannot concurrently create the relation. No standalone pooled session lock.
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtext('xpod_task_credential_schema'))`);
    await transaction.execute(sql`
      CREATE TABLE IF NOT EXISTS task_credential (
        credential_id TEXT PRIMARY KEY,
        owner_web_id TEXT NOT NULL,
        issuer TEXT NOT NULL,
        client_id TEXT NOT NULL,
        sealed_secret TEXT NOT NULL,
        sealed_secret_key_id TEXT NOT NULL,
        credential_version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        rotated_at TIMESTAMPTZ,
        last_used_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ
      )
    `);
    await transaction.execute(sql`CREATE INDEX IF NOT EXISTS task_credential_owner ON task_credential (owner_web_id)`);
  });
}
