import { sql } from 'drizzle-orm';
import type { IdentityDatabase } from '../identity/drizzle/db';
import {
  executePostgresLockedStatements,
  executeQuery,
  executeStatement,
  fromDbTimestamp,
  toDbTimestamp,
} from '../identity/drizzle/db';

export type RdfSearchReconciliationState =
  | 'waiting-config'
  | 'retryable'
  | 'blocked-config'
  | 'applied'
  | 'ready'
  | 'in-progress';

export interface RdfSearchDesiredProfile {
  providerId: string;
  model: string;
  modelVersion?: string;
  configFingerprint: string;
  sourceHash?: string;
  sourceVersion?: string;
}

export interface RdfSearchReconciliationInput extends RdfSearchDesiredProfile {
  sourceKey: string;
  sourceUri: string;
  podRoot: string;
  reason: string;
}

export interface RdfSearchRetryableInput extends RdfSearchReconciliationInput {
  failureCategory: string;
  nextAttemptAt: Date;
}

export interface RdfSearchAppliedInput extends RdfSearchReconciliationInput {}

export interface RdfSearchBlockedConfigInput extends RdfSearchReconciliationInput {
  failureCategory: string;
}

export interface RdfSearchConfigWaitInput {
  sourceKey: string;
  sourceUri: string;
  podRoot: string;
  sourceHash?: string;
  sourceVersion?: string;
  reason: string;
  failureCategory?: string;
}

export interface RdfSearchReconciliationRow {
  sourceKey: string;
  sourceUri: string;
  podRoot: string;
  providerId?: string;
  model?: string;
  modelVersion?: string;
  configFingerprint?: string;
  sourceHash?: string;
  sourceVersion?: string;
  state: RdfSearchReconciliationState;
  reason: string;
  attemptCount: number;
  nextAttemptAt: Date;
  leaseOwner?: string;
  leaseExpiresAt?: Date;
  failureCategory?: string;
  updatedAt: Date;
}

interface RdfSearchReconciliationDbRow {
  source_key: string;
  source_uri: string;
  pod_root: string;
  provider_id: string | null;
  model: string | null;
  model_version: string | null;
  config_fingerprint: string | null;
  source_hash: string | null;
  source_version: string | null;
  state: RdfSearchReconciliationState;
  reason: string;
  attempt_count: number;
  next_attempt_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  failure_category: string | null;
  updated_at: string;
}

const PG_RDF_SEARCH_RECONCILIATION_SCHEMA_LOCK_KEY = 1_936_528_502;

/**
 * Durable product queue for RDF FTS/VEC parity work.
 *
 * SolidFS writes may complete before the user's Pod has an embedding profile or
 * provider quota. This repository keeps one desired embedding profile per
 * source so skipped vector indexing remains recoverable after config, quota, or
 * model changes.
 */
export class RdfSearchReconciliationRepository {
  private readonly ready: Promise<void>;

  public constructor(private readonly db: IdentityDatabase) {
    this.ready = this.initialize();
  }

  public async waitForConfig(input: RdfSearchConfigWaitInput, now = new Date()): Promise<RdfSearchReconciliationRow> {
    await this.ready;
    await this.assertSourceIdentity(input);
    const ts = timestampText(this.db, now);
    const result = await executeQuery<RdfSearchReconciliationDbRow>(this.db, sql`
      INSERT INTO rdf_search_reconciliation (
        source_key,
        source_uri,
        pod_root,
        provider_id,
        model,
        model_version,
        config_fingerprint,
        source_hash,
        source_version,
        state,
        reason,
        attempt_count,
        next_attempt_at,
        lease_owner,
        lease_expires_at,
        failure_category,
        updated_at
      ) VALUES (
        ${input.sourceKey},
        ${input.sourceUri},
        ${input.podRoot},
        NULL,
        NULL,
        NULL,
        NULL,
        ${input.sourceHash ?? null},
        ${input.sourceVersion ?? null},
        'waiting-config',
        ${input.reason},
        0,
        ${ts},
        NULL,
        NULL,
        ${input.failureCategory ?? null},
        ${ts}
      )
      ON CONFLICT (source_key) DO UPDATE SET
        source_uri = excluded.source_uri,
        state = 'waiting-config',
        source_hash = excluded.source_hash,
        source_version = excluded.source_version,
        reason = excluded.reason,
        lease_owner = NULL,
        lease_expires_at = NULL,
        failure_category = excluded.failure_category,
        updated_at = excluded.updated_at
      WHERE rdf_search_reconciliation.pod_root = excluded.pod_root
      RETURNING
        source_key,
        source_uri,
        pod_root,
        provider_id,
        model,
        model_version,
        config_fingerprint,
        source_hash,
        source_version,
        state,
        reason,
        attempt_count,
        next_attempt_at,
        lease_owner,
        lease_expires_at,
        failure_category,
        updated_at
    `);

    if (!result.rows[0]) {
      throw new Error(`RDF search reconciliation pod root is immutable for source key ${input.sourceKey}`);
    }
    return mapRow(result.rows[0]);
  }

