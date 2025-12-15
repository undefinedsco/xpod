import { getLoggerFor } from '@solid/community-server';
import { getIdentityDatabase } from '../identity/drizzle/db';
import { PodLookupRepository } from '../identity/drizzle/PodLookupRepository';
import { EdgeNodeRepository, type CenterNodeInfo } from '../identity/drizzle/EdgeNodeRepository';

export interface PodMigrationServiceConfig {
  identityDbUrl: string;
  currentNodeId: string;
  /** Timeout for HTTP requests in ms (default: 30000) */
  httpTimeout?: number;
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
  /** Number of resources copied */
  resourcesCopied?: number;
  /** Total resources to copy */
  resourcesTotal?: number;
  /** Whether this is a shared-storage migration (no data copy needed) */
  sharedStorage?: boolean;
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
 * 
 * In shared-storage mode (same PostgreSQL + COS), no data copy is needed -
 * just switch the nodeId routing.
 */
export class PodMigrationService {
  protected readonly logger = getLoggerFor(this);

  private readonly podLookupRepository: PodLookupRepository;
  private readonly edgeNodeRepository: EdgeNodeRepository;
  private readonly currentNodeId: string;
  private readonly httpTimeout: number;
  
  // Active migration jobs (in-memory tracking)
  private readonly activeJobs = new Map<string, MigrationJob>();
  
  // Cancellation flags
  private readonly cancelledJobs = new Set<string>();

  public constructor(config: PodMigrationServiceConfig) {
    const db = getIdentityDatabase(config.identityDbUrl);
    this.podLookupRepository = new PodLookupRepository(db);
    this.edgeNodeRepository = new EdgeNodeRepository(db);
    this.currentNodeId = config.currentNodeId;
    this.httpTimeout = config.httpTimeout ?? 30000;
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
    try {
      // Phase 1: Set up real-time sync
      job.status = 'syncing';
      await this.updateProgress(job, 10);
      
      // TODO: Subscribe to source node changes via webhook
      // For now, we'll do a simple copy approach (brief sync window)

      // Phase 2: Copy historical data
      job.status = 'copying';
      await this.copyPodData(job);

      // Check for cancellation before switching
      if (this.isCancelled(job.podId)) {
        throw new Error('Migration cancelled');
      }

      // Phase 3: Switch nodeId
      job.status = 'switching';
      await this.updateProgress(job, 95);
      await this.switchPodNode(job);

      // Done
      job.status = 'done';
      job.progress = 100;
      job.completedAt = new Date();
      
      await this.podLookupRepository.setMigrationStatus(job.podId, 'done', job.targetNodeId, 100);

      this.logger.info(`Migration completed: pod=${job.podId}, sharedStorage=${job.sharedStorage}, resources=${job.resourcesCopied ?? 0}`);
    } catch (error) {
      job.status = 'failed';
      job.error = (error as Error).message;
      job.completedAt = new Date();
      throw error;
    } finally {
      // Clean up cancellation flag
      this.cancelledJobs.delete(job.podId);
    }
  }

  /**
   * Copy pod data from source to target node.
   * 
   * In shared-storage mode (when source and target share the same
   * PostgreSQL/COS backend), this is a no-op - data is already accessible.
   * 
   * In non-shared mode, we need to:
   * 1. List all resources in the pod via container traversal
   * 2. GET each resource from source node
   * 3. PUT each resource to target node
   */
  private async copyPodData(job: MigrationJob): Promise<void> {
    const sourceNode = await this.edgeNodeRepository.getCenterNode(job.sourceNodeId);
    const targetNode = await this.edgeNodeRepository.getCenterNode(job.targetNodeId);

    if (!sourceNode || !targetNode) {
      throw new Error('Source or target node not found');
    }

    const pod = await this.podLookupRepository.findById(job.podId);
    if (!pod) {
      throw new Error(`Pod ${job.podId} not found`);
    }

    // Check if this is shared storage mode
    // In shared mode, both nodes point to the same backend, so no copy needed
    const isSharedStorage = await this.isSharedStorageMode(sourceNode, targetNode);
    
    if (isSharedStorage) {
      job.sharedStorage = true;
      this.logger.info(`Shared storage mode detected for pod ${job.podId}, skipping data copy`);
      await this.updateProgress(job, 90);
      return;
    }

    // Non-shared mode: need to copy data via HTTP
    job.sharedStorage = false;
    
    const sourceEndpoint = this.getNodeEndpoint(sourceNode);
    const targetEndpoint = this.getNodeEndpoint(targetNode);
    
    // List all resources in the pod
    const resources = await this.listPodResources(sourceEndpoint, pod.baseUrl);
    job.resourcesTotal = resources.length;
    job.resourcesCopied = 0;

    this.logger.info(`Copying ${resources.length} resources for pod ${job.podId}`);

    // Copy each resource
    for (let i = 0; i < resources.length; i++) {
      // Check for cancellation
      if (this.isCancelled(job.podId)) {
        throw new Error('Migration cancelled');
      }

      const resourcePath = resources[i];
      
      try {
        await this.copyResource(sourceEndpoint, targetEndpoint, resourcePath);
        job.resourcesCopied = i + 1;
      } catch (error) {
        this.logger.warn(`Failed to copy resource ${resourcePath}: ${(error as Error).message}`);
        // Continue with other resources, don't fail entire migration
      }

      // Update progress (20% to 90% range for copying)
      const copyProgress = 20 + Math.floor((i + 1) / resources.length * 70);
      await this.updateProgress(job, copyProgress);
    }

    this.logger.info(`Data copy completed for pod ${job.podId}: ${job.resourcesCopied}/${job.resourcesTotal} resources`);
  }

