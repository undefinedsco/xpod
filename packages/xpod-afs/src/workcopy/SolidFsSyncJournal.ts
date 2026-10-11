import { createHash } from 'node:crypto';
import path from 'node:path';

import { getSqliteRuntime, type SqliteDatabase } from '../sqlite/SqliteRuntime';
import type { LocalRdfAuthorityJournal } from './types';
import type {
  SolidFsChange,
  SolidFsEntrySource,
  SolidFsManifest,
  SolidFsPrepareInput,
  SolidFsProjection,
  SolidFsSyncer,
} from './types';
import {
  isLineAddressableRdfPath,
} from './RdfContentTypes';
import {
  contentTypeForPath,
  maybeFileVersion,
  resolveWorkspaceResource,
  safeRelativePath,
  snapshotDirectory,
  sourceForProjection,
} from './SolidFsPathUtils';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DONE_RETENTION_MS = 7 * DAY_MS;
const DEFAULT_TOMBSTONE_RETENTION_MS = 30 * DAY_MS;
const DEFAULT_FAILED_PERMANENT_RETENTION_MS = 30 * DAY_MS;

export type SolidFsSyncJournalStage =
  | 'local_committed'
  | 'failed_retryable'
  | 'failed_permanent'
  | 'reconcile_required'
  | 'done';

export interface SolidFsSyncJournalOptions {
  path: string;
  now?: () => number;
  doneRetentionMs?: number;
  tombstoneRetentionMs?: number;
  failedPermanentRetentionMs?: number;
}

export interface SolidFsSyncJournalOperation {
  id: string;
  txId?: string;
  workspace: SolidFsManifest;
  change: SolidFsChange;
  stage: SolidFsSyncJournalStage;
  afterHash?: string;
  retryCount: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  doneAt?: number;
}

export interface SolidFsJournalBootstrapInput {
  workspace: string;
  cwd: string;
  projection?: SolidFsProjection;
  source?: SolidFsEntrySource;
  shouldTrackPath?: (relativePath: string) => boolean;
  resolveResource?: (absolutePath: string, relativePath: string) => string | Promise<string>;
}

export interface SolidFsJournalBootstrapResult {
  scanned: number;
  enqueued: number;
  skipped: number;
}

export interface SolidFsJournalReplayResult {
  attempted: number;
  completed: number;
  failed: number;
  reconcileRequired: number;
}

export interface SolidFsJournalCompactResult {
  deletedOps: number;
}

interface SyncOpRow {
  id: string;
  tx_id: string | null;
  workspace_json: string;
  change_json: string;
  stage: SolidFsSyncJournalStage;
  after_hash: string | null;
  retry_count: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  done_at: number | null;
}

interface CheckpointRow {
  resource: string | null;
  source_version: string | null;
  deleted_at: number | null;
}

/**
 * Per-Pod SolidFS recovery journal.
 *
 * This is an outbox for derived work after the authority file is already
 * committed. It stores enough metadata to replay index/remote refreshes, but
 * never stores file bodies.
 */
export class SqliteSolidFsSyncJournal implements LocalRdfAuthorityJournal {
  private readonly db: SqliteDatabase;
  private readonly now: () => number;
  private readonly doneRetentionMs: number;
  private readonly tombstoneRetentionMs: number;
  private readonly failedPermanentRetentionMs: number;