  public async upsertDesired(input: RdfSearchReconciliationInput, now = new Date()): Promise<RdfSearchReconciliationRow> {
    await this.ready;
    const ts = timestampText(this.db, now);
    const existing = await this.get(input.sourceKey);
    assertSourceIdentity(existing, input);
    const desiredChanged = hasDesiredChanged(existing, input);
    const previousAttemptCount = existing?.attemptCount ?? 0;
    const previousFailureCategory = existing?.failureCategory ?? null;
    const attemptCount = desiredChanged ? 0 : previousAttemptCount;
    const failureCategory = desiredChanged ? null : previousFailureCategory;
    const nextState: RdfSearchReconciliationState = !desiredChanged && existing?.state === 'applied'
      ? 'applied'
      : 'ready';

    const result = await executeQuery<RdfSearchReconciliationDbRow>(this.db, sql`
      INSERT INTO rdf_search_reconciliation (
        source_key,
        source_uri,
        pod_root,
        provider_id,
        model,
        model_version,
        config_fingerprint,
        source_hash,
        source_version,
        state,
        reason,
        attempt_count,
        next_attempt_at,
        lease_owner,
        lease_expires_at,
        failure_category,
        updated_at
      ) VALUES (
        ${input.sourceKey},
        ${input.sourceUri},
        ${input.podRoot},
        ${input.providerId},
        ${input.model},
        ${input.modelVersion ?? null},
        ${input.configFingerprint},
        ${input.sourceHash ?? null},
        ${input.sourceVersion ?? null},
        ${nextState},
        ${input.reason},
        ${attemptCount},
        ${ts},
        NULL,
        NULL,
        ${failureCategory},
        ${ts}
      )
      ON CONFLICT (source_key) DO UPDATE SET
        source_uri = excluded.source_uri,
        provider_id = excluded.provider_id,
        model = excluded.model,
        model_version = excluded.model_version,
        config_fingerprint = excluded.config_fingerprint,
        source_hash = excluded.source_hash,
        source_version = excluded.source_version,
        state = excluded.state,
        reason = excluded.reason,
        attempt_count = excluded.attempt_count,
        next_attempt_at = excluded.next_attempt_at,
        lease_owner = NULL,
        lease_expires_at = NULL,
        failure_category = excluded.failure_category,
        updated_at = excluded.updated_at
      WHERE rdf_search_reconciliation.pod_root = excluded.pod_root
      RETURNING
        source_key,
        source_uri,
        pod_root,
        provider_id,
        model,
        model_version,
        config_fingerprint,
        source_hash,
        source_version,
        state,
        reason,
        attempt_count,
        next_attempt_at,
        lease_owner,
        lease_expires_at,
        failure_category,
        updated_at
    `);

    if (!result.rows[0]) {
      throw new Error(`RDF search reconciliation pod root is immutable for source key ${input.sourceKey}`);
    }
    return mapRow(result.rows[0]);
  }

