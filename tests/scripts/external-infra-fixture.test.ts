import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseFullIntegrationInfra, type FullIntegrationInfra } from '../../scripts/helpers/full-integration-infra';
import {
  deriveOwnedDatabaseUrl,
  objectStoreClientConfig,
  ownedResourceName,
  provisionOwnedExternalResources,
  withTestInfra,
  type ExternalInfraClients,
  type ObjectStoreLike,
  type PgAdminLike,
} from '../helpers/externalInfraFixture';

// Exercise the real default PgClient factory (not only injected, already
// connected fakes): the mocked Client refuses query() until connect() ran, so
// a factory that forgets to connect fails here.
const pgMock = vi.hoisted(() => ({ events: [] as string[], connected: false, failConnect: false }));
const storeMock = vi.hoisted(() => ({ events: [] as string[] }));
vi.mock('pg', () => ({
  Client: class {
    async connect(): Promise<void> {
      pgMock.events.push('connect');
      if (pgMock.failConnect) throw new Error('mock connect failed');
      pgMock.connected = true;
    }
    async query(text: string): Promise<unknown> {
      pgMock.events.push(`query:${text}`);
      if (!pgMock.connected) throw new Error('Client is not connected');
      return { rows: [] };
    }
    async end(): Promise<void> {
      pgMock.events.push('end');
      pgMock.connected = false;
    }
  },
}));
vi.mock('minio', () => ({
  Client: class {
    async makeBucket(bucket: string): Promise<void> { storeMock.events.push(`makeBucket:${bucket}`); }
    async *listObjectsV2(): AsyncGenerator<{ name?: string }> { /* no owned objects */ }
    async removeObject(bucket: string, name: string): Promise<void> { storeMock.events.push(`removeObject:${bucket}:${name}`); }
    async removeBucket(bucket: string): Promise<void> { storeMock.events.push(`removeBucket:${bucket}`); }
  },
}));

const validText = [
  'XPOD_FULL_PG_URL=postgres://fixture:secret@127.0.0.1:15432/fixture',
  'CSS_REDIS_CLIENT=127.0.0.1:16379',
  'CSS_REDIS_USERNAME=',
  'CSS_REDIS_PASSWORD=',
  'CSS_MINIO_ENDPOINT=http://127.0.0.1:19000',
  'CSS_MINIO_ACCESS_KEY=fixture',
  'CSS_MINIO_SECRET_KEY=secret',
  'CSS_MINIO_BUCKET_NAME=shared-content',
].join('\n');

const temporaryDirectories: string[] = [];
function temporaryFile(contents: string): string {
  const root = path.resolve('.test-data/external-infra-fixture');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(path.join(root, 'case-'));
  temporaryDirectories.push(directory);
  const file = path.join(directory, 'infra.env');
  writeFileSync(file, contents);
  return file;
}
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

interface FakeOptions { failCreate?: boolean; failBucket?: boolean; objects?: string[]; }
function fakes(options: FakeOptions = {}) {
  const queries: string[] = [];
  const calls: string[] = [];
  const pgAdmin: PgAdminLike = {
    query: async (text) => {
      queries.push(text);
      if (options.failCreate && text.startsWith('CREATE DATABASE')) throw new Error('database already exists');
      return {};
    },
    end: async () => { calls.push('pg.end'); },
  };
  const store: ObjectStoreLike = {
    makeBucket: async (bucket) => {
      calls.push(`makeBucket:${bucket}`);
      if (options.failBucket) throw new Error('BucketAlreadyOwnedByYou');
    },
    listObjectsV2: async function*(_bucket) { for (const name of options.objects ?? []) yield { name }; },
    removeObject: async (bucket, name) => { calls.push(`removeObject:${bucket}:${name}`); },
    removeBucket: async (bucket) => { calls.push(`removeBucket:${bucket}`); },
  };
  const clients: ExternalInfraClients = { pgAdmin: async () => pgAdmin, objectStore: () => store };
  return { clients, queries, calls };
}

