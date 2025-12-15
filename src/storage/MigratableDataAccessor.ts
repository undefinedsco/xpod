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
 * bulk data migration between regions/nodes.
 * 
 * Not all storage backends support migration. Call `supportsMigration()`
 * to check before attempting migration operations.
 */
export interface MigratableDataAccessor extends DataAccessor {
  /**
   * Check if this accessor supports migration operations.
   */
  supportsMigration(): boolean;

  /**
   * Bulk migrate all resources under the given prefix to a target region.
   * 
   * This should use the most efficient method available for the storage backend:
   * - Minio: server-side copyObject
   * - COS: cross-region replication API  
   * - Local files: cp -r or rsync
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
   * Set up real-time synchronization during migration.
   * New writes to the source region will be replicated to the target.
   * 
   * @param prefix - Resource path prefix
   * @param targetRegion - Target region identifier
   * @throws Error if real-time sync is not supported
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
 * Type guard to check if a DataAccessor supports migration.
 */
export function isMigratableAccessor(accessor: DataAccessor): accessor is MigratableDataAccessor {
  return (
    typeof (accessor as MigratableDataAccessor).supportsMigration === 'function' &&
    (accessor as MigratableDataAccessor).supportsMigration()
  );
}
