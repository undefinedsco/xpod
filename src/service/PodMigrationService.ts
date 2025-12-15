import { getLoggerFor, type DataAccessor } from '@solid/community-server';
import { getIdentityDatabase } from '../identity/drizzle/db';
import { PodLookupRepository } from '../identity/drizzle/PodLookupRepository';
import { EdgeNodeRepository } from '../identity/drizzle/EdgeNodeRepository';
import { isMigratableAccessor, type MigratableDataAccessor } from '../storage/MigratableDataAccessor';

export interface PodMigrationServiceConfig {
  identityDbUrl: string;
  currentNodeId: string;
  /** DataAccessor for storage operations (must support migration) */
  dataAccessor?: DataAccessor;
}

export interface MigrationJob {
  podId: string;
  sourceNodeId: string;
  targetNodeId: string;
  status: 'pending' | 'syncing' | 'copying' | 'switching' | 'done' | 'failed';
  progress: number;
  error?: string;
  startedAt: Date;
  completedAt?: Date;
  /** Number of objects copied */
  objectsCopied?: number;
  /** Total objects to copy */
  objectsTotal?: number;
  /** Bytes transferred */
  bytesTransferred?: number;
}

/**
 * Service for managing Pod migrations between Center nodes.
 * 
 * Migration process:
 * 1. Mark pod as migrating (status='syncing')
 * 2. Set up real-time sync (new writes go to both regions)
 * 3. Bulk copy historical data via MigratableDataAccessor
 * 4. Switch nodeId to target (atomic update)
 * 5. Stop real-time sync
 * 
 * If DataAccessor doesn't support migration, throws an error.
 */
export class PodMigrationService {
  protected readonly logger = getLoggerFor(this);

  private readonly podLookupRepository: PodLookupRepository;
  private readonly edgeNodeRepository: EdgeNodeRepository;
  private readonly currentNodeId: string;
  private readonly dataAccessor?: DataAccessor;
  
  // Active migration jobs (in-memory tracking)
  private readonly activeJobs = new Map<string, MigrationJob>();
  
  // Cancellation flags
  private readonly cancelledJobs = new Set<string>();

  public constructor(config: PodMigrationServiceConfig) {
    const db = getIdentityDatabase(config.identityDbUrl);
    this.podLookupRepository = new PodLookupRepository(db);
    this.edgeNodeRepository = new EdgeNodeRepository(db);
    this.currentNodeId = config.currentNodeId;
    this.dataAccessor = config.dataAccessor;
  }

  /**
   * Start a migration job for a pod.
   */
  public async startMigration(podId: string, targetNodeId: string): Promise<MigrationJob> {
    // Check if already migrating
    const existing = this.activeJobs.get(podId);
    if (existing && existing.status !== 'done' && existing.status !== 'failed') {
      throw new Error(`Pod ${podId} is already being migrated`);
    }

    // Get pod info
    const pod = await this.podLookupRepository.findById(podId);
    if (!pod) {
      throw new Error(`Pod ${podId} not found`);
    }

    // Get target node info
    const targetNode = await this.edgeNodeRepository.getCenterNode(targetNodeId);
    if (!targetNode) {
      throw new Error(`Target node ${targetNodeId} not found`);
    }

    // Check if already on target
    if (pod.nodeId === targetNodeId) {
      throw new Error(`Pod ${podId} is already on node ${targetNodeId}`);
    }

    const sourceNodeId = pod.nodeId ?? this.currentNodeId;

    // Create job
    const job: MigrationJob = {
      podId,
      sourceNodeId,
      targetNodeId,
      status: 'pending',
      progress: 0,
      startedAt: new Date(),
    };

    this.activeJobs.set(podId, job);

    // Mark as migrating in database
    await this.podLookupRepository.setMigrationStatus(podId, 'syncing', targetNodeId, 0);

    // Start async migration process
    this.runMigration(job).catch(error => {
      this.logger.error(`Migration failed for pod ${podId}: ${error.message}`);
      job.status = 'failed';
      job.error = error.message;
    });

    this.logger.info(`Migration started: pod=${podId}, source=${sourceNodeId}, target=${targetNodeId}`);

    return job;
  }

  /**
   * Get migration status for a pod.
   */
  public getMigrationStatus(podId: string): MigrationJob | undefined {
    return this.activeJobs.get(podId);
  }

