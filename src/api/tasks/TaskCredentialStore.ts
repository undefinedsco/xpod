import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getLoggerFor } from 'global-logger-factory';
import { fromDbTimestamp, toDbTimestamp } from '../../identity/drizzle/db';
import type { SecretCellVault } from '../../security/secret-cell';
import type { TaskCredentialDatabase } from './TaskCredentialDatabase';
import { ensureTaskCredentialTables } from './TaskCredentialSchema';

/** Stable reference a task binding carries instead of a secret. */
export type TaskCredentialRef = string;

/**
 * `pending` is a grant that exists but must not be used yet: the user asked for it, and the
 * runtime activates it only once the grant is confirmed. `expired` and `revoked` are terminal for
 * execution but keep the row, so audits and rotation keep their history.
 */
export type TaskCredentialStatus = 'pending' | 'active' | 'revoked' | 'expired';

/** Everything an executor needs to open the owner's Pod; never logged or persisted elsewhere. */
export interface TaskCredentialLease {
  credentialRef: TaskCredentialRef;
  ownerWebId: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  version: number;
}

/** Metadata about a grant, safe to return to a UI. */
export interface TaskCredentialSummary {
  credentialRef: TaskCredentialRef;
  ownerWebId: string;
  issuer: string;
  clientId: string;
  version: number;
  status: TaskCredentialStatus;
  createdAt: Date;
  rotatedAt?: Date;
  lastUsedAt?: Date;
  expiresAt?: Date;
}

export const TASK_CREDENTIAL_NOT_FOUND = 'task_credential_not_found';
export const TASK_CREDENTIAL_NOT_ACTIVE = 'task_credential_not_active';
export const TASK_CREDENTIAL_VERSION_CONFLICT = 'task_credential_version_conflict';
export const TASK_CREDENTIAL_OWNER_MISMATCH = 'task_credential_owner_mismatch';
export const TASK_CREDENTIAL_ENCRYPTION_FAILED = 'task_credential_encryption_failed';

export interface TaskCredentialStoreOptions {
  database: TaskCredentialDatabase;
  /** Deployment-key vault. The secret is stored encrypted, never in the clear. */
  vault: SecretCellVault;
  now?: () => Date;
  /** Stable id for a new grant; injectable so callers can make granting idempotent. */
  newCredentialRef?: (input: { ownerWebId: string; issuer: string }) => string;
}

export interface GrantTaskCredentialInput {
  ownerWebId: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** `pending` until the grant is confirmed; defaults to `pending`. */
  status?: Extract<TaskCredentialStatus, 'pending' | 'active'>;
  expiresAt?: Date;
  /** Reuse this reference to make a retried grant idempotent. */
  credentialRef?: TaskCredentialRef;
}

/**
 * The task layer's own credential store.
 *
 * Reading a lease requires an explicit owner and an `active` row at the expected version, so a
 * stale task, a revoked grant or another user's reference cannot open somebody else's Pod.
 */
export class TaskCredentialStore {
  private readonly logger = getLoggerFor(this);
  private readonly db: any;
  private readonly table: any;
  private readonly vault: SecretCellVault;
  private readonly now: () => Date;
  private readonly newCredentialRef: (input: { ownerWebId: string; issuer: string }) => string;
  private readonly ready: Promise<void>;
  private initError?: unknown;

  public constructor(options: TaskCredentialStoreOptions) {
    this.db = options.database.db;
    this.table = options.database.schema.taskCredentials;
    this.vault = options.vault;
    this.now = options.now ?? (() => new Date());
    // One grant per owner and issuer: the reference is derived, so a retried registration lands on
    // the same row instead of leaving a second credential behind.
    this.newCredentialRef = options.newCredentialRef
      ?? ((input) => `taskcred_${createHash('sha256').update(`${input.issuer}\u0000${input.ownerWebId}`).digest('hex').slice(0, 32)}`);
    this.ready = ensureTaskCredentialTables(this.db).catch((error: unknown) => {
      this.initError = error;
    });
  }

  /** Grant, or idempotently re-grant, a credential for one user and issuer. */
  public async grant(input: GrantTaskCredentialInput): Promise<TaskCredentialSummary> {
    await this.ensureReady();
    const credentialRef = input.credentialRef ?? this.newCredentialRef(input);
    const existing = await this.findRow(credentialRef);
    if (existing) {
      if (String(existing.ownerWebId) !== input.ownerWebId || String(existing.issuer) !== input.issuer) {
        throw new Error(TASK_CREDENTIAL_OWNER_MISMATCH);
      }
      // The same reference with the same secret is a retry, not a rotation: keep the version.
      const lease = await this.openRow(existing);
      if (lease.clientId === input.clientId && lease.clientSecret === input.clientSecret) {
        if (input.status === 'active' && String(existing.status) === 'pending') {
          return await this.activate(credentialRef);
        }
        return this.toSummary(existing);
      }
      return await this.rotate(credentialRef, {
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        expectedVersion: Number(existing.credentialVersion),
      });
    }

    const sealed = await this.seal({ credentialRef, ownerWebId: input.ownerWebId, issuer: input.issuer, clientId: input.clientId, clientSecret: input.clientSecret });
    const createdAt = toDbTimestamp(this.db, this.now());
    await this.db.insert(this.table).values({
      credentialId: credentialRef,
      ownerWebId: input.ownerWebId,
      issuer: input.issuer,
      clientId: input.clientId,
      sealedSecret: sealed.sealedSecret,
      sealedSecretKeyId: sealed.keyId,
      credentialVersion: 1,
      status: input.status ?? 'pending',
      createdAt,
      rotatedAt: createdAt,
      ...(input.expiresAt ? { expiresAt: toDbTimestamp(this.db, input.expiresAt) } : {}),
    });
    this.logger.info(`Granted a task credential for ${input.ownerWebId} (${input.status ?? 'pending'})`);
    const created = await this.findRow(credentialRef);
    if (!created) {
      throw new Error(TASK_CREDENTIAL_NOT_FOUND);
    }
    return this.toSummary(created);
  }

