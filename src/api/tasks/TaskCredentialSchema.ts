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

/** Creates the task-layer table on a fresh database; existing rows are left untouched. */
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
  await db.execute(sql`
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
  await db.execute(sql`CREATE INDEX IF NOT EXISTS task_credential_owner ON task_credential (owner_web_id)`);
}
