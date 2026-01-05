import {
  RedisLocker,
  ResourceIdentifier,
  getLoggerFor,
} from "@solid/community-server";

export class DebugRedisLocker extends RedisLocker {
  protected override logger = getLoggerFor(this);

  override async withWriteLock<T>(
    identifier: ResourceIdentifier,
    callback: () => Promise<T>,
  ): Promise<T> {
    this.logger.debug(`trying withWriteLock[${identifier.path}]`);
    const result = await super.withWriteLock(identifier, callback);
    this.logger.debug(`releasing withWriteLock[${identifier.path}]`);
    return result;
  }

  override async withReadLock<T>(
    identifier: ResourceIdentifier,
    callback: () => Promise<T>,
  ): Promise<T> {
    this.logger.debug(`trying withReadLock[${identifier.path}]`);
    const result = await super.withReadLock(identifier, callback);
    this.logger.debug(`releasing withReadLock[${identifier.path}]`);
    return result;
  }

  override async acquire(identifier: ResourceIdentifier): Promise<void> {
    this.logger.debug(`trying withLock[${identifier.path}]`);
    return await super.acquire(identifier);
  }

  override async release(identifier: ResourceIdentifier): Promise<void> {
    this.logger.debug(`releasing withLock[${identifier.path}]`);
    return await super.release(identifier);
  }
}