describe('external integration infra discovery', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('uses the Docker path when XPOD_FULL_INFRA_ENV_FILE is absent', async () => {
    const startDocker = vi.fn(async () => 'docker');
    const provisionExternal = vi.fn(async () => 'external');
    const selected = await withTestInfra({ env: {}, provisionExternal, startDocker });
    expect(selected).toBe('docker');
    expect(startDocker).toHaveBeenCalledOnce();
    expect(provisionExternal).not.toHaveBeenCalled();
  });

  it('fails closed on a malformed file without starting Docker or provisioning resources', async () => {
    const file = temporaryFile('CSS_MINIO_BUCKET_NAME=fixture');
    const startDocker = vi.fn(async () => 'docker');
    const provisionExternal = vi.fn(async () => 'external');
    await expect(withTestInfra({ env: { XPOD_FULL_INFRA_ENV_FILE: file }, provisionExternal, startDocker }))
      .rejects.toThrow('Full integration external configuration invalid');
    expect(startDocker).not.toHaveBeenCalled();
    expect(provisionExternal).not.toHaveBeenCalled();
  });

  it('fails before Docker when external infra is unhealthy', async () => {
    const file = temporaryFile(validText);
    const startDocker = vi.fn(async () => 'docker');
    const provisionExternal = vi.fn(async () => 'external');
    const check = vi.fn(async () => { throw new Error('Full integration external postgres unhealthy'); });
    await expect(withTestInfra({ env: { XPOD_FULL_INFRA_ENV_FILE: file }, provisionExternal, startDocker, check }))
      .rejects.toThrow('Full integration external postgres unhealthy');
    expect(startDocker).not.toHaveBeenCalled();
    expect(provisionExternal).not.toHaveBeenCalled();
  });

  it('provisions external resources and never touches Docker when the file is valid', async () => {
    const file = temporaryFile(validText);
    const startDocker = vi.fn(async () => 'docker');
    const check = vi.fn(async () => undefined);
    const provisionExternal = vi.fn(async (_config: FullIntegrationInfra) => 'external');
    const selected = await withTestInfra({ env: { XPOD_FULL_INFRA_ENV_FILE: file }, provisionExternal, startDocker, check });
    expect(selected).toBe('external');
    expect(startDocker).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledOnce();
    expect(provisionExternal).toHaveBeenCalledOnce();
    expect(provisionExternal.mock.calls[0][0]).toMatchObject({
      XPOD_FULL_PG_URL: 'postgres://fixture:secret@127.0.0.1:15432/fixture',
      CSS_MINIO_BUCKET_NAME: 'shared-content',
    });
  });
});

