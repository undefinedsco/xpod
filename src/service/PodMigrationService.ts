import { getLoggerFor } from 'global-logger-factory';
import { getIdentityDatabase } from '../identity/drizzle/db';
import { PodLookupRepository } from '../identity/drizzle/PodLookupRepository';
import { EdgeNodeRepository } from '../identity/drizzle/EdgeNodeRepository';

export interface PodMigrationServiceConfig {
  identityDbUrl: string;
  currentNodeId: string;
}

export interface MigrationResult {
  podId: string;
  sourceNodeId: string;
  targetNodeId: string;
  migratedAt: Date;
}

/**
 * Service for managing Pod migrations between Center nodes.
 * 
 * Simplified migration process:
 * 1. Validate pod and target node exist
 * 2. Update nodeId to target node (atomic update)
 * 
 * Data does NOT need to be copied upfront:
 * - Metadata is in shared PostgreSQL (Quadstore), already accessible from all nodes
 * - Binary files use presigned URL redirect (302) from object storage
 * 
 * This provides instant, user-transparent migration.
 */
export class PodMigrationService {
  protected readonly logger = getLoggerFor(this);

  private readonly podLookupRepository: PodLookupRepository;
  private readonly edgeNodeRepository: EdgeNodeRepository;
  private readonly currentNodeId: string;

  public constructor(config: PodMigrationServiceConfig) {
    const db = getIdentityDatabase(config.identityDbUrl);
    this.podLookupRepository = new PodLookupRepository(db);
    this.edgeNodeRepository = new EdgeNodeRepository(db);
    this.currentNodeId = config.currentNodeId;
  }

  /**
   * Migrate a pod to a different node.
   * 
   * This is instant - only updates the nodeId in database.
   * Subsequent requests will be routed to the new node.
   * Binary files are read via cross-region fallback if not present locally.
   */
  public async migratePod(podId: string, targetNodeId: string): Promise<MigrationResult> {
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

    const sourceNodeId = pod.nodeId ?? this.currentNodeId;

    // Check if already on target
    if (sourceNodeId === targetNodeId) {
      throw new Error(`Pod ${podId} is already on node ${targetNodeId}`);
    }

    // Update nodeId - this is the only thing we need to do!
    await this.podLookupRepository.setNodeId(podId, targetNodeId);

    this.logger.info(`Pod migrated: pod=${podId}, source=${sourceNodeId}, target=${targetNodeId}`);

    return {
      podId,
      sourceNodeId,
      targetNodeId,
      migratedAt: new Date(),
    };
  }

  /**
   * Get which node a pod is currently on.
   */
  public async getPodNode(podId: string): Promise<string | null> {
    const pod = await this.podLookupRepository.findById(podId);
    return pod?.nodeId ?? null;
  }
}