  public async upsertRetryable(input: RdfSearchRetryableInput, now = new Date()): Promise<RdfSearchReconciliationRow> {
    await this.ready;
    const ts = timestampText(this.db, now);
    const existing = await this.get(input.sourceKey);
    assertSourceIdentity(existing, input);
    const desiredChanged = hasDesiredChanged(existing, input);
    const previousAttemptCount = existing?.attemptCount ?? 0;
    const attemptCount = desiredChanged ? 1 : previousAttemptCount + 1;

    const result = await executeQuery<RdfSearchReconciliationDbRow>(this.db, sql`
      INSERT INTO rdf_search_reconciliation (
        source_key,
        source_uri,
        pod_root,
        provider_id,
        model,
        model_version,
        config_fingerprint,
        source_hash,
        source_version,
        state,
        reason,
        attempt_count,
        next_attempt_at,
        lease_owner,
        lease_expires_at,
        failure_category,
        updated_at
      ) VALUES (
        ${input.sourceKey},
        ${input.sourceUri},
        ${input.podRoot},
        ${input.providerId},
        ${input.model},
        ${input.modelVersion ?? null},
        ${input.configFingerprint},
        ${input.sourceHash ?? null},
        ${input.sourceVersion ?? null},
        'retryable',
        ${input.reason},
        ${attemptCount},
        ${timestampText(this.db, input.nextAttemptAt)},
        NULL,
        NULL,
        ${input.failureCategory},
        ${ts}
      )
      ON CONFLICT (source_key) DO UPDATE SET
        source_uri = excluded.source_uri,
        provider_id = excluded.provider_id,
        model = excluded.model,
        model_version = excluded.model_version,
        config_fingerprint = excluded.config_fingerprint,
        source_hash = excluded.source_hash,
        source_version = excluded.source_version,
        state = 'retryable',
        reason = excluded.reason,
        attempt_count = excluded.attempt_count,
        next_attempt_at = excluded.next_attempt_at,
        lease_owner = NULL,
        lease_expires_at = NULL,
        failure_category = excluded.failure_category,
        updated_at = excluded.updated_at
      WHERE rdf_search_reconciliation.pod_root = excluded.pod_root
      RETURNING
        source_key,
        source_uri,
        pod_root,
        provider_id,
        model,
        model_version,
        config_fingerprint,
        source_hash,
        source_version,
        state,
        reason,
        attempt_count,
        next_attempt_at,
        lease_owner,
        lease_expires_at,
        failure_category,
        updated_at
    `);

    if (!result.rows[0]) {
      throw new Error(`RDF search reconciliation pod root is immutable for source key ${input.sourceKey}`);
    }
    return mapRow(result.rows[0]);
  }

  public async upsertApplied(input: RdfSearchAppliedInput, now = new Date()): Promise<RdfSearchReconciliationRow> {
    await this.ready;
    await this.assertSourceIdentity(input);
    const ts = timestampText(this.db, now);
    const result = await executeQuery<RdfSearchReconciliationDbRow>(this.db, sql`
      INSERT INTO rdf_search_reconciliation (
        source_key,
        source_uri,
        pod_root,
        provider_id,
        model,
        model_version,
        config_fingerprint,
        source_hash,
        source_version,
        state,
        reason,
        attempt_count,
        next_attempt_at,
        lease_owner,
        lease_expires_at,
        failure_category,
        updated_at
      ) VALUES (
        ${input.sourceKey},
        ${input.sourceUri},
        ${input.podRoot},
        ${input.providerId},
        ${input.model},
        ${input.modelVersion ?? null},
        ${input.configFingerprint},
        ${input.sourceHash ?? null},
        ${input.sourceVersion ?? null},
        'applied',
        ${input.reason},
        0,
        ${ts},
        NULL,
        NULL,
        NULL,
        ${ts}
      )
      ON CONFLICT (source_key) DO UPDATE SET
        source_uri = excluded.source_uri,
        provider_id = excluded.provider_id,
        model = excluded.model,
        model_version = excluded.model_version,
        config_fingerprint = excluded.config_fingerprint,
        source_hash = excluded.source_hash,
        source_version = excluded.source_version,
        state = 'applied',
        reason = excluded.reason,
        attempt_count = 0,
        next_attempt_at = excluded.next_attempt_at,
        lease_owner = NULL,
        lease_expires_at = NULL,
        failure_category = NULL,
        updated_at = excluded.updated_at
      WHERE rdf_search_reconciliation.pod_root = excluded.pod_root
      RETURNING
        source_key,
        source_uri,
        pod_root,
        provider_id,
        model,
        model_version,
        config_fingerprint,
        source_hash,
        source_version,
        state,
        reason,
        attempt_count,
        next_attempt_at,
        lease_owner,
        lease_expires_at,
        failure_category,
        updated_at
    `);

    if (!result.rows[0]) {
      throw new Error(`RDF search reconciliation pod root is immutable for source key ${input.sourceKey}`);
    }
    return mapRow(result.rows[0]);
  }

