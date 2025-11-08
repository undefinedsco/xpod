import { Pool } from 'pg';
import { getLoggerFor } from '@solid/community-server';

export interface DatabaseMaintenanceOptions {
  connectionString: string;
}

/**
 * Database maintenance utilities for cleaning up invalid data
 */
export class DatabaseMaintenance {
  protected readonly logger = getLoggerFor(this);
  private readonly pool: Pool;

  public constructor(options: DatabaseMaintenanceOptions) {
    this.pool = new Pool({ connectionString: options.connectionString });
  }

  /**
   * Clean up invalid JSON values from key-value storage tables
   */
  public async cleanInvalidJsonValues(tableName: string = 'internal_kv'): Promise<number> {
    const quotedTableName = `"${tableName}"`;
    
    try {
      // First, check what we're going to delete
      const checkResult = await this.pool.query(
        `SELECT key, value::text FROM ${quotedTableName} WHERE value::text = '[object Object]' LIMIT 10`
      );
      
      const foundCount = checkResult.rowCount ?? 0;
      if (foundCount > 0) {
        this.logger.info(`Found ${foundCount} invalid JSON entries in ${tableName}:`);
        checkResult.rows.forEach(row => {
          this.logger.info(`  Key: ${row.key}, Value: ${row.value}`);
        });

        // Delete invalid values
        const deleteResult = await this.pool.query(
          `DELETE FROM ${quotedTableName} WHERE value::text = '[object Object]'`
        );
        
        const deletedCount = deleteResult.rowCount ?? 0;
        this.logger.info(`Successfully cleaned ${deletedCount} invalid entries from ${tableName}.`);
        return deletedCount;
      } else {
        this.logger.info(`No invalid JSON entries found in ${tableName}.`);
        return 0;
      }
    } catch (error: unknown) {
      this.logger.error(`Error cleaning invalid JSON values from ${tableName}: ${error}`);
      throw error;
    }
  }

  /**
   * Get statistics about the database tables
   */
  public async getTableStats(): Promise<Record<string, number>> {
    try {
      const result = await this.pool.query(`
        SELECT 
          schemaname,
          relname as tablename,
          n_tup_ins as inserts,
          n_tup_upd as updates,
          n_tup_del as deletes,
          n_live_tup as live_tuples,
          n_dead_tup as dead_tuples
        FROM pg_stat_user_tables 
        WHERE relname LIKE '%kv%' OR relname LIKE 'identity_%'
      `);
      
      const stats: Record<string, number> = {};
      result.rows.forEach(row => {
        stats[row.tablename] = row.live_tuples;
      });
      
      return stats;
    } catch (error: unknown) {
      this.logger.error(`Error getting table stats: ${error}`);
      throw error;
    }
  }

  /**
   * Close the database connection
   */
  public async close(): Promise<void> {
    await this.pool.end().catch((error: unknown) => {
      this.logger.warn(`Failed to close database pool: ${error}`);
    });
  }
}