describe('owned external resources', () => {
  const config = parseFullIntegrationInfra(validText);

  it('creates an owned logical database and bucket, then deletes only those', async () => {
    const { clients, queries, calls } = fakes({ objects: ['alice/one.ttl', 'alice/two.bin'] });
    const owned = await provisionOwnedExternalResources(config, { clients, namePrefix: 'pod-delete' });
    expect(queries[0]).toMatch(/^CREATE DATABASE "pod-delete-/u);
    expect(calls[0]).toMatch(/^makeBucket:pod-delete-/u);
    expect(owned.bucket).toBe(owned.databaseName);
    const parsed = new URL(owned.postgresUrl);
    expect(parsed.pathname).toBe(`/${owned.databaseName}`);
    expect(parsed.host).toBe('127.0.0.1:15432');
    expect(parsed.username).toBe('fixture');
    expect(parsed.password).toBe('secret');

    const failures = await owned.cleanup();
    expect(failures).toEqual([]);
    expect(queries).toHaveLength(2);
    expect(queries[1]).toBe(`DROP DATABASE IF EXISTS "${owned.databaseName}" WITH (FORCE)`);
    expect(calls).toContain(`removeObject:${owned.bucket}:alice/one.ttl`);
    expect(calls).toContain(`removeObject:${owned.bucket}:alice/two.bin`);
    expect(calls).toContain(`removeBucket:${owned.bucket}`);
    expect(calls.indexOf(`removeBucket:${owned.bucket}`)).toBeGreaterThan(calls.indexOf(`makeBucket:${owned.bucket}`));
  });

  it('never deletes a primary database or original bucket on a creation collision', async () => {
    const { clients, queries, calls } = fakes({ failCreate: true });
    await expect(provisionOwnedExternalResources(config, { clients })).rejects.toThrow(/Failed to provision owned external test resources/u);
    expect(calls.some((call) => call.startsWith('makeBucket'))).toBe(false);
    expect(calls).toContain('pg.end');
    expect(queries.some((query) => query.startsWith('DROP'))).toBe(false);
    expect(queries.join('\n')).not.toContain('/fixture');
  });

  it('preserves the original failure and rolls back the owned database when the bucket fails', async () => {
    const { clients, queries, calls } = fakes({ failBucket: true });
    await expect(provisionOwnedExternalResources(config, { clients })).rejects.toThrow(/BucketAlreadyOwnedByYou/u);
    expect(queries.filter((query) => query.startsWith('DROP DATABASE'))).toHaveLength(1);
    expect(queries.some((query) => /^DROP DATABASE IF EXISTS "pod-delete-/u.test(query))).toBe(true);
    expect(calls.some((call) => call.startsWith('removeBucket'))).toBe(false);
    expect(calls.some((call) => call.startsWith('removeObject'))).toBe(false);
    expect(calls.join('\n')).not.toContain('shared-content');
  });

  it('is idempotent: a second cleanup performs no destructive operation', async () => {
    const { clients, queries, calls } = fakes();
    const owned = await provisionOwnedExternalResources(config, { clients });
    await owned.cleanup();
    const queryCount = queries.length;
    const callCount = calls.length;
    expect(await owned.cleanup()).toEqual([]);
    expect(queries).toHaveLength(queryCount);
    expect(calls).toHaveLength(callCount);
  });

  it('reports, but never throws, cleanup failures', async () => {
    const { clients } = fakes();
    const store = clients.objectStore(objectStoreClientConfig(config));
    const failingStore = {
      ...store,
      removeBucket: async () => { throw new Error('bucket removal failed'); },
    };
    const failingClients: ExternalInfraClients = {
      pgAdmin: clients.pgAdmin,
      objectStore: () => failingStore,
    };
    const owned = await provisionOwnedExternalResources(config, { clients: failingClients });
    await expect(owned.cleanup()).resolves.toEqual([
      { step: 'remove-bucket', error: expect.any(Error) },
    ]);
  });
});

describe('external resource naming', () => {
  it('derives a URL that keeps credentials and changes only the database', () => {
    expect(deriveOwnedDatabaseUrl('postgres://u:p@host:15432/original', 'owned-db'))
      .toBe('postgres://u:p@host:15432/owned-db');
    expect(() => deriveOwnedDatabaseUrl('not-a-url', 'owned')).toThrow();
  });

  it('preserves PostgreSQL connection options while replacing the database', () => {
    expect(deriveOwnedDatabaseUrl(
      'postgres://u:p@host:15432/original?sslmode=require&connect_timeout=5',
      'owned-db',
    )).toBe('postgres://u:p@host:15432/owned-db?sslmode=require&connect_timeout=5');
  });

  it('uses S3-safe names that stay unique and bounded', () => {
    const first = ownedResourceName('pod-delete');
    const second = ownedResourceName('pod-delete');
    expect(first).toMatch(/^[a-z0-9-]+$/u);
    expect(first.length).toBeLessThanOrEqual(63);
    expect(first).not.toBe(second);
  });

  it('parses the object-store endpoint consistently with the infra helper', () => {
    expect(objectStoreClientConfig(parseFullIntegrationInfra(validText))).toEqual({
      endPoint: '127.0.0.1', port: 19000, useSSL: false, accessKey: 'fixture', secretKey: 'secret',
    });
  });
});

describe('default client connect contract', () => {
  const config = parseFullIntegrationInfra(validText);
  beforeEach(() => {
    pgMock.events.length = 0; pgMock.connected = false; pgMock.failConnect = false;
    storeMock.events.length = 0;
  });

  it('connects the default PgClient exactly once before creating the owned database', async () => {
    const owned = await provisionOwnedExternalResources(config, { namePrefix: 'pod-delete' });
    expect(pgMock.connected).toBe(true);
    expect(pgMock.events.filter((event) => event === 'connect')).toHaveLength(1);
    expect(pgMock.events[0]).toBe('connect');
    expect(pgMock.events.findIndex((event) => event.startsWith('query:CREATE DATABASE'))).toBeGreaterThan(0);
    expect(storeMock.events[0]).toMatch(/^makeBucket:pod-delete-/u);

    expect(await owned.cleanup()).toEqual([]);
    expect(pgMock.events).toContain('end');
    expect(pgMock.events.some((event) => event.startsWith('query:DROP DATABASE IF EXISTS "pod-delete-'))).toBe(true);
    expect(storeMock.events.some((event) => event.startsWith('removeBucket:pod-delete-'))).toBe(true);
  });

  it('closes the owned client and touches no database or bucket when connect fails', async () => {
    pgMock.failConnect = true;
    await expect(provisionOwnedExternalResources(config)).rejects.toThrow(/mock connect failed/u);
    expect(pgMock.events).toEqual(['connect', 'end']);
    expect(storeMock.events).toEqual([]);
  });
});
