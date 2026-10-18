import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { BadRequestHttpError } from '@solid/community-server';
import { executeQuery, executeStatement, executePostgresLockedStatements, getIdentityDatabase, isDatabaseSqlite, type IdentityDatabase } from '../drizzle/db';

export interface ExternalLoginTransaction {
  provider: string;
  intent: 'login' | 'register' | 'link';
  accountId?: string;
  interaction?: string;
  callback: string;
  returnTo: string;
  remember: boolean;
}

/** Identity DB coordination, shared by all workers. No user Pod data is stored here. */
export class ExternalLoginRepository {
  private get db(): IdentityDatabase { return getIdentityDatabase(this.connectionString); }
  private ready?: Promise<void>;

  public constructor(private readonly connectionString: string) {}

  private initialize(): Promise<void> {
    return this.ready ??= (async () => {
      const statements = [
        'CREATE TABLE IF NOT EXISTS identity_external_login_transactions (state TEXT PRIMARY KEY, proof TEXT NOT NULL, expires_at BIGINT NOT NULL, payload TEXT NOT NULL)',
        // This is a unique lookup index. The login row in CSS AccountStorage owns the identity/account fact.
        'CREATE TABLE IF NOT EXISTS identity_external_login_index (subject TEXT PRIMARY KEY, login_id TEXT NOT NULL, lease_until BIGINT NOT NULL DEFAULT 0)',
      ];
      if (!isDatabaseSqlite(this.db)) {
        await executePostgresLockedStatements(this.db, 1_936_528_502, statements);
      } else {
        for (const statement of statements) await executeStatement(this.db, sql.raw(statement));
      }
    })();
  }

  public async begin(state: string, proof: string, transaction: ExternalLoginTransaction): Promise<void> {
    await this.initialize();
    const now = Date.now();
    await executeStatement(this.db, sql`DELETE FROM identity_external_login_transactions WHERE expires_at <= ${now}`);
    await executeStatement(this.db, sql`INSERT INTO identity_external_login_transactions (state, proof, expires_at, payload)
      VALUES (${state}, ${proof}, ${now + 10 * 60_000}, ${JSON.stringify(transaction)})`);
  }

  public async consume(state: string, proof: string): Promise<ExternalLoginTransaction> {
    await this.initialize();
    const result = await executeQuery(this.db, sql`DELETE FROM identity_external_login_transactions
      WHERE state = ${state} AND proof = ${proof} AND expires_at > ${Date.now()} RETURNING payload`);
    const row = result.rows[0];
    if (!row) throw new BadRequestHttpError('EXTERNAL_LOGIN_EXPIRED_OR_INVALID');
    return JSON.parse(String(row.payload)) as ExternalLoginTransaction;
  }

  public async find(subject: string): Promise<string | undefined> {
    await this.initialize();
    const result = await executeQuery(this.db, sql`SELECT login_id FROM identity_external_login_index WHERE subject = ${subject}`);
    return result.rows[0]?.login_id as string | undefined;
  }

  public async reserve(subject: string): Promise<{ owner?: string; loginId?: string }> {
    await this.initialize();
    const owner = `pending:${randomUUID()}`;
    const now = Date.now();
    const result = await executeQuery(this.db, sql`INSERT INTO identity_external_login_index (subject, login_id, lease_until)
      VALUES (${subject}, ${owner}, ${now + 120_000}) ON CONFLICT (subject) DO NOTHING RETURNING login_id`);
    if (result.rows.length) {
      return { owner };
    }
    const previous = await executeQuery(this.db, sql`UPDATE identity_external_login_index SET login_id = ${owner}, lease_until = ${now + 120_000}
      WHERE subject = ${subject} AND lease_until > 0 AND lease_until < ${now} RETURNING login_id`);
    if (previous.rows.length) return { owner };
    const loginId = await this.find(subject);
    if (!loginId || loginId.startsWith('pending:')) throw new BadRequestHttpError('EXTERNAL_LOGIN_BUSY');
    return { loginId };
  }

  public async claim(subject: string, owner: string, loginId: string): Promise<void> {
    const result = await executeQuery(this.db, sql`UPDATE identity_external_login_index SET login_id = ${loginId}, lease_until = 0
      WHERE subject = ${subject} AND login_id = ${owner} RETURNING login_id`);
    if (!result.rows.length) throw new BadRequestHttpError('EXTERNAL_IDENTITY_ALREADY_BOUND');
  }

  public async remove(subject: string, loginId: string): Promise<void> {
    await this.initialize();
    await executeStatement(this.db, sql`DELETE FROM identity_external_login_index WHERE subject = ${subject} AND login_id = ${loginId}`);
  }
}