  public constructor(options: SolidFsSyncJournalOptions) {
    this.now = options.now ?? Date.now;
    this.doneRetentionMs = options.doneRetentionMs ?? DEFAULT_DONE_RETENTION_MS;
    this.tombstoneRetentionMs = options.tombstoneRetentionMs ?? DEFAULT_TOMBSTONE_RETENTION_MS;
    this.failedPermanentRetentionMs = options.failedPermanentRetentionMs ?? DEFAULT_FAILED_PERMANENT_RETENTION_MS;
    this.db = getSqliteRuntime().openDatabase(options.path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.initializeSchema();
  }

  public close(): void {
    this.db.close();
  }

  public async recordLocalCommitted(
    change: SolidFsChange,
    workspace: SolidFsManifest,
    txId?: string,
  ): Promise<SolidFsSyncJournalOperation> {
    const normalizedChange = normalizeChange(change);
    const afterHash = normalizedChange.type === 'deleted'
      ? undefined
      : await maybeFileVersion(normalizedChange.sourcePath);
    const opId = operationId(workspace.workspace, normalizedChange, afterHash);
    const now = this.now();

    const existing = this.getOperation(opId);
    if (existing) {
      return existing;
    }

    const journalWorkspace = journalWorkspaceSnapshot(workspace);
    this.db.prepare(`
      INSERT INTO sync_ops (
        id,
        tx_id,
        workspace,
        path,
        op_type,
        stage,
        source_path,
        resource,
        content_type,
        source,
        projection,
        source_version,
        after_hash,
        workspace_json,
        change_json,
        retry_count,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      opId,
      txId ?? null,
      workspace.workspace,
      normalizedChange.path,
      normalizedChange.type,
      'local_committed',
      normalizedChange.sourcePath,
      normalizedChange.resource ?? null,
      normalizedChange.contentType ?? null,
      normalizedChange.source,
      normalizedChange.projection,
      normalizedChange.sourceVersion ?? null,
      afterHash ?? null,
      JSON.stringify(journalWorkspace),
      JSON.stringify(normalizedChange),
      now,
      now,
    );

    return this.getOperation(opId)!;
  }

  public getOperation(id: string): SolidFsSyncJournalOperation | undefined {
    const row = this.db.prepare<SyncOpRow>(`
      SELECT id, tx_id, workspace_json, change_json, stage, after_hash, retry_count,
             last_error, created_at, updated_at, done_at
      FROM sync_ops
      WHERE id = ?
    `).get(id);
    return row ? rowToOperation(row) : undefined;
  }

  public listOperations(stages?: SolidFsSyncJournalStage[]): SolidFsSyncJournalOperation[] {
    const rows = stages && stages.length > 0
      ? this.db.prepare<SyncOpRow>(`
          SELECT id, tx_id, workspace_json, change_json, stage, after_hash, retry_count,
                 last_error, created_at, updated_at, done_at
          FROM sync_ops
          WHERE stage IN (${stages.map(() => '?').join(', ')})
          ORDER BY created_at ASC, rowid ASC
        `).all(...stages)
      : this.db.prepare<SyncOpRow>(`
          SELECT id, tx_id, workspace_json, change_json, stage, after_hash, retry_count,
                 last_error, created_at, updated_at, done_at
          FROM sync_ops
          ORDER BY created_at ASC, rowid ASC
        `).all();
    return rows.map(rowToOperation);
  }

  public listPending(): SolidFsSyncJournalOperation[] {
    return this.listOperations(['local_committed', 'failed_retryable']);
  }

  /**
   * Rebase the operation's expected hash to the file version its own sync produced.
   *
   * A direct-projection Pod sync PUTs a resource whose local file is the same
   * authority file CSS serves, so the write itself moves the file version (mtime,
   * possibly inode) without changing the bytes. Only that same-bytes timestamp
   * drift may be rebased. When the content identity (size and digest) differs,
   * a concurrent writer changed the authority bytes during the sync, so the
   * original guard must stand and the operation is left for reconciliation.
   */
  public async recordSyncedSourceHash(id: string, afterHash: string | undefined): Promise<void> {
    if (!afterHash) {
      return;
    }
    const op = this.getOperation(id);
    if (!op || op.stage === 'done' || op.stage === 'failed_permanent') {
      return;
    }
    if (!sameFileContent(op.afterHash, afterHash)) {
      return;
    }
    this.db.prepare(`
      UPDATE sync_ops
      SET after_hash = ?, updated_at = ?
      WHERE id = ? AND stage NOT IN ('done', 'failed_permanent')
    `).run(afterHash, this.now(), id);
  }

  public async markDone(id: string): Promise<void> {
    const op = this.getOperation(id);
    if (!op || op.stage === 'done' || op.stage === 'failed_permanent') {
      return;
    }
    const validation = await this.validateOperationForReplay(op);
    if (validation) {
      await this.markRetryableFailure(id, validation);
      throw new Error(validation);
    }

    const now = this.now();
    this.db.transaction(() => {
      const current = this.getOperation(id);
      if (!current || current.stage === 'done' || current.stage === 'failed_permanent') return;
      this.db.prepare(`
        UPDATE sync_ops
        SET stage = 'done',
            last_error = NULL,
            done_at = ?,
            updated_at = ?,
            tombstone_confirmed_at = CASE WHEN op_type = 'deleted' THEN ? ELSE tombstone_confirmed_at END
        WHERE id = ?
      `).run(now, now, now, id);

      this.upsertCheckpoint(current, now);
      // A successfully indexed newer version supersedes older failed work for this
      // same authority. Otherwise a recovered/retried PUT would poison the next startup.
      this.db.prepare(`
        UPDATE sync_ops SET stage = 'failed_permanent',
          last_error = 'Superseded by a newer completed authority version', updated_at = ?
        WHERE source_path = ? AND resource IS ?
          AND rowid < (SELECT rowid FROM sync_ops WHERE id = ?)
          AND stage IN ('local_committed', 'failed_retryable', 'reconcile_required')
      `).run(now, op.change.sourcePath, op.change.resource ?? null, op.id);
    })();
  }

  public async markRetryableFailure(id: string, error: unknown): Promise<void> {
    const now = this.now();
    this.db.prepare(`
      UPDATE sync_ops
      SET stage = 'failed_retryable',
          retry_count = retry_count + 1,
          last_error = ?,
          updated_at = ?
      WHERE id = ? AND stage NOT IN ('done', 'failed_permanent')
    `).run(errorMessage(error), now, id);
  }

  public async markReconcileRequired(id: string, reason: string): Promise<void> {
    const now = this.now();
    this.db.prepare(`
      UPDATE sync_ops
      SET stage = 'reconcile_required',
          last_error = ?,
          updated_at = ?
      WHERE id = ? AND stage NOT IN ('done', 'failed_permanent')
    `).run(reason, now, id);
  }

  public async markFailedPermanent(id: string, error: unknown): Promise<void> {
    const now = this.now();
    this.db.prepare(`
      UPDATE sync_ops
      SET stage = 'failed_permanent',
          last_error = ?,
          updated_at = ?
      WHERE id = ? AND stage NOT IN ('done', 'failed_permanent')
    `).run(errorMessage(error), now, id);
  }

  public async replayPending(syncer: SolidFsSyncer, context?: unknown): Promise<SolidFsJournalReplayResult> {
    const result: SolidFsJournalReplayResult = {
      attempted: 0,
      completed: 0,
      failed: 0,
      reconcileRequired: 0,
    };

    for (const snapshot of this.listPending()) {
      // Earlier work or a concurrent writer may have completed/superseded this entry.
      const op = this.getOperation(snapshot.id);
      if (!op || (op.stage !== 'local_committed' && op.stage !== 'failed_retryable')) continue;
      result.attempted += 1;
      const validation = await this.validateOperationForReplay(op);
      if (validation) {
        await this.markReconcileRequired(op.id, validation);
        result.reconcileRequired += 1;
        continue;
      }

      const current = this.getOperation(op.id);
      if (!current || (current.stage !== 'local_committed' && current.stage !== 'failed_retryable')) continue;
      try {
        await syncer.sync(op.change, op.workspace, context);
        await this.recordSyncedSourceHash(op.id, await maybeFileVersion(op.change.sourcePath));
        await this.markDone(op.id);
        result.completed += 1;
      } catch (error) {
        await this.markRetryableFailure(op.id, error);
        result.failed += 1;
      }
    }

    return result;
  }

  public async bootstrapWorkspace(input: SolidFsJournalBootstrapInput): Promise<SolidFsJournalBootstrapResult> {
    const projection = input.projection ?? 'direct';
    const source = input.source ?? sourceForProjection(projection, input.workspace);
    const manifest: SolidFsManifest = {
      workspace: input.workspace,
      cwd: input.cwd,
      projection,
      entries: [],
    };

    const snapshots = await snapshotDirectory(input.cwd, input.shouldTrackPath);
    const currentPaths = new Set(snapshots.map((snapshot) => snapshot.relativePath));
    const result: SolidFsJournalBootstrapResult = {
      scanned: snapshots.length,
      enqueued: 0,
      skipped: 0,
    };

    for (const snapshot of snapshots) {
      const resource = input.resolveResource
        ? await input.resolveResource(path.resolve(snapshot.absolutePath), snapshot.relativePath)
        : resolveWorkspaceResource(input.workspace, snapshot.relativePath);
      const checkpoint = this.getCheckpoint(input.workspace, snapshot.relativePath);
      if (checkpoint?.resource === (resource ?? null) &&
        checkpoint.source_version === snapshot.version && !checkpoint.deleted_at) {
        result.skipped += 1;
        continue;
      }
      // CSS writes and tool patches may use a child workspace in this same journal.
      // Reuse their exact completed authority receipt, bound to both file and resource.
      const existing = this.db.prepare<{ id: string; stage: SolidFsSyncJournalStage; after_hash: string | null }>(`
        SELECT id, stage, after_hash FROM sync_ops
        WHERE source_path = ? AND resource = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1
      `).get(snapshot.absolutePath, resource ?? null);
      if (existing?.stage === 'done' && existing.after_hash === snapshot.version) {
        // Preserve root-level deletion detection even when completion was recorded
        // under a child workspace. This checkpoint references the same completed op.
        const op = this.getOperation(existing.id)!;
        this.upsertCheckpoint({
          ...op,
          workspace: manifest,
          change: { ...op.change, path: snapshot.relativePath },
        }, this.now());
        result.skipped += 1;
        continue;
      }

      const op = await this.recordLocalCommitted({
        path: snapshot.relativePath,
        resource,
        source,
        sourcePath: snapshot.absolutePath,
        contentType: contentTypeForPath(snapshot.relativePath),
        projection,
        type: 'created',
      }, manifest);
      result.enqueued += op.stage === 'done' ? 0 : 1;
    }

    const checkpoints = this.listCheckpoints(input.workspace);
    for (const checkpoint of checkpoints) {
      if (currentPaths.has(checkpoint.path) || checkpoint.deleted_at) {
        continue;
      }
      const op = await this.recordLocalCommitted({
        path: checkpoint.path,
        resource: input.resolveResource
          ? await input.resolveResource(path.resolve(input.cwd, checkpoint.path), checkpoint.path)
          : resolveWorkspaceResource(input.workspace, checkpoint.path),
        source,
        sourcePath: path.join(input.cwd, checkpoint.path),
        contentType: contentTypeForPath(checkpoint.path),
        projection,
        type: 'deleted',
        sourceVersion: checkpoint.source_version ?? undefined,
      }, manifest);
      result.enqueued += op.stage === 'done' ? 0 : 1;
    }

    return result;
  }

  public async compact(): Promise<SolidFsJournalCompactResult> {
    const now = this.now();
    const rows = this.db.prepare<{
      id: string;
      workspace: string;
      path: string;
      op_type: SolidFsChange['type'];
      after_hash: string | null;
      stage: SolidFsSyncJournalStage;
      done_at: number | null;
      updated_at: number;
      tombstone_confirmed_at: number | null;
    }>(`
      SELECT id, workspace, path, op_type, after_hash, stage, done_at, updated_at, tombstone_confirmed_at
      FROM sync_ops
      WHERE stage IN ('done', 'failed_permanent')
      ORDER BY created_at ASC
    `).all();

    const deletable: string[] = [];
    for (const row of rows) {
      if (row.stage === 'failed_permanent') {
        if (row.updated_at <= now - this.failedPermanentRetentionMs) {
          deletable.push(row.id);
        }
        continue;
      }

      if (!row.done_at) {
        continue;
      }
      const checkpoint = this.getCheckpoint(row.workspace, row.path);
      if (!checkpoint) {
        continue;
      }
      if (row.op_type === 'deleted') {
        if (
          row.done_at <= now - this.tombstoneRetentionMs &&
          row.tombstone_confirmed_at &&
          checkpoint.deleted_at
        ) {
          deletable.push(row.id);
        }
        continue;
      }

      if (row.done_at <= now - this.doneRetentionMs && checkpoint.source_version === row.after_hash) {
        deletable.push(row.id);
      }
    }

    if (deletable.length === 0) {
      return { deletedOps: 0 };
    }

    this.db.transaction(() => {
      const deleteStatement = this.db.prepare('DELETE FROM sync_ops WHERE id = ?');
      for (const id of deletable) {
        deleteStatement.run(id);
      }
    })();

    return { deletedOps: deletable.length };
  }

  private async validateOperationForReplay(op: SolidFsSyncJournalOperation): Promise<string | undefined> {
    if (op.change.type === 'deleted') {
      return undefined;
    }

    const currentHash = await maybeFileVersion(op.change.sourcePath);
    if (!currentHash) {
      return `SolidFS journal source is missing: ${op.change.sourcePath}`;
    }
    if (!op.afterHash || currentHash !== op.afterHash) {
      return `SolidFS journal source changed before replay: ${op.change.path}`;
    }
    return undefined;
  }

  private getCheckpoint(workspace: string, relativePath: string): CheckpointRow | undefined {
    return this.db.prepare<CheckpointRow>(`
      SELECT resource, source_version, deleted_at
      FROM sync_checkpoints
      WHERE workspace = ? AND path = ?
    `).get(workspace, relativePath);
  }

  private listCheckpoints(workspace: string): Array<CheckpointRow & { path: string }> {
    return this.db.prepare<CheckpointRow & { path: string }>(`
      SELECT path, resource, source_version, deleted_at
      FROM sync_checkpoints
      WHERE workspace = ?
      ORDER BY path ASC
    `).all(workspace);
  }

  private upsertCheckpoint(op: SolidFsSyncJournalOperation, now: number): void {
    if (op.change.type === 'deleted') {
      this.db.prepare(`
        INSERT INTO sync_checkpoints (workspace, path, resource, source_version, deleted_at, updated_at, last_op_id)
        VALUES (?, ?, ?, NULL, ?, ?, ?)
        ON CONFLICT(workspace, path) DO UPDATE SET
          resource = excluded.resource,
          source_version = NULL,
          deleted_at = excluded.deleted_at,
          updated_at = excluded.updated_at,
          last_op_id = excluded.last_op_id
      `).run(op.workspace.workspace, op.change.path, op.change.resource ?? null, now, now, op.id);
      return;
    }

    this.db.prepare(`
      INSERT INTO sync_checkpoints (workspace, path, resource, source_version, deleted_at, updated_at, last_op_id)
      VALUES (?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(workspace, path) DO UPDATE SET
        resource = excluded.resource,
        source_version = excluded.source_version,
        deleted_at = NULL,
        updated_at = excluded.updated_at,
        last_op_id = excluded.last_op_id
    `).run(op.workspace.workspace, op.change.path, op.change.resource ?? null, op.afterHash ?? null, now, op.id);
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_ops (
        id TEXT PRIMARY KEY,
        tx_id TEXT,
        workspace TEXT NOT NULL,
        path TEXT NOT NULL,
        op_type TEXT NOT NULL,
        stage TEXT NOT NULL,
        source_path TEXT NOT NULL,
        resource TEXT,
        content_type TEXT,
        source TEXT NOT NULL,
        projection TEXT NOT NULL,
        source_version TEXT,
        after_hash TEXT,
        workspace_json TEXT NOT NULL,
        change_json TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        done_at INTEGER,
        tombstone_confirmed_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS sync_ops_stage_created_idx
        ON sync_ops(stage, created_at);
      CREATE INDEX IF NOT EXISTS sync_ops_workspace_path_idx
        ON sync_ops(workspace, path);

      CREATE TABLE IF NOT EXISTS sync_checkpoints (
        workspace TEXT NOT NULL,
        path TEXT NOT NULL,
        resource TEXT,
        source_version TEXT,
        deleted_at INTEGER,
        updated_at INTEGER NOT NULL,
        last_op_id TEXT,
        PRIMARY KEY (workspace, path)
      );
    `);
    const columns = this.db.prepare<{ name: string }>('PRAGMA table_info(sync_checkpoints)').all();
    if (!columns.some((column) => column.name === 'resource')) {
      this.db.transaction(() => {
        this.db.exec('ALTER TABLE sync_checkpoints ADD COLUMN resource TEXT');
        // A compacted historical operation cannot prove its resource binding;
        // leave that checkpoint unbound so bootstrap conservatively replays it.
        this.db.exec(`
          UPDATE sync_checkpoints SET resource = (
            SELECT resource FROM sync_ops WHERE id = sync_checkpoints.last_op_id
          )
        `);
      })();
    }
  }
}

export class RootedSolidFsSyncJournal extends SqliteSolidFsSyncJournal {
  public constructor(rootFilePath: string, cwd = process.cwd()) {
    super({ path: resolveLocalRdfAuthorityJournalPath(rootFilePath, cwd) });
  }
}

export interface JournaledSolidFsSyncerOptions {
  syncer: SolidFsSyncer;
  journal: SqliteSolidFsSyncJournal;
}

export interface WorkspaceJournaledSolidFsSyncerOptions {
  syncer: SolidFsSyncer;
  journalRoot?: string;
  resolveJournalPath?: (workspace: SolidFsManifest) => string;
  now?: () => number;
  doneRetentionMs?: number;
  tombstoneRetentionMs?: number;
  failedPermanentRetentionMs?: number;
}

export class JournaledSolidFsSyncer implements SolidFsSyncer {
  private readonly syncer: SolidFsSyncer;
  private readonly journal: SqliteSolidFsSyncJournal;

  public constructor(options: JournaledSolidFsSyncerOptions) {
    this.syncer = options.syncer;
    this.journal = options.journal;
  }

  public shouldTrack(input: SolidFsPrepareInput): boolean {
    return this.syncer.shouldTrack?.(input) ?? true;
  }

  public shouldTrackPath(relativePath: string): boolean {
    return this.syncer.shouldTrackPath?.(relativePath) ?? isLineAddressableRdfPath(relativePath);
  }

  public async sync(change: SolidFsChange, workspace: SolidFsManifest, context?: unknown, txId?: string): Promise<void> {
    const op = await this.journal.recordLocalCommitted(change, workspace, txId);
    if (op.stage === 'done') {
      return;
    }

    try {
      await this.syncer.sync(change, workspace, context);
      await this.journal.recordSyncedSourceHash(op.id, await maybeFileVersion(change.sourcePath));
      await this.journal.markDone(op.id);
    } catch (error) {
      await this.journal.markRetryableFailure(op.id, error);
      throw error;
    }
  }

  public async replayPending(context?: unknown): Promise<SolidFsJournalReplayResult> {
    return this.journal.replayPending(this.syncer, context);
  }

  public async compact(): Promise<SolidFsJournalCompactResult> {
    return this.journal.compact();
  }

  public async bootstrapWorkspace(
    input: Omit<SolidFsJournalBootstrapInput, 'shouldTrackPath'> & {
      shouldTrackPath?: (relativePath: string) => boolean;
    },
  ): Promise<SolidFsJournalBootstrapResult> {
    return this.journal.bootstrapWorkspace({
      ...input,
      shouldTrackPath: input.shouldTrackPath ?? this.shouldTrackPath.bind(this),
    });
  }
}

export class WorkspaceJournaledSolidFsSyncer implements SolidFsSyncer {
  private readonly syncer: SolidFsSyncer;
  private readonly journals = new Map<string, SqliteSolidFsSyncJournal>();

  public constructor(private readonly options: WorkspaceJournaledSolidFsSyncerOptions) {
    this.syncer = options.syncer;
  }

  public shouldTrack(input: SolidFsPrepareInput): boolean {
    return this.syncer.shouldTrack?.(input) ?? true;
  }

  public shouldTrackPath(relativePath: string): boolean {
    return this.syncer.shouldTrackPath?.(relativePath) ?? isLineAddressableRdfPath(relativePath);
  }

  public async initializeWorkspace(workspace: SolidFsManifest, context?: unknown): Promise<void> {
    const journal = this.journalFor(workspace);
    await journal.bootstrapWorkspace({
      workspace: workspace.workspace,
      cwd: workspace.cwd,
      projection: workspace.projection,
      source: sourceForProjection(workspace.projection, workspace.workspace),
      shouldTrackPath: this.shouldTrackPath.bind(this),
    });
    await journal.replayPending(this.syncer, context);
    await journal.compact();
  }

  public async sync(change: SolidFsChange, workspace: SolidFsManifest, context?: unknown, txId?: string): Promise<void> {
    const journal = this.journalFor(workspace);
    const op = await journal.recordLocalCommitted(change, workspace, txId);
    if (op.stage === 'done') {
      return;
    }

    try {
      await this.syncer.sync(change, workspace, context);
      await journal.recordSyncedSourceHash(op.id, await maybeFileVersion(change.sourcePath));
      await journal.markDone(op.id);
    } catch (error) {
      await journal.markRetryableFailure(op.id, error);
      throw error;
    }
  }

  public async replayPending(workspace: SolidFsManifest, context?: unknown): Promise<SolidFsJournalReplayResult> {
    return this.journalFor(workspace).replayPending(this.syncer, context);
  }

  public async compact(workspace: SolidFsManifest): Promise<SolidFsJournalCompactResult> {
    return this.journalFor(workspace).compact();
  }

  public journalPathFor(workspace: SolidFsManifest): string {
    return this.options.resolveJournalPath?.(workspace)
      ?? resolveSolidFsJournalPath(workspace, this.options.journalRoot ?? process.env.XPOD_SOLIDFS_JOURNAL_ROOT);
  }

  public close(): void {
    for (const journal of this.journals.values()) {
      journal.close();
    }
    this.journals.clear();
  }

  private journalFor(workspace: SolidFsManifest): SqliteSolidFsSyncJournal {
    const journalPath = this.journalPathFor(workspace);
    const existing = this.journals.get(journalPath);
    if (existing) {
      return existing;
    }

    const journal = new SqliteSolidFsSyncJournal({
      path: journalPath,
      now: this.options.now,
      doneRetentionMs: this.options.doneRetentionMs,
      tombstoneRetentionMs: this.options.tombstoneRetentionMs,
      failedPermanentRetentionMs: this.options.failedPermanentRetentionMs,
    });
    this.journals.set(journalPath, journal);
    return journal;
  }
}

export function resolveSolidFsJournalPath(workspace: SolidFsManifest, journalRoot?: string): string {
  const root = journalRoot
    ? path.resolve(journalRoot)
    : path.join(path.dirname(path.resolve(workspace.cwd)), '.xpod-control', 'solidfs-journals');
  const basename = safeJournalSegment(path.basename(workspace.cwd) || 'workspace');
  const key = createHash('sha256')
    .update(workspace.workspace)
    .digest('hex')
    .slice(0, 16);
  return path.join(root, `${basename}-${key}`, 'sync-journal.sqlite');
}

export function resolveLocalRdfAuthorityJournalPath(rootFilePath: string, cwd = process.cwd()): string {
  const root = path.resolve(cwd, rootFilePath);
  return path.join(path.dirname(root), '.xpod-control', 'rdf-authority', 'sync-journal.sqlite');
}

function rowToOperation(row: SyncOpRow): SolidFsSyncJournalOperation {
  return {
    id: row.id,
    txId: row.tx_id ?? undefined,
    workspace: JSON.parse(row.workspace_json) as SolidFsManifest,
    change: JSON.parse(row.change_json) as SolidFsChange,
    stage: row.stage,
    afterHash: row.after_hash ?? undefined,
    retryCount: row.retry_count,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    doneAt: row.done_at ?? undefined,
  };
}

function journalWorkspaceSnapshot(workspace: SolidFsManifest): SolidFsManifest {
  return {
    workspace: workspace.workspace,
    cwd: workspace.cwd,
    projection: workspace.projection,
    entries: [],
  };
}

function normalizeChange(change: SolidFsChange): SolidFsChange {
  return {
    ...change,
    path: safeRelativePath(change.path),
    previousPath: change.previousPath ? safeRelativePath(change.previousPath) : undefined,
  };
}

function operationId(workspace: string, change: SolidFsChange, afterHash?: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({
      workspace,
      path: change.path,
      previousPath: change.previousPath,
      prefix: change.prefix,
      previousPrefix: change.previousPrefix,
      type: change.type,
      resource: change.resource,
      previousResource: change.previousResource,
      source: change.source,
      sourcePath: change.sourcePath,
      projection: change.projection,
      sourceVersion: change.sourceVersion,
      afterHash,
    }))
    .digest('hex')
    .slice(0, 32);
  return `sync_${digest}`;
}

function safeJournalSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/gu, '_').slice(0, 64);
  return safe || 'workspace';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Compare two `size:mtimeMs:sha256` file versions by content identity.
 *
 * Only the size and digest parts describe the bytes; mtime legitimately moves
 * when the sync's own write lands on the same authority file. A missing or
 * malformed version is treated as content-different so the guard is retained.
 */
function sameFileContent(expected: string | undefined, current: string | undefined): boolean {
  if (!expected || !current) {
    return false;
  }
  const expectedParts = expected.split(':');
  const currentParts = current.split(':');
  if (expectedParts.length < 3 || currentParts.length < 3) {
    return false;
  }
  return expectedParts[0] === currentParts[0] && expectedParts[2] === currentParts[2];
}