  public async upsertBlockedConfig(
    input: RdfSearchBlockedConfigInput,
    now = new Date(),
  ): Promise<RdfSearchReconciliationRow> {
    await this.ready;
    const existing = await this.get(input.sourceKey);
    assertSourceIdentity(existing, input);
    const attemptCount = hasDesiredChanged(existing, input)
      ? 0
      : existing?.attemptCount ?? 0;
    const ts = timestampText(this.db, now);
    const result = await executeQuery<RdfSearchReconciliationDbRow>(this.db, sql`
      INSERT INTO rdf_search_reconciliation (
        source_key,
        source_uri,
        pod_root,
        provider_id,
        model,
        model_version,
        config_fingerprint,
        source_hash,
        source_version,
        state,
        reason,
        attempt_count,
        next_attempt_at,
        lease_owner,
        lease_expires_at,
        failure_category,
        updated_at
      ) VALUES (
        ${input.sourceKey},
        ${input.sourceUri},
        ${input.podRoot},
        ${input.providerId},
        ${input.model},
        ${input.modelVersion ?? null},
        ${input.configFingerprint},
        ${input.sourceHash ?? null},
        ${input.sourceVersion ?? null},
        'blocked-config',
        ${input.reason},
        ${attemptCount},
        ${ts},
        NULL,
        NULL,
        ${input.failureCategory},
        ${ts}
      )
      ON CONFLICT (source_key) DO UPDATE SET
        source_uri = excluded.source_uri,
        provider_id = excluded.provider_id,
        model = excluded.model,
        model_version = excluded.model_version,
        config_fingerprint = excluded.config_fingerprint,
        source_hash = excluded.source_hash,
        source_version = excluded.source_version,
        state = 'blocked-config',
        reason = excluded.reason,
        attempt_count = excluded.attempt_count,
        next_attempt_at = excluded.next_attempt_at,
        lease_owner = NULL,
        lease_expires_at = NULL,
        failure_category = excluded.failure_category,
        updated_at = excluded.updated_at
      WHERE rdf_search_reconciliation.pod_root = excluded.pod_root
      RETURNING
        source_key,
        source_uri,
        pod_root,
        provider_id,
        model,
        model_version,
        config_fingerprint,
        source_hash,
        source_version,
        state,
        reason,
        attempt_count,
        next_attempt_at,
        lease_owner,
        lease_expires_at,
        failure_category,
        updated_at
    `);
    if (!result.rows[0]) {
      throw new Error(`RDF search reconciliation pod root is immutable for source key ${input.sourceKey}`);
    }
    return mapRow(result.rows[0]);
  }

