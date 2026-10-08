import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { executeQuery, executeStatement, getIdentityDatabase, isDatabaseSqlite, executePostgresLockedStatements, jsonFieldEquals, type IdentityDatabase } from './db';
import type { PodDeletionPlan } from '../../service/PodDataDeletionService';

export interface PodDeletionTarget {
  accountId: string;
  podId: string;
  storageUrl: string;
  nodeId: string;
  ownerWebIds?: string[];
  remotePodId?: string;
}
export interface PodDeletionOperation extends PodDeletionTarget {
  operationId: string;
  action: 'delete-pod';
  state: 'pending' | 'claimed' | 'completed';
  expiresAt: number;
  plan?: PodDeletionPlan;
}
export interface PodDeletionAuthorization {
  challengeId: string;
  accountId: string;
  podId: string;
  nodeId: string;
  storageUrl: string;
  expiresAt: number;
  returnUrl: string;
}
interface StoredOperation { payload: string; }

/** Cross-process durable target records. State changes are SQL compare-and-set. */
export class PodDeletionOperationRepository {
  private readonly db: IdentityDatabase;
  private readonly ready: Promise<void>;

  public constructor(identityDbUrl: string) {
    this.db = getIdentityDatabase(identityDbUrl);
    this.ready = this.initialize();
  }

  private async initialize(): Promise<void> {
    const statements = [
      `CREATE TABLE IF NOT EXISTS pod_deletion_authorization (
        challenge_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, payload TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS pod_deletion_operation (
        operation_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, pod_id TEXT NOT NULL,
        grant_hash TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL,
        UNIQUE(account_id, pod_id)
      )`,
      `CREATE TABLE IF NOT EXISTS pod_remote_generation (
        pod_id TEXT PRIMARY KEY, node_id TEXT NOT NULL, storage_url TEXT NOT NULL, remote_pod_id TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS pod_lifecycle_reservation (
        storage_url TEXT PRIMARY KEY, operation_id TEXT NOT NULL, kind TEXT NOT NULL
      )`,
    ];
    if (isDatabaseSqlite(this.db)) {
      for (const statement of statements) { await executeStatement(this.db, sql.raw(statement)); }
    } else {
      await executePostgresLockedStatements(this.db, 1_936_528_504, statements);
    }
  }

  public async createAuthorization(target: Omit<PodDeletionAuthorization, 'challengeId' | 'expiresAt'>): Promise<{ challenge: string; details: PodDeletionAuthorization }> {
    await this.ready;
    const token = randomBytes(32).toString('base64url');
    const details: PodDeletionAuthorization = { ...target, challengeId: randomUUID(), expiresAt: Date.now() + 300_000 };
    await executeStatement(this.db, sql`INSERT INTO pod_deletion_authorization(challenge_id,token_hash,payload)
      VALUES (${details.challengeId},${hash(token)},${JSON.stringify(details)})`);
    return { challenge: `${details.challengeId}.${token}`, details };
  }

  public async authorizationDetails(challenge: string, nodeId: string): Promise<PodDeletionAuthorization | undefined> {
    await this.ready;
    const [id, token, extra] = challenge.split('.');
    if (!id || !token || extra || !/^[a-zA-Z0-9_-]{43}$/u.test(token)) { return; }
    const rows = await executeQuery<StoredOperation>(this.db, sql`SELECT payload FROM pod_deletion_authorization
      WHERE challenge_id=${id} AND token_hash=${hash(token)}`);
    const details = rows.rows[0] ? JSON.parse(rows.rows[0].payload) as PodDeletionAuthorization : undefined;
    return details && details.nodeId === nodeId && details.expiresAt > Date.now() ? details : undefined;
  }

  /** The unique Pod generation insert is both nonce consumption and capability creation: no get/delete gap. */
  public async authorizeGeneration(challenge: string, nodeId: string, remotePodId: string): Promise<boolean> {
    const details = await this.authorizationDetails(challenge, nodeId);
    if (!details || !remotePodId) { return false; }
    const [id, token] = challenge.split('.');
    const result = await executeQuery(this.db, sql`INSERT INTO pod_remote_generation(pod_id,node_id,storage_url,remote_pod_id)
      SELECT ${details.podId},${nodeId},${details.storageUrl},${remotePodId}
      FROM pod_deletion_authorization auth_challenge
      WHERE auth_challenge.challenge_id=${id} AND auth_challenge.token_hash=${hash(token)}
        AND auth_challenge.payload=${JSON.stringify(details)} AND ${details.expiresAt} > ${Date.now()}
        AND NOT EXISTS (SELECT 1 FROM pod_deletion_operation WHERE pod_id=${details.podId})
        AND EXISTS (SELECT 1 FROM identity_store WHERE container='pod' AND id=${details.podId}
          AND ${jsonFieldEquals(this.db, 'accountId', details.accountId)} AND ${jsonFieldEquals(this.db, 'baseUrl', details.storageUrl)})
      ON CONFLICT(pod_id) DO NOTHING RETURNING pod_id`);
    return result.rows.length === 1;
  }

