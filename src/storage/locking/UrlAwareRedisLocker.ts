import Redis from 'ioredis';
import { RedisLocker } from '@solid/community-server';
import {
  attachRedisClientErrorHandler,
  isIgnorableRedisShutdownError,
} from '../redis/RedisClientLifecycle';

const REDIS_LUA_SCRIPTS: Record<string, string> = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@solid/community-server/dist/util/locking/scripts/RedisLuaScripts').REDIS_LUA_SCRIPTS;
  } catch {
    return {};
  }
})();

/**
 * CSS 原生 Lua 脚本创建的 lock/count key 都不带 TTL：
 * 进程在 acquire 与 release 之间崩溃时 key 永久残留，资源被永久死锁（只能手工清 Redis）。
 * 这里在相同语义上加 TTL 兜底，并在读计数归零时主动删除 key。
 */
function buildTtlLuaScripts(ttlSeconds: number): Record<string, string> {
  const ttl = Math.max(1, Math.floor(ttlSeconds));
  return {
    acquireReadLock: `
    -- Return 0 if an entry already exists.
    local lockKey = KEYS[1]..".wlock"
    if redis.call("exists", lockKey) == 1 then
      return 0
    end

    -- Increment the counter and arm the TTL backstop
    local countKey = KEYS[1]..".count"
    local count = redis.call("incr", countKey)
    redis.call("expire", countKey, ${ttl})
    return count > 0
    `,
    acquireWriteLock: `
    -- Return 0 if a lock entry already exists or read count is > 0
    local lockKey = KEYS[1]..".wlock"
    local countKey = KEYS[1]..".count"
    local count = tonumber(redis.call("get", countKey))
    if ((redis.call("exists", lockKey) == 1) or (count ~= nil and count > 0)) then
      return 0
    end

    -- Set lock with a TTL backstop and respond with 'OK' if succeeded (otherwise null)
    return redis.call("set", lockKey, "locked", "EX", ${ttl});
    `,
    releaseReadLock: `
      -- Return 1 after decreasing the counter, if counter is < 0 now: return '-ERR'
      local countKey = KEYS[1]..".count"
      local result = redis.call("decr", countKey)
      if result > 0 then
        redis.call("expire", countKey, ${ttl})
        return 1
      elseif result == 0 then
        redis.call("del", countKey)
        return 1
      else
        return redis.error_reply("Error trying to release readlock when read count was 0.")
      end
    `,
    acquireLock: `
      -- Return 0 if lock entry already exists, or 'OK' if it succeeds in setting the lock entry.
      local key = KEYS[1]..".lock"
      if redis.call("exists", key) == 1 then
        return 0
      end

      -- Return 'OK' if succeeded setting entry (with a TTL backstop)
      return redis.call("set", key, "locked", "EX", ${ttl});
      `,
  };
}

export interface UrlAwareRedisLockerOptions {
  redisClient?: string;
  attemptSettings_retryCount?: number;
  attemptSettings_retryDelay?: number;
  attemptSettings_retryJitter?: number;
  namespacePrefix?: string;
  /** TTL backstop (seconds) for Redis lock/count keys; guards against crash-leaked locks. */
  lockKeyTtlSeconds?: number;
}

/**
 * 扩展 CSS RedisLocker，支持 redis:// 和 rediss:// URL 格式。
 *
 * CSS 原生 RedisLocker.createRedisClient 是 private 的，无法 override。
 * 这里在构造函数中检测 URL 格式，如果是 URL 则用 ioredis 直接创建连接，
 * 替换掉父类构造函数中创建的（会报错的）连接。
 */
export class UrlAwareRedisLocker extends RedisLocker {
  private shuttingDown: boolean;

  constructor(options: UrlAwareRedisLockerOptions = {}) {
    const redisClient = options.redisClient ?? '127.0.0.1:6379';
    const attemptSettings = {
      retryCount: options.attemptSettings_retryCount ?? -1,
      retryDelay: options.attemptSettings_retryDelay ?? 50,
      retryJitter: options.attemptSettings_retryJitter ?? 30,
    };
    const redisSettings = {
      namespacePrefix: options.namespacePrefix ?? '',
    };

    const isUrl = redisClient.startsWith('redis://') || redisClient.startsWith('rediss://');

    if (isUrl) {
      // 传一个合法的 host:port 给父类，避免它报错
      super('127.0.0.1:6379', attemptSettings, redisSettings);

      // 关闭父类创建的无用连接
      const oldRedis = (this as any).redis as Redis;
      oldRedis.disconnect(false);

      // 用 URL 创建真正的连接
      const redis = new Redis(redisClient);

      // 注册 Lua 脚本
      for (const [name, script] of Object.entries(REDIS_LUA_SCRIPTS)) {
        redis.defineCommand(name, { numberOfKeys: 1, lua: script });
      }

      // 替换父类的 redis 实例
      (this as any).redis = redis;
      (this as any).redisRw = redis;
      (this as any).redisLock = redis;
    } else {
      super(redisClient, attemptSettings, redisSettings);
    }

    // 用带 TTL 的脚本覆盖 CSS 原生实现，兜底崩溃泄漏的锁
    const ttlScripts = buildTtlLuaScripts(options.lockKeyTtlSeconds ?? 60);
    const liveRedis = (this as any).redis as Redis;
    for (const [name, script] of Object.entries(ttlScripts)) {
      liveRedis.defineCommand(name, { numberOfKeys: 1, lua: script });
    }

    this.shuttingDown = false;
    attachRedisClientErrorHandler((this as any).redis as Redis, {
      logger: this.logger,
      label: 'UrlAwareRedisLocker',
      isShuttingDown: (): boolean => this.shuttingDown,
    });
  }

  public override async finalize(): Promise<void> {
    this.shuttingDown = true;
    const redis = (this as any).redis as Redis;

    try {
      await super.finalize();
    } catch (error: unknown) {
      if (!isIgnorableRedisShutdownError(error)) {
        throw error;
      }
    } finally {
      redis.disconnect(false);
    }
  }
}