  /** Confirm a grant so executions may use it. */
  public async activate(credentialRef: TaskCredentialRef): Promise<TaskCredentialSummary> {
    await this.ensureReady();
    const row = await this.requireRow(credentialRef);
    if (String(row.status) === 'revoked' || String(row.status) === 'expired') {
      throw new Error(TASK_CREDENTIAL_NOT_ACTIVE);
    }
    if (String(row.status) !== 'active') {
      await this.db
        .update(this.table)
        .set({ status: 'active' })
        .where(eq(this.table.credentialId, credentialRef));
    }
    return this.toSummary(await this.requireRow(credentialRef));
  }

  /** Replace the secret, bumping the version so older bindings stop matching. */
  public async rotate(
    credentialRef: TaskCredentialRef,
    input: { clientId: string; clientSecret: string; expectedVersion: number },
  ): Promise<TaskCredentialSummary> {
    await this.ensureReady();
    const row = await this.requireRow(credentialRef);
    if (Number(row.credentialVersion) !== input.expectedVersion) {
      throw new Error(`${TASK_CREDENTIAL_VERSION_CONFLICT}:${row.credentialVersion}`);
    }
    const sealed = await this.seal({
      credentialRef,
      ownerWebId: String(row.ownerWebId),
      issuer: String(row.issuer),
      clientId: input.clientId,
      clientSecret: input.clientSecret,
    });
    const nextVersion = input.expectedVersion + 1;
    await this.db
      .update(this.table)
      .set({
        clientId: input.clientId,
        sealedSecret: sealed.sealedSecret,
        sealedSecretKeyId: sealed.keyId,
        credentialVersion: nextVersion,
        status: 'active',
        rotatedAt: toDbTimestamp(this.db, this.now()),
      })
      .where(and(eq(this.table.credentialId, credentialRef), eq(this.table.credentialVersion, input.expectedVersion)));
    const rotated = await this.requireRow(credentialRef);
    if (Number(rotated.credentialVersion) !== nextVersion) {
      throw new Error(`${TASK_CREDENTIAL_VERSION_CONFLICT}:${rotated.credentialVersion}`);
    }
    this.logger.info(`Rotated task credential ${credentialRef} to version ${nextVersion}`);
    return this.toSummary(rotated);
  }

  /** Stop using a grant without losing its history. */
  public async revoke(credentialRef: TaskCredentialRef): Promise<void> {
    await this.ensureReady();
    await this.requireRow(credentialRef);
    await this.db
      .update(this.table)
      .set({ status: 'revoked' })
      .where(eq(this.table.credentialId, credentialRef));
  }

  /**
   * Open the credential for one execution.
   *
   * Everything that makes a grant usable is checked here: the owner the caller claims, the status,
   * the version the binding froze, and the expiry. A refusal keeps its own reason code so the
   * caller can tell a revoked grant from a stale one.
   */
  public async lease(input: {
    credentialRef: TaskCredentialRef;
    ownerWebId: string;
    version?: number;
    /** Check the version without extending `last_used_at`. */
    recordUsage?: boolean;
  }): Promise<TaskCredentialLease> {
    await this.ensureReady();
    const row = await this.requireRow(input.credentialRef);
    if (String(row.ownerWebId) !== input.ownerWebId) {
      throw new Error(TASK_CREDENTIAL_OWNER_MISMATCH);
    }
    if (input.version !== undefined && Number(row.credentialVersion) !== input.version) {
      throw new Error(`${TASK_CREDENTIAL_VERSION_CONFLICT}:${row.credentialVersion}`);
    }
    const expiresAt = fromDbTimestamp(row.expiresAt);
    if (expiresAt && expiresAt.getTime() <= this.now().getTime()) {
      await this.db.update(this.table).set({ status: 'expired' }).where(eq(this.table.credentialId, input.credentialRef));
      throw new Error(`${TASK_CREDENTIAL_NOT_ACTIVE}:expired`);
    }
    if (String(row.status) !== 'active') {
      throw new Error(`${TASK_CREDENTIAL_NOT_ACTIVE}:${String(row.status)}`);
    }
    if (input.recordUsage !== false) {
      await this.db
        .update(this.table)
        .set({ lastUsedAt: toDbTimestamp(this.db, this.now()) })
        .where(eq(this.table.credentialId, input.credentialRef));
    }
    const opened = await this.openRow(row);
    return {
      credentialRef: input.credentialRef,
      ownerWebId: String(row.ownerWebId),
      issuer: String(row.issuer),
      version: Number(row.credentialVersion),
      clientId: opened.clientId,
      clientSecret: opened.clientSecret,
    };
  }

