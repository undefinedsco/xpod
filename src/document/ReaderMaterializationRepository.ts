import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { IdentityDatabase } from '../identity/drizzle/db';
import { executeQuery, executeStatement, fromDbTimestamp, toDbTimestamp } from '../identity/drizzle/db';
import type {
  ReaderMaterializationBody,
  ReaderMaterializationBodyInput,
  ReaderReconciliationInput,
  ReaderReconciliationRow,
} from './ReaderMaterialization';

interface BodyRow {
  fingerprint: string;
  source_key: string;
  source_uri: string;
  source_hash: string;
  media_type: string;
  reader_engine: string;
  reader_version: string;
  model_uri: string | null;
  reader_options_hash: string;
  representation_hash: string;
  markdown: string;
  created_at: string;
}

interface ReconciliationDbRow {
  source_key: string;
  source_uri: string;
  desired_fingerprint: string | null;
  reason: string;
  attempt_count: number;
  next_attempt_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  last_failure_category: string | null;
  updated_at: string;
}

export class ReaderMaterializationRepository {
  private readonly ready: Promise<void>;

  constructor(private readonly db: IdentityDatabase) {
    this.ready = this.initialize();
  }

  async putBody(input: ReaderMaterializationBodyInput, now = new Date()): Promise<ReaderMaterializationBody> {
    await this.ready;
    const fingerprint = computeReaderMaterializationFingerprint(input);
    const createdAt = timestampText(this.db, now);
    const insertResult = await executeQuery<BodyRow>(this.db, sql`
      INSERT INTO reader_materialization_body (
        fingerprint,
        source_key,
        source_uri,
        source_hash,
        media_type,
        reader_engine,
        reader_version,
        model_uri,
        reader_options_hash,
        representation_hash,
        markdown,
        created_at
      ) VALUES (
        ${fingerprint},
        ${input.sourceKey},
        ${input.sourceUri},
        ${input.sourceHash},
        ${input.mediaType},
        ${input.readerEngine},
        ${input.readerVersion},
        ${input.modelUri ?? null},
        ${input.readerOptionsHash},
        ${input.representationHash},
        ${input.markdown},
        ${createdAt}
      )
      ON CONFLICT (fingerprint) DO NOTHING
      RETURNING
        fingerprint,
        source_key,
        source_uri,
        source_hash,
        media_type,
        reader_engine,
        reader_version,
        model_uri,
        reader_options_hash,
        representation_hash,
        markdown,
        created_at
    `);

    if (insertResult.rows[0]) {
      return mapBodyRow(insertResult.rows[0]);
    }

    const conflicting = await this.getBody(fingerprint);
    if (!conflicting) {
      throw new Error(`Failed to write reader materialization body for fingerprint ${fingerprint}`);
    }
    if (!isIdempotentBody(conflicting, input)) {
      throw new Error(`Reader materialization body is immutable for fingerprint ${fingerprint}`);
    }
    return conflicting;
  }

  async getBody(fingerprint: string): Promise<ReaderMaterializationBody | undefined> {
    await this.ready;
    const result = await executeQuery<BodyRow>(this.db, sql`
      SELECT
        fingerprint,
        source_key,
        source_uri,
        source_hash,
        media_type,
        reader_engine,
        reader_version,
        model_uri,
        reader_options_hash,
        representation_hash,
        markdown,
        created_at
      FROM reader_materialization_body
      WHERE fingerprint = ${fingerprint}
      LIMIT 1
    `);
    return result.rows[0] ? mapBodyRow(result.rows[0]) : undefined;
  }

  async enqueue(input: ReaderReconciliationInput, now = new Date()): Promise<ReaderReconciliationRow> {
    await this.ready;
    const ts = timestampText(this.db, now);
    const result = await executeQuery<ReconciliationDbRow>(this.db, sql`
      INSERT INTO reader_reconciliation (
        source_key,
        source_uri,
        desired_fingerprint,
        reason,
        attempt_count,
        next_attempt_at,
        lease_owner,
        lease_expires_at,
        last_failure_category,
        updated_at
      ) VALUES (
        ${input.sourceKey},
        ${input.sourceUri},
        ${input.desiredFingerprint ?? null},
        ${input.reason},
        0,
        ${ts},
        NULL,
        NULL,
        NULL,
        ${ts}
      )
      ON CONFLICT (source_key) DO UPDATE SET
        desired_fingerprint = excluded.desired_fingerprint,
        reason = excluded.reason,
        updated_at = excluded.updated_at
      WHERE reader_reconciliation.source_uri = excluded.source_uri
      RETURNING
        source_key,
        source_uri,
        desired_fingerprint,
        reason,
        attempt_count,
        next_attempt_at,
        lease_owner,
        lease_expires_at,
        last_failure_category,
        updated_at
    `);

    if (!result.rows[0]) {
      throw new Error(`Reader reconciliation source URI is immutable for source key ${input.sourceKey}`);
    }
    return mapReconciliationRow(result.rows[0]);
  }