  public async reserveStorage(storageUrl: string, operationId: string, kind: 'create' | 'delete' | 'repair'): Promise<void> {
    await this.ready;
    await executeStatement(this.db, sql`INSERT INTO pod_lifecycle_reservation(storage_url, operation_id, kind)
      VALUES (${storageUrl}, ${operationId}, ${kind}) ON CONFLICT DO NOTHING`);
    const result = await executeQuery<{ operation_id: string; kind: string }>(this.db, sql`SELECT operation_id, kind FROM pod_lifecycle_reservation WHERE storage_url = ${storageUrl}`);
    if (result.rows[0]?.operation_id !== operationId || result.rows[0]?.kind !== kind) { throw new Error('Pod lifecycle operation already in progress'); }
  }

  public async releaseStorage(storageUrl: string, operationId: string): Promise<void> {
    await this.ready;
    await executeStatement(this.db, sql`DELETE FROM pod_lifecycle_reservation WHERE storage_url = ${storageUrl} AND operation_id = ${operationId}`);
  }

  public async create(target: PodDeletionTarget): Promise<{ operation: PodDeletionOperation; grant: string }> {
    await this.ready;
    const grant = randomBytes(32).toString('base64url');
    const operation: PodDeletionOperation = {
      ...target, operationId: randomUUID(), action: 'delete-pod', state: 'pending', expiresAt: Date.now() + 300_000,
    };
    const result = await executeQuery(this.db, sql`INSERT INTO pod_deletion_operation
      (operation_id, account_id, pod_id, grant_hash, state, payload)
      VALUES (${operation.operationId}, ${target.accountId}, ${target.podId}, ${hash(grant)}, 'pending', ${JSON.stringify(operation)})
      ON CONFLICT(account_id, pod_id) DO NOTHING RETURNING payload`);
    if (!result.rows.length) { throw new Error('Pod deletion operation already exists'); }
    return { operation, grant };
  }

  public async bindRemoteGeneration(podId: string, nodeId: string, storageUrl: string, remotePodId: string): Promise<void> {
    await this.ready;
    await executeStatement(this.db, sql`INSERT INTO pod_remote_generation(pod_id,node_id,storage_url,remote_pod_id)
      VALUES (${podId},${nodeId},${storageUrl},${remotePodId}) ON CONFLICT(pod_id) DO NOTHING`);
  }

  public async remoteGeneration(podId: string, nodeId: string, storageUrl: string): Promise<string | undefined> {
    await this.ready;
    const result = await executeQuery<{ remote_pod_id: string }>(this.db, sql`SELECT remote_pod_id FROM pod_remote_generation
      WHERE pod_id=${podId} AND node_id=${nodeId} AND storage_url=${storageUrl}`);
    return result.rows[0]?.remote_pod_id;
  }

  public async blocksNamespaceMutation(baseUrl: string): Promise<boolean> {
    await this.ready;
    const result = await executeQuery<StoredOperation>(this.db, sql`SELECT payload FROM pod_deletion_operation WHERE state <> 'completed'`);
    return result.rows.some((row) => (JSON.parse(row.payload) as PodDeletionOperation).storageUrl.startsWith(baseUrl));
  }

  public async namespaceDeletionRevision(baseUrl: string): Promise<string> {
    await this.ready;
    const result = await executeQuery<StoredOperation>(this.db, sql`SELECT payload FROM pod_deletion_operation`);
    return result.rows.map((row) => JSON.parse(row.payload) as PodDeletionOperation)
      .filter((operation) => operation.storageUrl.startsWith(baseUrl))
      .map((operation) => `${operation.operationId}:${operation.state}`).sort().join('\n');
  }

  public async blocksMutation(resourceUrl: string): Promise<boolean> {
    await this.ready;
    const result = await executeQuery<StoredOperation>(this.db, sql`SELECT payload FROM pod_deletion_operation WHERE state <> 'completed'`);
    return result.rows.some((row) => resourceUrl.startsWith((JSON.parse(row.payload) as PodDeletionOperation).storageUrl));
  }

  public async renewGrant(operationId: string): Promise<{ operation: PodDeletionOperation; grant: string }> {
    const existing = await this.get(operationId);
    if (!existing || existing.state === 'completed') { throw new Error('Deletion grant cannot be renewed'); }
    const grant = randomBytes(32).toString('base64url');
    const operation = { ...existing, expiresAt: Date.now() + 300_000 };
    const result = await executeQuery(this.db, sql`UPDATE pod_deletion_operation
      SET grant_hash = ${hash(grant)}, payload = ${JSON.stringify(operation)}
      WHERE operation_id = ${operationId} AND payload = ${JSON.stringify(existing)} RETURNING operation_id`);
    if (!result.rows.length) { throw new Error('Deletion grant changed concurrently'); }
    return { operation, grant };
  }

