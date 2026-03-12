import type { Redis } from 'ioredis';
import type { Logger } from 'global-logger-factory';

export interface RedisClientLifecycleOptions {
  logger: Logger;
  label: string;
  isShuttingDown: () => boolean;
}

interface ManagedRedisClientRecord extends RedisClientLifecycleOptions {
  client: Redis;
}

interface GlobalRedisLifecycleState {
  managedRedisClients: Map<Redis, ManagedRedisClientRecord>;
  closingRedisClients: WeakSet<Redis>;
}

const REDIS_LIFECYCLE_STATE_KEY = Symbol.for('xpod.redis-client-lifecycle');

function getGlobalRedisLifecycleState(): GlobalRedisLifecycleState {
  const stateHolder = globalThis as typeof globalThis & {
    [REDIS_LIFECYCLE_STATE_KEY]?: GlobalRedisLifecycleState;
  };

  if (!stateHolder[REDIS_LIFECYCLE_STATE_KEY]) {
    stateHolder[REDIS_LIFECYCLE_STATE_KEY] = {
      managedRedisClients: new Map<Redis, ManagedRedisClientRecord>(),
      closingRedisClients: new WeakSet<Redis>(),
    };
  }

  return stateHolder[REDIS_LIFECYCLE_STATE_KEY]!;
}

const {
  managedRedisClients,
  closingRedisClients,
} = getGlobalRedisLifecycleState();

export function attachRedisClientErrorHandler(
  client: Redis,
  options: RedisClientLifecycleOptions,
): void {
  managedRedisClients.set(client, { client, ...options });
  const cleanup = (): void => {
    managedRedisClients.delete(client);
  };
  client.on('close', cleanup);
  client.on('end', cleanup);
  client.on('error', (error: unknown) => {
    if (closingRedisClients.has(client) || options.isShuttingDown()) {
      return;
    }
    const message = formatRedisError(error);
    if (!message) {
      return;
    }
    options.logger.warn(`${options.label} Redis error: ${message}`);
  });
}

export async function closeRedisClient(
  client: Redis,
  options: Omit<RedisClientLifecycleOptions, 'isShuttingDown'>,
): Promise<void> {
  closingRedisClients.add(client);
  managedRedisClients.delete(client);
  try {
    await client.quit();
  } catch (error: unknown) {
    if (!isIgnorableRedisShutdownError(error)) {
      options.logger.warn(`Failed to close ${options.label} Redis connection: ${formatRedisError(error)}`);
    }
  } finally {
    client.disconnect(false);
  }
}

export async function closeManagedRedisClients(): Promise<void> {
  const clients = Array.from(managedRedisClients.values());
  await Promise.allSettled(clients.map(async({ client, logger, label }) => {
    await closeRedisClient(client, { logger, label });
  }));
}

export function isIgnorableRedisShutdownError(error: unknown): boolean {
  const message = formatRedisError(error);
  return [
    'Connection is closed',
    'Connection is ended',
    'Connection is in closing state',
    'write EPIPE',
    'read ECONNRESET',
    'connect ECONNREFUSED',
  ].some((fragment) => message.includes(fragment));
}

function formatRedisError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
