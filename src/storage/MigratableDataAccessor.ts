import type { DataAccessor } from '@solid/community-server';

/**
 * Progress information for data migration.
 */
export interface MigrationProgress {
  /** Number of objects copied */
  copied: number;
  /** Total number of objects to copy */
  total: number;
  /** Bytes transferred so far */
  bytesTransferred: number;
}

/**
 * Extended DataAccessor interface for storage backends that support
 * cross-region operations.
 * 
 * Primary use: Cross-region fallback reads for instant pod migration.
 * - Reads check local bucket first, then fallback to other region buckets
 * - Lazy copy: files are copied to local bucket on first access
 * 
 * Optional: Bulk migration for cleanup/cost optimization.
 * - Not required for migration to work (fallback handles it)
 * - Can be used to proactively move cold data and reduce cross-region costs
 */
export interface MigratableDataAccessor extends DataAccessor {
  /**
   * Check if this accessor supports cross-region operations.
   */
  supportsMigration(): boolean;

  /**
   * Bulk migrate all resources under the given prefix to a target region.
   * 
   * This is OPTIONAL - migration works without it via fallback reads.
   * Use this for:
   * - Cleaning up source region to save storage costs
   * - Proactively copying cold data to reduce latency
   * 
   * @param prefix - Resource path prefix (e.g., "/alice/")
   * @param targetRegion - Target region identifier
   * @param onProgress - Optional progress callback
   * @throws Error if migration is not supported
   */
  migrateToRegion(
    prefix: string,
    targetRegion: string,
    onProgress?: (progress: MigrationProgress) => void,
  ): Promise<void>;

  /**
   * Set up real-time synchronization during active migration.
   * New writes to the source region will be replicated to the target.
   * 
   * @param prefix - Resource path prefix
   * @param targetRegion - Target region identifier
   */
  setupRealtimeSync(prefix: string, targetRegion: string): Promise<void>;

  /**
   * Stop real-time synchronization after migration completes.
   * 
   * @param prefix - Resource path prefix
   * @param targetRegion - Target region identifier
   */
  stopRealtimeSync(prefix: string, targetRegion: string): Promise<void>;
}

/**
 * Type guard to check if a DataAccessor supports cross-region operations.
 */
export function isMigratableAccessor(accessor: DataAccessor): accessor is MigratableDataAccessor {
  return (
    typeof (accessor as MigratableDataAccessor).supportsMigration === 'function' &&
    (accessor as MigratableDataAccessor).supportsMigration()
  );
}
