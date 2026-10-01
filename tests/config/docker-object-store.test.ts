import { readFile } from 'node:fs/promises';
import { Client } from 'minio';
import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  hasObjectStore,
  OBJECT_STORE_ACCESS_KEY,
  OBJECT_STORE_BUCKET,
  OBJECT_STORE_IMAGE,
  OBJECT_STORE_PORT,
  OBJECT_STORE_SECRET_KEY,
  objectStoreContainerArgs,
} from '../helpers/dockerObjectStore';

// The Docker test stacks used to pin an official MinIO image that is no longer
// anonymously pullable (quay.io/minio/minio answers 401 for the pinned index and
// minio/minio was removed from Docker Hub), so the stacks now run the pinned
// VersityGW digest. These are static contract checks — no Docker daemon needed —
// that keep the three copies of the digest from drifting apart and stop a
// retired MinIO image from being re-introduced.
const TEST_COMPOSE_FILES = [
  'docker-compose.cluster.yml',
  'docker-compose.cluster.integration.yml',
  'docker-compose.acceptance.yml',
] as const;

const RETIRED_MINIO_IMAGES = [ 'quay.io/minio/minio', 'minio/minio:latest' ];

interface ComposeService {
  image?: string;
  environment?: Record<string, string | number> | string[];
  entrypoint?: string | string[];
  healthcheck?: { test?: string | string[]; disable?: boolean };
  ports?: Array<string | number | { target?: number; published?: string | number }>;
}

interface ComposeFile {
  services?: Record<string, ComposeService>;
}

async function readCompose(file: string): Promise<ComposeFile> {
  return parse(await readFile(file, 'utf8')) as ComposeFile;
}

function environmentOf(service: ComposeService | undefined): Record<string, string> {
  const raw = service?.environment ?? {};
  if (Array.isArray(raw)) {
    return Object.fromEntries(raw.map((entry) => {
      const [ key, ...rest ] = entry.split('=');
      return [ key, rest.join('=') ];
    }));
  }
  return Object.fromEntries(Object.entries(raw).map(([ key, value ]) => [ key, String(value) ]));
}

/** Merge the `minio` service as Compose does: later files win per key. */
function mergeMinioService(...files: ComposeFile[]): ComposeService {
  const merged: ComposeService = {};
  const environment: Record<string, string> = {};
  for (const file of files) {
    const service = file.services?.minio;
    if (!service) continue;
    Object.assign(merged, service);
    Object.assign(environment, environmentOf(service));
  }
  merged.environment = environment;
  return merged;
}

function healthcheckCommand(service: ComposeService): string {
  const test = service.healthcheck?.test;
  if (Array.isArray(test)) return test.join(' ');
  return test ?? '';
}

function publishedPorts(service: ComposeService): number[] {
  return (service.ports ?? []).map((entry) => {
    if (typeof entry === 'object' && entry !== null) {
      return Number(entry.published ?? entry.target);
    }
    return Number(String(entry).split(':').pop());
  }).filter((port) => Number.isInteger(port));
}

describe('Docker test object store fixture', () => {
  it('pins an immutable, multi-arch VersityGW digest instead of the retired MinIO images', () => {
    expect(OBJECT_STORE_IMAGE).toMatch(/^ghcr\.io\/versity\/versitygw@sha256:[0-9a-f]{64}$/);
  });

  it.each(TEST_COMPOSE_FILES)('%s points the minio service at the shared pinned digest', async(file) => {
    const service = (await readCompose(file)).services?.minio;
    expect(service, `${file} must keep the S3 service named "minio"`).toBeTruthy();
    expect(service?.image).toBe(OBJECT_STORE_IMAGE);
  });

  it('uses the posix backend, shared credentials, port and bucket across the stacks', async() => {
    const clusterMinio = mergeMinioService(
      await readCompose('docker-compose.cluster.yml'),
      await readCompose('docker-compose.cluster.integration.yml'),
    );
    const acceptanceMinio = (await readCompose('docker-compose.acceptance.yml')).services?.minio as ComposeService;

    for (const minio of [ clusterMinio, acceptanceMinio ]) {
      const env = environmentOf(minio);
      expect(env.VGW_BACKEND).toBe('posix');
      expect(env.VGW_ARGS).toContain(`:${OBJECT_STORE_PORT}`);
    }

    // Acceptance keeps the stack on its private network, so only the cluster
    // stack (used by the full runner on the host) publishes the S3 port.
    expect(publishedPorts(clusterMinio)).toContain(OBJECT_STORE_PORT);

    const clusterEnv = environmentOf(clusterMinio);
    expect(clusterEnv.ROOT_ACCESS_KEY).toBe(OBJECT_STORE_ACCESS_KEY);
    expect(clusterEnv.ROOT_SECRET_KEY).toBe(OBJECT_STORE_SECRET_KEY);

    for (const minio of [ clusterMinio, acceptanceMinio ]) {
      const entrypoint = Array.isArray(minio.entrypoint) ? minio.entrypoint.join(' ') : String(minio.entrypoint);
      expect(entrypoint).toContain('mkdir -p');
      expect(entrypoint).toContain(OBJECT_STORE_BUCKET);
      expect(entrypoint).toContain('/usr/local/bin/docker-entrypoint.sh');
    }

    // The helper that launches one-off containers must agree with compose.
    const helperArgs = objectStoreContainerArgs(OBJECT_STORE_BUCKET);
    for (const key of [ 'ROOT_ACCESS_KEY', 'ROOT_SECRET_KEY', 'VGW_BACKEND', 'VGW_BACKEND_ARG', 'VGW_ARGS' ]) {
      expect(helperArgs.some((arg) => arg.startsWith(`${key}=`))).toBe(true);
    }
  });

  it('probes the S3 listener instead of the MinIO-only health path, without disabling healthchecks', async() => {
    const clusterMinio = mergeMinioService(
      await readCompose('docker-compose.cluster.yml'),
      await readCompose('docker-compose.cluster.integration.yml'),
    );
    const acceptanceMinio = (await readCompose('docker-compose.acceptance.yml')).services?.minio as ComposeService;

    for (const minio of [ clusterMinio, acceptanceMinio ]) {
      expect(minio.healthcheck?.disable).not.toBe(true);
      const probe = healthcheckCommand(minio);
      expect(probe.length).toBeGreaterThan(0);
      expect(probe).not.toContain('/minio/health/live');
      expect(probe).toContain('nc');
      expect(probe).toContain(String(OBJECT_STORE_PORT));
    }
  });

  it('leaves no retired MinIO image on any compose service', async() => {
    for (const file of TEST_COMPOSE_FILES) {
      const compose = await readCompose(file);
      for (const [ name, service ] of Object.entries(compose.services ?? {})) {
        const image = String(service?.image ?? '');
        for (const retired of RETIRED_MINIO_IMAGES) {
          expect(image, `${file} service "${name}" must not use ${retired}`).not.toContain(retired);
        }
      }
    }
  });
});


