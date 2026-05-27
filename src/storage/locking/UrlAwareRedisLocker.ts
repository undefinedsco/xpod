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

export interface UrlAwareRedisLockerOptions {
  redisClient?: string;
  attemptSettings_retryCount?: number;
  attemptSettings_retryDelay?: number;
  attemptSettings_retryJitter?: number;
  namespacePrefix?: string;
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
