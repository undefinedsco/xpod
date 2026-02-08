/**
 * PostgresPoolManager - 共享 PostgreSQL 连接池管理器
 *
 * 解决多个组件（PostgresKeyValueStorage, PgQuintStore 等）
 * 创建独立连接池导致的死锁问题。
 */

import { Pool } from 'pg';

interface PoolConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

interface PoolEntry {
  pool: Pool;
  refCount: number;
}

/**
 * 连接池管理器 - 按连接字符串共享连接池
 */
class PoolManager {
  private pools = new Map<string, PoolEntry>();
  private defaultConfig: PoolConfig = {
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  };

  /**
   * 获取或创建连接池
   */
  getPool(config: PoolConfig): Pool {
    const key = this.getPoolKey(config);

    let entry = this.pools.get(key);
    if (!entry) {
      const poolConfig = { ...this.defaultConfig, ...config };
      const pool = new Pool(poolConfig);

      entry = { pool, refCount: 0 };
      this.pools.set(key, entry);

      // Some tests use lightweight Pool mocks without EventEmitter APIs.
      if (typeof (pool as any).on === 'function') {
        (pool as any).on('error', () => {
          // Ignore pool-level events here; query callers handle errors.
        });
      }
    }

    entry.refCount++;
    return entry.pool;
  }

  /**
   * 释放连接池引用
   */
  releasePool(config: PoolConfig, immediate = false): void {
    const key = this.getPoolKey(config);
    const entry = this.pools.get(key);

    if (!entry) {
      return;
    }

    if (immediate) {
      entry.pool.end().catch(() => {});
      this.pools.delete(key);
      return;
    }

    entry.refCount--;

    if (entry.refCount <= 0) {
      // 延迟关闭，允许复用
      setTimeout(() => {
        const current = this.pools.get(key);
        if (current && current.refCount <= 0) {
          current.pool.end().catch(() => {});
          this.pools.delete(key);
        }
      }, 60000);
    }
  }

  /**
   * 生成连接池 key
   */
  private getPoolKey(config: PoolConfig): string {
    if (config.connectionString) {
      return config.connectionString;
    }
    return `${config.user}@${config.host}:${config.port}/${config.database}`;
  }

  listPools(): IterableIterator<[string, PoolEntry]> {
    return this.pools.entries();
  }
}

// 单例实例
const poolManager = new PoolManager();

// 定期打印连接池状态
const statusTimer = setInterval(() => {
  for (const [, entry] of poolManager.listPools()) {
    const pool = entry.pool;
    console.log(`[PostgresPoolManager] Status: total=${pool.totalCount}, idle=${pool.idleCount}, waiting=${pool.waitingCount}, refCount=${entry.refCount}`);
  }
}, 30000);
if (typeof (statusTimer as any).unref === 'function') {
  (statusTimer as any).unref();
}

/**
 * 获取共享连接池
 */
export function getSharedPool(config: PoolConfig): Pool {
  return poolManager.getPool(config);
}

/**
 * 释放共享连接池引用
 */
export function releaseSharedPool(config: PoolConfig): void {
  poolManager.releasePool(config);
}

/**
 * 释放共享连接池引用并立即关闭。
 */
export function releaseSharedPoolImmediately(config: PoolConfig): void {
  poolManager.releasePool(config, true);
}

export { poolManager };