  /**
   * Check if source and target nodes share the same storage backend.
   * This is a heuristic - in production, nodes in the same cluster
   * typically share PostgreSQL and COS.
   */
  private async isSharedStorageMode(sourceNode: CenterNodeInfo, targetNode: CenterNodeInfo): Promise<boolean> {
    // For now, assume shared storage if both nodes are in the same cluster
    // (same internal IP prefix or same database)
    // A more robust check would query node metadata for storage config
    
    // Heuristic: if nodes are on the same /16 subnet, likely same cluster
    const sourcePrefix = sourceNode.internalIp.split('.').slice(0, 2).join('.');
    const targetPrefix = targetNode.internalIp.split('.').slice(0, 2).join('.');
    
    if (sourcePrefix === targetPrefix) {
      return true;
    }
    
    // TODO: Add more sophisticated check via node metadata
    // For now, default to non-shared to be safe
    return false;
  }

  /**
   * Get HTTP endpoint for a node.
   */
  private getNodeEndpoint(node: CenterNodeInfo): string {
    return `http://${node.internalIp}:${node.internalPort}`;
  }

  /**
   * List all resources in a pod by traversing containers.
   */
  private async listPodResources(endpoint: string, podBaseUrl: string): Promise<string[]> {
    const resources: string[] = [];
    const visited = new Set<string>();
    
    // Parse the pod path from the base URL
    const podPath = new URL(podBaseUrl).pathname;
    
    // Start from the pod root container
    await this.traverseContainer(endpoint, podPath, resources, visited);
    
    return resources;
  }

  /**
   * Recursively traverse a container and collect resource paths.
   */
  private async traverseContainer(
    endpoint: string,
    containerPath: string,
    resources: string[],
    visited: Set<string>,
  ): Promise<void> {
    if (visited.has(containerPath)) {
      return;
    }
    visited.add(containerPath);

    try {
      // GET the container to list its contents
      const response = await fetch(`${endpoint}${containerPath}`, {
        method: 'GET',
        headers: {
          'Accept': 'text/turtle',
        },
        signal: AbortSignal.timeout(this.httpTimeout),
      });

      if (!response.ok) {
        this.logger.warn(`Failed to list container ${containerPath}: ${response.status}`);
        return;
      }

      const turtle = await response.text();
      
      // Parse LDP contains relationships from Turtle
      // Look for ldp:contains <resource> patterns
      const containsPattern = /ldp:contains\s+<([^>]+)>/g;
      let match;
      
      while ((match = containsPattern.exec(turtle)) !== null) {
        const resourceUri = match[1];
        // Convert absolute URI to path
        const resourcePath = resourceUri.startsWith('http') 
          ? new URL(resourceUri).pathname 
          : resourceUri;

        if (resourcePath.endsWith('/')) {
          // It's a container, recurse
          await this.traverseContainer(endpoint, resourcePath, resources, visited);
        } else {
          // It's a resource, add to list
          resources.push(resourcePath);
        }
      }
      
      // Also add the container itself (for metadata)
      resources.push(containerPath);
      
    } catch (error) {
      this.logger.warn(`Error traversing container ${containerPath}: ${(error as Error).message}`);
    }
  }

  /**
   * Copy a single resource from source to target.
   */
  private async copyResource(
    sourceEndpoint: string,
    targetEndpoint: string,
    resourcePath: string,
  ): Promise<void> {
    // GET from source
    const getResponse = await fetch(`${sourceEndpoint}${resourcePath}`, {
      method: 'GET',
      signal: AbortSignal.timeout(this.httpTimeout),
    });

    if (!getResponse.ok) {
      throw new Error(`GET failed: ${getResponse.status}`);
    }

    const contentType = getResponse.headers.get('content-type') ?? 'application/octet-stream';
    const body = await getResponse.arrayBuffer();

    // PUT to target
    const putResponse = await fetch(`${targetEndpoint}${resourcePath}`, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
      },
      body: Buffer.from(body),
      signal: AbortSignal.timeout(this.httpTimeout),
    });

    if (!putResponse.ok && putResponse.status !== 201 && putResponse.status !== 204) {
      throw new Error(`PUT failed: ${putResponse.status}`);
    }

    this.logger.debug(`Copied resource: ${resourcePath}`);
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