  async listRunnable(now = new Date()): Promise<ReaderReconciliationRow[]> {
    await this.ready;
    const ts = timestampText(this.db, now);
    const result = await executeQuery<ReconciliationDbRow>(this.db, sql`
      SELECT
        source_key,
        source_uri,
        desired_fingerprint,
        reason,
        attempt_count,
        next_attempt_at,
        lease_owner,
        lease_expires_at,
        last_failure_category,
        updated_at
      FROM reader_reconciliation
      WHERE next_attempt_at <= ${ts}
        AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ${ts})
      ORDER BY next_attempt_at ASC, source_key ASC
    `);
    return result.rows.map(mapReconciliationRow);
  }

  async claimNext(workerId: string, now = new Date(), leaseDurationMs = 60_000): Promise<ReaderReconciliationRow | undefined> {
    await this.ready;
    const ts = timestampText(this.db, now);
    const leaseExpiresAt = timestampText(this.db, new Date(now.getTime() + leaseDurationMs));
    const candidates = await this.listRunnable(now);

    for (const candidate of candidates) {
      const result = await executeQuery<ReconciliationDbRow>(this.db, sql`
        UPDATE reader_reconciliation
        SET lease_owner = ${workerId},
            lease_expires_at = ${leaseExpiresAt},
            updated_at = ${ts}
        WHERE source_key = ${candidate.sourceKey}
          AND next_attempt_at <= ${ts}
          AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ${ts})
        RETURNING
          source_key,
          source_uri,
          desired_fingerprint,
          reason,
          attempt_count,
          next_attempt_at,
          lease_owner,
          lease_expires_at,
          last_failure_category,
          updated_at
      `);

      if (result.rows[0]) {
        return mapReconciliationRow(result.rows[0]);
      }
    }

    return undefined;
  }

  async fail(
    sourceKey: string,
    workerId: string,
    failureCategory: string,
    nextAttemptAt: Date,
    now = new Date(),
  ): Promise<void> {
    await this.ready;
    const result = await executeQuery<ReconciliationDbRow>(this.db, sql`
      UPDATE reader_reconciliation
      SET attempt_count = attempt_count + 1,
          next_attempt_at = ${timestampText(this.db, nextAttemptAt)},
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_failure_category = ${failureCategory},
          updated_at = ${timestampText(this.db, now)}
      WHERE source_key = ${sourceKey}
        AND lease_owner = ${workerId}
        AND lease_expires_at > ${timestampText(this.db, now)}
      RETURNING
        source_key,
        source_uri,
        desired_fingerprint,
        reason,
        attempt_count,
        next_attempt_at,
        lease_owner,
        lease_expires_at,
        last_failure_category,
        updated_at
    `);
    if (!result.rows[0]) {
      throw new Error(`Reader reconciliation ownership mismatch for source key ${sourceKey}`);
    }
  }

  async complete(sourceKey: string, workerId: string, now = new Date()): Promise<void> {
    await this.ready;
    const result = await executeQuery<ReconciliationDbRow>(this.db, sql`
      DELETE FROM reader_reconciliation
      WHERE source_key = ${sourceKey}
        AND lease_owner = ${workerId}
        AND lease_expires_at > ${timestampText(this.db, now)}
      RETURNING
        source_key,
        source_uri,
        desired_fingerprint,
        reason,
        attempt_count,
        next_attempt_at,
        lease_owner,
        lease_expires_at,
        last_failure_category,
        updated_at
    `);
    if (!result.rows[0]) {
      throw new Error(`Reader reconciliation ownership mismatch for source key ${sourceKey}`);
    }
  }

  async releaseExpiredLeases(now = new Date()): Promise<void> {
    await this.ready;
    const ts = timestampText(this.db, now);
    await executeStatement(this.db, sql`
      UPDATE reader_reconciliation
      SET lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = ${ts}
      WHERE lease_owner IS NOT NULL
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= ${ts}
    `);
  }

