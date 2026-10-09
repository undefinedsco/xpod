import { randomUUID } from 'node:crypto';
import { Client as PgClient } from 'pg';
import { Client as ObjectStoreClient } from 'minio';
import {
  checkFullIntegrationInfra,
  loadFullIntegrationInfra,
  type FullIntegrationInfra,
} from '../../scripts/helpers/full-integration-infra';

/** A destructive cleanup step that failed; collected instead of thrown so the
 * original test failure is never replaced. */
export interface CleanupFailure {
  step: string;
  error: unknown;
}

export interface ObjectStoreClientConfig {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
}

export interface ObjectStoreLike {
  makeBucket(bucket: string, region?: string): Promise<void>;
  listObjectsV2(
    bucket: string,
    prefix?: string,
    recursive?: boolean,
  ): AsyncIterable<{ name?: string }> | Promise<AsyncIterable<{ name?: string }>>;
  removeObject(bucket: string, name: string): Promise<void>;
  removeBucket(bucket: string): Promise<void>;
}

export interface PgAdminLike {
  query(text: string): Promise<unknown>;
  end(): Promise<void>;
}

export interface ExternalInfraClients {
  /**
   * Resolves a client that is already connected. If the connection cannot be
   * established the factory closes the owned client and rejects; callers must
   * not attempt any database operation after a rejection.
   */
  pgAdmin(connectionString: string): Promise<PgAdminLike>;
  objectStore(config: ObjectStoreClientConfig): ObjectStoreLike;
}

export interface OwnedExternalResources {
  databaseName: string;
  /** Connection string for the owned logical database. */
  postgresUrl: string;
  bucket: string;
  objectStore: ObjectStoreClientConfig;
  /** Drops the owned database and removes the owned bucket; never deletes
   * the primary database or the original bucket, and never throws. */
  cleanup(): Promise<CleanupFailure[]>;
}

const defaultClients: ExternalInfraClients = {
  pgAdmin: async (connectionString) => {
    const client = new PgClient({ connectionString });
    try {
      await client.connect();
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
    return client;
  },
  objectStore: (config) => new ObjectStoreClient(config),
};

export function objectStoreClientConfig(config: FullIntegrationInfra): ObjectStoreClientConfig {
  const url = new URL(config.CSS_MINIO_ENDPOINT);
  return {
    endPoint: url.hostname,
    port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    useSSL: url.protocol === 'https:',
    accessKey: config.CSS_MINIO_ACCESS_KEY,
    secretKey: config.CSS_MINIO_SECRET_KEY,
  };
}

/** A unique, S3-safe and PostgreSQL-quotable resource name. */
export function ownedResourceName(prefix: string): string {
  return `${prefix}-${process.pid}-${randomUUID().slice(0, 8)}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 63);
}

export function deriveOwnedDatabaseUrl(adminUrl: string, databaseName: string): string {
  const url = new URL(adminUrl);
  // Replace only the database name: PostgreSQL connection options carried in
  // the query string (sslmode, connect_timeout, ...) must survive the rewrite.
  url.pathname = `/${databaseName}`;
  url.hash = '';
  return url.toString();
}

/**
 * Selects the external infrastructure when `XPOD_FULL_INFRA_ENV_FILE` is set.
 *
 * A malformed file or an unhealthy external service throws before any resource
 * (or Docker) operation; there is no fallback to the Docker fixture.
 */
export async function withTestInfra<T>(options: {
  env: NodeJS.ProcessEnv;
  provisionExternal: (config: FullIntegrationInfra) => Promise<T>;
  startDocker: () => Promise<T>;
  load?: (file: string | undefined) => Promise<FullIntegrationInfra | undefined>;
  check?: (config: FullIntegrationInfra) => Promise<void>;
}): Promise<T> {
  const load = options.load ?? loadFullIntegrationInfra;
  const check = options.check ?? checkFullIntegrationInfra;
  const config = await load(options.env.XPOD_FULL_INFRA_ENV_FILE);
  if (!config) return options.startDocker();
  await check(config);
  return options.provisionExternal(config);
}

/**
 * Creates test-owned resources inside the provided ephemeral external
 * infrastructure. Ownership is only recorded after a successful create, so
 * cleanup can never delete a pre-existing database or the shared bucket.
 */
export async function provisionOwnedExternalResources(
  config: FullIntegrationInfra,
  options: { clients?: ExternalInfraClients; namePrefix?: string } = {},
): Promise<OwnedExternalResources> {
  const clients = options.clients ?? defaultClients;
  const name = ownedResourceName(options.namePrefix ?? 'pod-delete');
  const objectStore = objectStoreClientConfig(config);
  const store = clients.objectStore(objectStore);
  const ownership = { database: false, bucket: false };
  let admin: PgAdminLike | undefined;
  let adminClosed = false;

  const closeAdmin = async (): Promise<void> => {
    if (!admin || adminClosed) return;
    adminClosed = true;
    try { await admin.end(); } catch { /* closing is not a cleanup failure */ }
  };

  const cleanup = async (): Promise<CleanupFailure[]> => {
    const failures: CleanupFailure[] = [];
    if (ownership.database && admin) {
      ownership.database = false;
      try { await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); }
      catch (error) { failures.push({ step: 'drop-database', error }); }
    }
    if (ownership.bucket) {
      ownership.bucket = false;
      try {
        const stream = await store.listObjectsV2(name, '', true);
        for await (const object of stream) {
          if (object.name) await store.removeObject(name, object.name);
        }
        await store.removeBucket(name);
      } catch (error) { failures.push({ step: 'remove-bucket', error }); }
    }
    await closeAdmin();
    return failures;
  };

  try {
    // Resolve a connected client only here: a connection failure closes the
    // owned client inside the factory and must not run any resource operation.
    admin = await clients.pgAdmin(config.XPOD_FULL_PG_URL);
    await admin.query(`CREATE DATABASE "${name}"`);
    ownership.database = true;
    await store.makeBucket(name);
    ownership.bucket = true;
    return {
      databaseName: name,
      postgresUrl: deriveOwnedDatabaseUrl(config.XPOD_FULL_PG_URL, name),
      bucket: name,
      objectStore,
      cleanup,
    };
  } catch (error) {
    const failures = await cleanup();
    const cleanupDetail = failures
      .map(({ step, error: failure }) => `${step}: ${failure instanceof Error ? failure.message : String(failure)}`)
      .join('; ');
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to provision owned external test resources: ${message}${cleanupDetail ? ` (cleanup ${cleanupDetail})` : ''}`,
    );
  }
}