  public async get(sourceKey: string): Promise<RdfSearchReconciliationRow | undefined> {
    await this.ready;
    const result = await executeQuery<RdfSearchReconciliationDbRow>(this.db, sql`
      SELECT
        source_key,
        source_uri,
        pod_root,
        provider_id,
        model,
        model_version,
        config_fingerprint,
        source_hash,
        source_version,
        state,
        reason,
        attempt_count,
        next_attempt_at,
        lease_owner,
        lease_expires_at,
        failure_category,
        updated_at
      FROM rdf_search_reconciliation
      WHERE source_key = ${sourceKey}
      LIMIT 1
    `);
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  public async listRunnable(now = new Date(), limit?: number): Promise<RdfSearchReconciliationRow[]> {
    await this.ready;
    const ts = timestampText(this.db, now);
    const rowLimit = limit && limit > 0 ? limit : undefined;
    const result = await executeQuery<RdfSearchReconciliationDbRow>(this.db, sql`
      SELECT
        source_key,
        source_uri,
        pod_root,
        provider_id,
        model,
        model_version,
        config_fingerprint,
        source_hash,
        source_version,
        state,
        reason,
        attempt_count,
        next_attempt_at,
        lease_owner,
        lease_expires_at,
        failure_category,
        updated_at
      FROM rdf_search_reconciliation
      WHERE next_attempt_at <= ${ts}
        AND (
          state IN ('ready', 'retryable')
          OR (
            state = 'in-progress'
            AND lease_owner IS NOT NULL
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at <= ${ts}
          )
        )
      ORDER BY next_attempt_at ASC, source_key ASC
      ${rowLimit ? sql`LIMIT ${rowLimit}` : sql``}
    `);
    return result.rows.map(mapRow);
  }

  public async claimNext(workerId: string, now = new Date(), leaseDurationMs = 60_000): Promise<RdfSearchReconciliationRow | undefined> {
    await this.ready;
    const ts = timestampText(this.db, now);
    const leaseExpiresAt = timestampText(this.db, new Date(now.getTime() + leaseDurationMs));
    const result = await executeQuery<RdfSearchReconciliationDbRow>(this.db, sql`
      UPDATE rdf_search_reconciliation
      SET state = 'in-progress',
          lease_owner = ${workerId},
          lease_expires_at = ${leaseExpiresAt},
          updated_at = ${ts}
      WHERE source_key = (
        SELECT source_key
        FROM rdf_search_reconciliation
        WHERE next_attempt_at <= ${ts}
          AND (
            state IN ('ready', 'retryable')
            OR (
              state = 'in-progress'
              AND lease_owner IS NOT NULL
              AND lease_expires_at IS NOT NULL
              AND lease_expires_at <= ${ts}
            )
          )
        ORDER BY next_attempt_at ASC, source_key ASC
        LIMIT 1
      )
      RETURNING
        source_key,
        source_uri,
        pod_root,
        provider_id,
        model,
        model_version,
        config_fingerprint,
        source_hash,
        source_version,
        state,
        reason,
        attempt_count,
        next_attempt_at,
        lease_owner,
        lease_expires_at,
        failure_category,
        updated_at
    `);

    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  public async markRetryable(
    sourceKey: string,
    workerId: string,
    failureCategory: string,
    nextAttemptAt: Date,
    now = new Date(),
  ): Promise<void> {
    await this.ready;
    const result = await executeQuery<RdfSearchReconciliationDbRow>(this.db, sql`
      UPDATE rdf_search_reconciliation
      SET state = 'retryable',
          attempt_count = attempt_count + 1,
          next_attempt_at = ${timestampText(this.db, nextAttemptAt)},
          lease_owner = NULL,
          lease_expires_at = NULL,
          failure_category = ${failureCategory},
          updated_at = ${timestampText(this.db, now)}
      WHERE source_key = ${sourceKey}
        AND state = 'in-progress'
        AND lease_owner = ${workerId}
        AND lease_expires_at > ${timestampText(this.db, now)}
      RETURNING
        source_key,
        source_uri,
        pod_root,
        provider_id,
        model,
        model_version,
        config_fingerprint,
        source_hash,
        source_version,
        state,
        reason,
        attempt_count,
        next_attempt_at,
        lease_owner,
        lease_expires_at,
        failure_category,
        updated_at
    `);
    if (!result.rows[0]) {
      throw new Error(`RDF search reconciliation ownership mismatch for source key ${sourceKey}`);
    }
  }

  public async markBlockedConfig(
    sourceKey: string,
    workerId: string,
    failureCategory: string,
    now = new Date(),
  ): Promise<void> {
    await this.ready;
    const result = await executeQuery<RdfSearchReconciliationDbRow>(this.db, sql`
      UPDATE rdf_search_reconciliation
      SET state = 'blocked-config',
          lease_owner = NULL,
          lease_expires_at = NULL,
          failure_category = ${failureCategory},
          updated_at = ${timestampText(this.db, now)}
      WHERE source_key = ${sourceKey}
        AND state = 'in-progress'
        AND lease_owner = ${workerId}
        AND lease_expires_at > ${timestampText(this.db, now)}
      RETURNING
        source_key,
        source_uri,
        pod_root,
        provider_id,
        model,
        model_version,
        config_fingerprint,
        source_hash,
        source_version,
        state,
        reason,
        attempt_count,
        next_attempt_at,
        lease_owner,
        lease_expires_at,
        failure_category,
        updated_at
    `);
    if (!result.rows[0]) {
      throw new Error(`RDF search reconciliation ownership mismatch for source key ${sourceKey}`);
    }
  }

  public async complete(sourceKey: string, workerId: string, now = new Date()): Promise<void> {
    await this.ready;
    const result = await executeQuery<RdfSearchReconciliationDbRow>(this.db, sql`
      UPDATE rdf_search_reconciliation
      SET state = 'applied',
          lease_owner = NULL,
          lease_expires_at = NULL,
          failure_category = NULL,
          next_attempt_at = ${timestampText(this.db, now)},
          updated_at = ${timestampText(this.db, now)}
      WHERE source_key = ${sourceKey}
        AND state = 'in-progress'
        AND lease_owner = ${workerId}
        AND lease_expires_at > ${timestampText(this.db, now)}
      RETURNING
        source_key,
        source_uri,
        pod_root,
        provider_id,
        model,
        model_version,
        config_fingerprint,
        source_hash,
        source_version,
        state,
        reason,
        attempt_count,
        next_attempt_at,
        lease_owner,
        lease_expires_at,
        failure_category,
        updated_at
    `);
    if (!result.rows[0]) {
      throw new Error(`RDF search reconciliation ownership mismatch for source key ${sourceKey}`);
    }
  }

  public async deleteSource(sourceKey: string): Promise<void> {
    await this.ready;
    await executeStatement(this.db, sql`
      DELETE FROM rdf_search_reconciliation
      WHERE source_key = ${sourceKey}
    `);
  }

  public async listPodRoots(): Promise<string[]> {
    await this.ready;
    const result = await executeQuery<{ pod_root: string }>(this.db, sql`
      SELECT DISTINCT pod_root
      FROM rdf_search_reconciliation
      ORDER BY pod_root ASC
    `);
    return result.rows.map((row) => row.pod_root);
  }

  private async initialize(): Promise<void> {
    await executePostgresLockedStatements(this.db, PG_RDF_SEARCH_RECONCILIATION_SCHEMA_LOCK_KEY, [
      `
        CREATE TABLE IF NOT EXISTS rdf_search_reconciliation (
          source_key TEXT PRIMARY KEY,
          source_uri TEXT NOT NULL,
          pod_root TEXT NOT NULL,
          provider_id TEXT,
          model TEXT,
          model_version TEXT,
          config_fingerprint TEXT,
          source_hash TEXT,
          source_version TEXT,
          state TEXT NOT NULL,
          reason TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT NOT NULL,
          lease_owner TEXT,
          lease_expires_at TEXT,
          failure_category TEXT,
          updated_at TEXT NOT NULL
        )
      `,
      `
        CREATE INDEX IF NOT EXISTS rdf_search_reconciliation_runnable_idx
        ON rdf_search_reconciliation (state, next_attempt_at, lease_expires_at, source_key)
      `,
    ]);
  }

  private async assertSourceIdentity(input: { sourceKey: string; sourceUri: string; podRoot: string }): Promise<void> {
    assertSourceIdentity(await this.get(input.sourceKey), input);
  }
}

function mapRow(row: RdfSearchReconciliationDbRow): RdfSearchReconciliationRow {
  return {
    sourceKey: row.source_key,
    sourceUri: row.source_uri,
    podRoot: row.pod_root,
    providerId: row.provider_id ?? undefined,
    model: row.model ?? undefined,
    modelVersion: row.model_version ?? undefined,
    configFingerprint: row.config_fingerprint ?? undefined,
    sourceHash: row.source_hash ?? undefined,
    sourceVersion: row.source_version ?? undefined,
    state: row.state,
    reason: row.reason,
    attemptCount: Number(row.attempt_count),
    nextAttemptAt: parseTimestamp(row.next_attempt_at),
    leaseOwner: row.lease_owner ?? undefined,
    leaseExpiresAt: row.lease_expires_at ? parseTimestamp(row.lease_expires_at) : undefined,
    failureCategory: row.failure_category ?? undefined,
    updatedAt: parseTimestamp(row.updated_at),
  };
}

function hasDesiredChanged(
  existing: RdfSearchReconciliationRow | undefined,
  input: RdfSearchDesiredProfile,
): boolean {
  return !existing ||
    existing.providerId !== input.providerId ||
    existing.model !== input.model ||
    (existing.modelVersion ?? undefined) !== (input.modelVersion ?? undefined) ||
    existing.configFingerprint !== input.configFingerprint ||
    (existing.sourceHash ?? undefined) !== (input.sourceHash ?? undefined) ||
    (existing.sourceVersion ?? undefined) !== (input.sourceVersion ?? undefined);
}

function assertSourceIdentity(
  existing: RdfSearchReconciliationRow | undefined,
  input: { sourceKey: string; sourceUri: string; podRoot: string },
): void {
  if (!existing) {
    return;
  }
  if (existing.podRoot !== input.podRoot) {
    throw new Error(`RDF search reconciliation Pod root is immutable for source key ${input.sourceKey}`);
  }
}

function timestampText(db: IdentityDatabase, date: Date): string {
  const value = toDbTimestamp(db, date);
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'number') {
    return new Date(value * 1000).toISOString();
  }
  return date.toISOString();
}

function parseTimestamp(value: string): Date {
  return fromDbTimestamp(value) ?? new Date(value);
}