  public async acknowledge(operationId: string, nodeId: string, grant: string, storageUrl: string): Promise<boolean> {
    const existing = await this.get(operationId);
    if (!existing || existing.nodeId !== nodeId || existing.storageUrl !== storageUrl) { return false; }
    const completed = { ...existing, state: 'completed' as const };
    const result = await executeQuery(this.db, sql`UPDATE pod_deletion_operation
      SET state = 'completed', payload = ${JSON.stringify(completed)}
      WHERE operation_id = ${operationId} AND grant_hash = ${hash(grant)} AND state IN ('claimed', 'completed')
      RETURNING operation_id`);
    return result.rows.length === 1;
  }

  /** Import the authenticated command once on the Local runtime. */
  public async createLocal(target: PodDeletionTarget, operationId: string): Promise<PodDeletionOperation> {
    await this.ready;
    const existing = await this.get(operationId);
    if (existing) {
      if (existing.storageUrl !== target.storageUrl || existing.nodeId !== target.nodeId) {
        throw new Error('Deletion operation target mismatch');
      }
      return existing;
    }
    const operation: PodDeletionOperation = {
      ...target, operationId, action: 'delete-pod', state: 'pending', expiresAt: Number.MAX_SAFE_INTEGER,
    };
    await executeStatement(this.db, sql`INSERT INTO pod_deletion_operation
      (operation_id, account_id, pod_id, grant_hash, state, payload)
      VALUES (${operationId}, ${target.accountId}, ${target.podId}, '', 'pending', ${JSON.stringify(operation)})
      ON CONFLICT DO NOTHING`);
    const stored = await this.get(operationId);
    if (!stored || stored.storageUrl !== target.storageUrl) { throw new Error('Pod deletion already in progress'); }
    return stored;
  }

  public async find(accountId: string, podId: string): Promise<PodDeletionOperation | undefined> {
    await this.ready;
    const result = await executeQuery<StoredOperation>(this.db, sql`SELECT payload FROM pod_deletion_operation
      WHERE account_id = ${accountId} AND pod_id = ${podId}`);
    return result.rows[0] ? JSON.parse(result.rows[0].payload) : undefined;
  }

  public async get(operationId: string): Promise<PodDeletionOperation | undefined> {
    await this.ready;
    const result = await executeQuery<StoredOperation>(this.db, sql`SELECT payload FROM pod_deletion_operation
      WHERE operation_id = ${operationId}`);
    return result.rows[0] ? JSON.parse(result.rows[0].payload) : undefined;
  }

  /** Only the authenticated node and exact grant can claim; repeated claims return the same immutable target. */
  public async claim(operationId: string, nodeId: string, grant: string): Promise<PodDeletionOperation | undefined> {
    await this.ready;
    const existing = await this.get(operationId);
    if (!existing || existing.nodeId !== nodeId || existing.expiresAt < Date.now()) { return; }
    const claimed = { ...existing, state: 'claimed' as const };
    const result = await executeQuery<StoredOperation>(this.db, sql`UPDATE pod_deletion_operation
      SET state = 'claimed', payload = ${JSON.stringify(claimed)}
      WHERE operation_id = ${operationId} AND grant_hash = ${hash(grant)} AND state IN ('pending', 'claimed')
      RETURNING payload`);
    return result.rows[0] ? JSON.parse(result.rows[0].payload) : undefined;
  }

  /** Persist the complete snapshot before the first destructive operation. */
  public async savePlan(operationId: string, plan: PodDeletionPlan): Promise<PodDeletionOperation> {
    const existing = await this.get(operationId);
    if (!existing || existing.state === 'completed' || plan.baseUrl !== existing.storageUrl) {
      throw new Error('Invalid Pod deletion operation plan');
    }
    if (existing.plan) { return existing; }
    const updated = { ...existing, plan, state: 'claimed' as const };
    await executeStatement(this.db, sql`UPDATE pod_deletion_operation SET payload = ${JSON.stringify(updated)}, state = 'claimed'
      WHERE operation_id = ${operationId} AND payload = ${JSON.stringify(existing)}`);
    return (await this.get(operationId))!;
  }

  public async complete(operationId: string): Promise<void> {
    const existing = await this.get(operationId);
    if (!existing) { throw new Error('Unknown Pod deletion operation'); }
    if (existing.state === 'completed') { return; }
    const completed = { ...existing, state: 'completed' as const };
    const result = await executeQuery(this.db, sql`UPDATE pod_deletion_operation
      SET state = 'completed', payload = ${JSON.stringify(completed)}
      WHERE operation_id = ${operationId} AND state = 'claimed' AND payload = ${JSON.stringify(existing)} RETURNING operation_id`);
    if (!result.rows.length) { throw new Error('Pod deletion operation changed concurrently'); }
  }
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
