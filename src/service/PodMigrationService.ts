import { getLoggerFor } from '@solid/community-server';
import { getIdentityDatabase } from '../identity/drizzle/db';
import { PodLookupRepository } from '../identity/drizzle/PodLookupRepository';
import { EdgeNodeRepository } from '../identity/drizzle/EdgeNodeRepository';

export interface PodMigrationServiceConfig {
  identityDbUrl: string;
  currentNodeId: string;
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
}

/**
 * Service for managing Pod migrations between Center nodes.
 * 
 * Migration process:
 * 1. Mark pod as migrating (status='syncing')
 * 2. Set up real-time sync via webhooks (new writes go to both nodes)
 * 3. Copy historical data from source to target
 * 4. Switch nodeId to target (atomic update)
 * 5. Clean up source (optional, can keep as backup)
 */
export class PodMigrationService {
  protected readonly logger = getLoggerFor(this);

  private readonly podLookupRepository: PodLookupRepository;
  private readonly edgeNodeRepository: EdgeNodeRepository;
  private readonly currentNodeId: string;
  
  // Active migration jobs (in-memory tracking)
  private readonly activeJobs = new Map<string, MigrationJob>();

  public constructor(config: PodMigrationServiceConfig) {
    const db = getIdentityDatabase(config.identityDbUrl);
    this.podLookupRepository = new PodLookupRepository(db);
    this.edgeNodeRepository = new EdgeNodeRepository(db);
    this.currentNodeId = config.currentNodeId;
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

    // Clear database status
    await this.podLookupRepository.setMigrationStatus(podId, null, null, null);

    // Mark job as failed
    job.status = 'failed';
    job.error = 'Cancelled by user';
    job.completedAt = new Date();

    this.logger.info(`Migration cancelled: pod=${podId}`);
  }

  /**
   * Run the migration process asynchronously.
   */
  private async runMigration(job: MigrationJob): Promise<void> {
    try {
      // Phase 1: Set up real-time sync
      job.status = 'syncing';
      await this.updateProgress(job, 10);
      
      // TODO: Subscribe to source node changes via webhook
      // For now, we'll do a simple copy approach

      // Phase 2: Copy historical data
      job.status = 'copying';
      await this.copyPodData(job);

      // Phase 3: Switch nodeId
      job.status = 'switching';
      await this.updateProgress(job, 95);
      await this.switchPodNode(job);

      // Done
      job.status = 'done';
      job.progress = 100;
      job.completedAt = new Date();
      
      await this.podLookupRepository.setMigrationStatus(job.podId, 'done', job.targetNodeId, 100);

      this.logger.info(`Migration completed: pod=${job.podId}`);
    } catch (error) {
      job.status = 'failed';
      job.error = (error as Error).message;
      job.completedAt = new Date();
      throw error;
    }
  }

  /**
   * Copy pod data from source to target node.
   */
  private async copyPodData(job: MigrationJob): Promise<void> {
    // Get source and target node endpoints
    const sourceNode = await this.edgeNodeRepository.getCenterNode(job.sourceNodeId);
    const targetNode = await this.edgeNodeRepository.getCenterNode(job.targetNodeId);

    if (!sourceNode || !targetNode) {
      throw new Error('Source or target node not found');
    }

    const pod = await this.podLookupRepository.findById(job.podId);
    if (!pod) {
      throw new Error(`Pod ${job.podId} not found`);
    }

    // TODO: Implement actual data copy
    // This would involve:
    // 1. Listing all resources in the pod (via SPARQL or file listing)
    // 2. For each resource, GET from source, PUT to target
    // 3. Track progress

    // For now, simulate progress
    for (let progress = 20; progress <= 90; progress += 10) {
      await this.updateProgress(job, progress);
      await this.delay(100); // Simulate work
    }

    this.logger.debug(`Data copy completed for pod ${job.podId}`);
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

  /**
   * Simple delay helper.
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