  /** Metadata for one user's grants; never a secret. */
  public async listForOwner(ownerWebId: string): Promise<TaskCredentialSummary[]> {
    await this.ensureReady();
    const rows = await this.db
      .select()
      .from(this.table)
      .where(eq(this.table.ownerWebId, ownerWebId));
    return (rows as any[]).map((row) => this.toSummary(row));
  }

  /** The rows whose secret was sealed with a key that is no longer active. */
  public async listNeedingRewrap(activeKeyId: string): Promise<TaskCredentialRef[]> {
    await this.ensureReady();
    const rows = await this.db.select().from(this.table) as any[];
    return rows
      .filter((row) => String(row.sealedSecretKeyId) !== activeKeyId)
      .map((row) => String(row.credentialId));
  }

  private async seal(input: {
    credentialRef: TaskCredentialRef;
    ownerWebId: string;
    issuer: string;
    clientId: string;
    clientSecret: string;
  }): Promise<{ sealedSecret: string; keyId: string }> {
    let plaintext: Uint8Array | undefined;
    try {
      plaintext = new TextEncoder().encode(JSON.stringify({
        clientId: input.clientId,
        clientSecret: input.clientSecret,
      }));
      const envelope = await this.vault.seal(plaintext, {
        ownerWebId: input.ownerWebId,
        resourceIri: `urn:xpod:task-credential:${input.credentialRef}`,
        predicate: 'urn:xpod:taskCredential:sealedSecret',
        field: 'clientSecret',
        schemaVersion: 'v1',
        provider: input.issuer,
      });
      return { sealedSecret: JSON.stringify(envelope), keyId: envelope.wrappedDek.keyId };
    } catch (error) {
      this.logger.error(`Task credential encryption failed for ${input.ownerWebId}: ${String(error)}`);
      throw new Error(TASK_CREDENTIAL_ENCRYPTION_FAILED);
    } finally {
      plaintext?.fill(0);
    }
  }

  private async openRow(row: any): Promise<{ clientId: string; clientSecret: string }> {
    let plaintext: Uint8Array | undefined;
    try {
      const envelope = JSON.parse(String(row.sealedSecret));
      plaintext = await this.vault.open(envelope, {
        ownerWebId: String(row.ownerWebId),
        resourceIri: `urn:xpod:task-credential:${String(row.credentialId)}`,
        predicate: 'urn:xpod:taskCredential:sealedSecret',
        field: 'clientSecret',
        schemaVersion: 'v1',
        provider: String(row.issuer),
      });
      const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as { clientId?: unknown; clientSecret?: unknown };
      if (typeof parsed.clientId !== 'string' || typeof parsed.clientSecret !== 'string') {
        throw new Error('decrypted task credential is not a client credential');
      }
      return { clientId: parsed.clientId, clientSecret: parsed.clientSecret };
    } catch (error) {
      this.logger.error(`Task credential could not be opened for ${String(row.ownerWebId)}: ${String(error)}`);
      throw new Error(TASK_CREDENTIAL_ENCRYPTION_FAILED);
    } finally {
      plaintext?.fill(0);
    }
  }

  private async findRow(credentialRef: TaskCredentialRef): Promise<any | undefined> {
    const rows = await this.db
      .select()
      .from(this.table)
      .where(eq(this.table.credentialId, credentialRef))
      .limit(1);
    return (rows as any[])[0];
  }

  private async requireRow(credentialRef: TaskCredentialRef): Promise<any> {
    const row = await this.findRow(credentialRef);
    if (!row) {
      throw new Error(TASK_CREDENTIAL_NOT_FOUND);
    }
    return row;
  }

  private toSummary(row: any): TaskCredentialSummary {
    return {
      credentialRef: String(row.credentialId),
      ownerWebId: String(row.ownerWebId),
      issuer: String(row.issuer),
      clientId: String(row.clientId),
      version: Number(row.credentialVersion),
      status: String(row.status) as TaskCredentialStatus,
      createdAt: fromDbTimestamp(row.createdAt) ?? this.now(),
      ...(fromDbTimestamp(row.rotatedAt) ? { rotatedAt: fromDbTimestamp(row.rotatedAt) } : {}),
      ...(fromDbTimestamp(row.lastUsedAt) ? { lastUsedAt: fromDbTimestamp(row.lastUsedAt) } : {}),
      ...(fromDbTimestamp(row.expiresAt) ? { expiresAt: fromDbTimestamp(row.expiresAt) } : {}),
    };
  }

  private async ensureReady(): Promise<void> {
    await this.ready;
    if (this.initError) {
      throw this.initError instanceof Error
        ? this.initError
        : new Error(`task_credential_table_unavailable:${String(this.initError)}`);
    }
  }
}