  async moveSource(sourceKey: string, nextSourceUri: string, now = new Date()): Promise<void> {
    await this.ready;
    const ts = timestampText(this.db, now);
    await executeStatement(this.db, sql`
      UPDATE reader_materialization_body
      SET source_uri = ${nextSourceUri}
      WHERE source_key = ${sourceKey}
    `);
    await executeStatement(this.db, sql`
      UPDATE reader_reconciliation
      SET source_uri = ${nextSourceUri},
          updated_at = ${ts}
      WHERE source_key = ${sourceKey}
    `);
  }

  private async initialize(): Promise<void> {
    await executeStatement(this.db, sql`
      CREATE TABLE IF NOT EXISTS reader_materialization_body (
        fingerprint TEXT PRIMARY KEY,
        source_key TEXT NOT NULL,
        source_uri TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        media_type TEXT NOT NULL,
        reader_engine TEXT NOT NULL,
        reader_version TEXT NOT NULL,
        model_uri TEXT,
        reader_options_hash TEXT NOT NULL,
        representation_hash TEXT NOT NULL,
        markdown TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    await executeStatement(this.db, sql`
      CREATE TABLE IF NOT EXISTS reader_reconciliation (
        source_key TEXT PRIMARY KEY,
        source_uri TEXT NOT NULL,
        desired_fingerprint TEXT,
        reason TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        last_failure_category TEXT,
        updated_at TEXT NOT NULL
      )
    `);
  }

  private async getReconciliation(sourceKey: string): Promise<ReaderReconciliationRow | undefined> {
    const result = await executeQuery<ReconciliationDbRow>(this.db, sql`
      SELECT
        source_key,
        source_uri,
        desired_fingerprint,
        reason,
        attempt_count,
        next_attempt_at,
        lease_owner,
        lease_expires_at,
        last_failure_category,
        updated_at
      FROM reader_reconciliation
      WHERE source_key = ${sourceKey}
      LIMIT 1
    `);
    return result.rows[0] ? mapReconciliationRow(result.rows[0]) : undefined;
  }
}

export function computeReaderMaterializationFingerprint(input: {
  sourceKey: string;
  sourceHash: string;
  mediaType: string;
  readerEngine: string;
  readerVersion: string;
  modelUri?: string;
  readerOptionsHash: string;
}): string {
  const canonical = [
    input.sourceKey,
    input.sourceHash,
    input.mediaType,
    input.readerEngine,
    input.readerVersion,
    input.modelUri ?? 'no-model',
    input.readerOptionsHash,
  ].join('\0');
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function mapBodyRow(row: BodyRow): ReaderMaterializationBody {
  return {
    fingerprint: row.fingerprint,
    sourceKey: row.source_key,
    sourceUri: row.source_uri,
    sourceHash: row.source_hash,
    mediaType: row.media_type,
    readerEngine: row.reader_engine,
    readerVersion: row.reader_version,
    modelUri: row.model_uri ?? undefined,
    readerOptionsHash: row.reader_options_hash,
    representationHash: row.representation_hash,
    markdown: row.markdown,
    createdAt: parseTimestamp(row.created_at),
  };
}

function mapReconciliationRow(row: ReconciliationDbRow): ReaderReconciliationRow {
  return {
    sourceKey: row.source_key,
    sourceUri: row.source_uri,
    desiredFingerprint: row.desired_fingerprint ?? undefined,
    reason: row.reason,
    attemptCount: Number(row.attempt_count),
    nextAttemptAt: parseTimestamp(row.next_attempt_at),
    leaseOwner: row.lease_owner ?? undefined,
    leaseExpiresAt: row.lease_expires_at ? parseTimestamp(row.lease_expires_at) : undefined,
    lastFailureCategory: row.last_failure_category ?? undefined,
    updatedAt: parseTimestamp(row.updated_at),
  };
}

function isIdempotentBody(existing: ReaderMaterializationBody, input: ReaderMaterializationBodyInput): boolean {
  return existing.sourceKey === input.sourceKey &&
    existing.sourceUri === input.sourceUri &&
    existing.sourceHash === input.sourceHash &&
    existing.mediaType === input.mediaType &&
    existing.readerEngine === input.readerEngine &&
    existing.readerVersion === input.readerVersion &&
    (existing.modelUri ?? undefined) === (input.modelUri ?? undefined) &&
    existing.readerOptionsHash === input.readerOptionsHash &&
    existing.representationHash === input.representationHash &&
    Buffer.from(existing.markdown).equals(Buffer.from(input.markdown));
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