// The full runner aborts its bounded wait if the readiness probe throws instead
// of reporting "not ready": a container that resets the connection while it is
// still starting (ECONNRESET on http://127.0.0.1:9000/xpod?location) used to
// reject `waitForInfraServices`'s Promise.all and tear the stack down. These
// cases pin the helper's classification so only connection-level failures read
// as "not ready" while permanent failures stay loud.
describe('hasObjectStore readiness semantics', () => {
  // Install and restore per test so the spy can never leak its stub into the
  // real implementation used elsewhere in this process.
  let bucketExists: MockInstance;

  beforeEach(() => {
    bucketExists = vi.spyOn(Client.prototype, 'bucketExists');
  });

  afterEach(() => {
    bucketExists.mockRestore();
  });

  it('reports "not ready" when the socket is reset before the S3 server accepts', async () => {
    bucketExists.mockRejectedValueOnce(
      Object.assign(new Error('The socket connection was closed unexpectedly'), { code: 'ECONNRESET' }),
    );
    await expect(hasObjectStore(OBJECT_STORE_PORT, OBJECT_STORE_BUCKET)).resolves.toBe(false);
  });

  it('reports "not ready" for refusals and for undici/aggregate wrapped causes', async () => {
    bucketExists.mockRejectedValueOnce(
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9000'), { code: 'ECONNREFUSED' }),
    );
    await expect(hasObjectStore(OBJECT_STORE_PORT, OBJECT_STORE_BUCKET)).resolves.toBe(false);

    const wrapped = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    });
    bucketExists.mockRejectedValueOnce(wrapped);
    await expect(hasObjectStore(OBJECT_STORE_PORT, OBJECT_STORE_BUCKET)).resolves.toBe(false);

    const aggregate = Object.assign(new AggregateError([
      Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    ], 'all attempts failed'), { code: 'ECONNREFUSED' });
    bucketExists.mockRejectedValueOnce(aggregate);
    await expect(hasObjectStore(OBJECT_STORE_PORT, OBJECT_STORE_BUCKET)).resolves.toBe(false);
  });

  it('reports "not ready" when the bucket does not exist yet', async () => {
    bucketExists.mockResolvedValueOnce(false);
    await expect(hasObjectStore(OBJECT_STORE_PORT, OBJECT_STORE_BUCKET)).resolves.toBe(false);
  });

  it('reports ready only when the authenticated bucket probe succeeds', async () => {
    bucketExists.mockResolvedValueOnce(true);
    await expect(hasObjectStore(OBJECT_STORE_PORT, OBJECT_STORE_BUCKET)).resolves.toBe(true);
  });

  it('never reports a wrong-secret endpoint as ready', async () => {
    bucketExists.mockRejectedValue(
      Object.assign(new Error('The request signature we calculated does not match'), {
        name: 'S3Error',
        code: 'SignatureDoesNotMatch',
      }),
    );
    await expect(hasObjectStore(OBJECT_STORE_PORT, OBJECT_STORE_BUCKET, OBJECT_STORE_ACCESS_KEY, 'wrong-secret'))
      .rejects.toThrow(/signature/i);
  });

  it('re-throws configuration errors instead of masking them as "not ready"', async () => {
    bucketExists.mockRejectedValueOnce(
      Object.assign(new Error('Invalid bucket name: nope'), { name: 'InvalidBucketNameError' }),
    );
    await expect(hasObjectStore(OBJECT_STORE_PORT, 'nope')).rejects.toThrow(/Invalid bucket name/);
  });
});