  /**
   * Cancel an ongoing migration.
   */
  public async cancelMigration(podId: string): Promise<void> {
    const job = this.activeJobs.get(podId);
    if (!job) {
      throw new Error(`No active migration for pod ${podId}`);
    }

    if (job.status === 'done') {
      throw new Error(`Migration for pod ${podId} already completed`);
    }

    if (job.status === 'switching') {
      throw new Error(`Cannot cancel migration for pod ${podId} during switch phase`);
    }

    // Set cancellation flag
    this.cancelledJobs.add(podId);

    // Clear database status
    await this.podLookupRepository.setMigrationStatus(podId, null, null, null);

    // Mark job as failed
    job.status = 'failed';
    job.error = 'Cancelled by user';
    job.completedAt = new Date();

    this.logger.info(`Migration cancelled: pod=${podId}`);
  }

  /**
   * Check if migration is cancelled.
   */
  private isCancelled(podId: string): boolean {
    return this.cancelledJobs.has(podId);
  }

  /**
   * Run the migration process asynchronously.
   */
  private async runMigration(job: MigrationJob): Promise<void> {
    const pod = await this.podLookupRepository.findById(job.podId);
    if (!pod) {
      throw new Error(`Pod ${job.podId} not found`);
    }

    // Get target region from node metadata
    const targetNode = await this.edgeNodeRepository.getCenterNode(job.targetNodeId);
    if (!targetNode) {
      throw new Error(`Target node ${job.targetNodeId} not found`);
    }

    // Extract target region from node metadata (e.g., { region: 'gz' })
    const targetRegion = (targetNode as any).metadata?.region as string | undefined;
    if (!targetRegion) {
      throw new Error(`Target node ${job.targetNodeId} has no region configured`);
    }

    const podPrefix = new URL(pod.baseUrl).pathname;

    try {
      // Check if data accessor supports migration
      if (!this.dataAccessor || !isMigratableAccessor(this.dataAccessor)) {
        throw new Error('Storage backend does not support migration');
      }

      const accessor = this.dataAccessor as MigratableDataAccessor;

      // Phase 1: Set up real-time sync
      job.status = 'syncing';
      await this.updateProgress(job, 5);
      await accessor.setupRealtimeSync(podPrefix, targetRegion);
      await this.updateProgress(job, 10);

      // Phase 2: Bulk copy historical data
      job.status = 'copying';
      await accessor.migrateToRegion(podPrefix, targetRegion, (progress) => {
        // Check for cancellation
        if (this.isCancelled(job.podId)) {
          throw new Error('Migration cancelled');
        }

        job.objectsCopied = progress.copied;
        job.objectsTotal = progress.total;
        job.bytesTransferred = progress.bytesTransferred;

        // Map 10-90% to copy progress
        const copyProgress = 10 + Math.floor((progress.copied / Math.max(progress.total, 1)) * 80);
        this.updateProgress(job, copyProgress).catch(() => {});
      });

      // Check for cancellation before switching
      if (this.isCancelled(job.podId)) {
        throw new Error('Migration cancelled');
      }

      // Phase 3: Switch nodeId
      job.status = 'switching';
      await this.updateProgress(job, 95);
      await this.switchPodNode(job);

      // Phase 4: Stop real-time sync
      await accessor.stopRealtimeSync(podPrefix, targetRegion);

      // Done
      job.status = 'done';
      job.progress = 100;
      job.completedAt = new Date();
      
      await this.podLookupRepository.setMigrationStatus(job.podId, 'done', job.targetNodeId, 100);

      this.logger.info(`Migration completed: pod=${job.podId}, objects=${job.objectsCopied ?? 0}, bytes=${job.bytesTransferred ?? 0}`);
    } catch (error) {
      job.status = 'failed';
      job.error = (error as Error).message;
      job.completedAt = new Date();

      // Try to stop sync on failure
      if (this.dataAccessor && isMigratableAccessor(this.dataAccessor)) {
        try {
          await (this.dataAccessor as MigratableDataAccessor).stopRealtimeSync(podPrefix, targetRegion);
        } catch {
          // Ignore cleanup errors
        }
      }

      throw error;
    } finally {
      // Clean up cancellation flag
      this.cancelledJobs.delete(job.podId);
    }
  }

  /**
   * Switch the pod's nodeId to target node.
   */
  private async switchPodNode(job: MigrationJob): Promise<void> {
    await this.podLookupRepository.setNodeId(job.podId, job.targetNodeId);
    this.logger.debug(`Node switched for pod ${job.podId} to ${job.targetNodeId}`);
  }

  /**
   * Update migration progress in database.
   */
  private async updateProgress(job: MigrationJob, progress: number): Promise<void> {
    job.progress = progress;
    await this.podLookupRepository.setMigrationStatus(
      job.podId,
      'syncing',
      job.targetNodeId,
      progress,
    );
  }
}
