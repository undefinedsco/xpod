import { Client } from 'minio';

/**
 * Test-only S3 endpoint shared by the Docker-backed integration helpers.
 *
 * Xpod's tests only need a small, path-style S3 endpoint: `MinioDataAccessor`
 * stores unstructured Pod data through the `minio` npm client, and the
 * integration runners point the Cloud node at it with the `CSS_MINIO_*`
 * variables.
 *
 * The official MinIO images can no longer be pulled anonymously
 * (`quay.io/minio/minio` answers 401 for the index this repository used to pin,
 * and `minio/minio` was removed from Docker Hub), so the test stacks run
 * VersityGW instead: an Apache-2.0 Go S3 gateway that serves the same
 * path-style S3 API on the same port with the same root credentials. That
 * keeps `MinioDataAccessor`, `CSS_MINIO_*` and every test unchanged while
 * shrinking the image from ~58 MiB to ~28 MiB compressed and ~350 MiB to
 * ~93 MiB on disk.
 *
 * Keep this digest in sync with `docker-compose.cluster.yml`,
 * `docker-compose.cluster.integration.yml` and `docker-compose.acceptance.yml`.
 */
export const OBJECT_STORE_IMAGE =
  'ghcr.io/versity/versitygw@sha256:30292fc2eeacc67a36993b01f7a7a5e3361a19cced0e80c1d71cfa2a4b0a2499';

/** Fixed container listener port; Full host publications may use a different port. */
export const OBJECT_STORE_PORT = 9000;
export const OBJECT_STORE_ACCESS_KEY = 'minioadmin';
export const OBJECT_STORE_SECRET_KEY = 'minioadmin';

/** Bucket the test stacks pre-create, since no Xpod code creates buckets. */
export const OBJECT_STORE_BUCKET = 'xpod';

/**
 * `docker run` arguments that boot the object store with `bucket` pre-created.
 *
 * The posix backend treats every directory below its root as a bucket, and no
 * code in Xpod creates buckets, so the container creates the test bucket
 * before handing over to the image entrypoint.
 */
export function objectStoreContainerArgs(bucket: string): string[] {
  return [
    '-e', `ROOT_ACCESS_KEY=${OBJECT_STORE_ACCESS_KEY}`,
    '-e', `ROOT_SECRET_KEY=${OBJECT_STORE_SECRET_KEY}`,
    '-e', 'VGW_BACKEND=posix',
    '-e', 'VGW_BACKEND_ARG=/data',
    '-e', `VGW_ARGS=--port :${OBJECT_STORE_PORT}`,
    '--entrypoint', 'sh',
    OBJECT_STORE_IMAGE,
    '-c', `mkdir -p /data/${bucket} && exec /usr/local/bin/docker-entrypoint.sh`,
  ];
}

/**
 * errno-style codes a service that has not started listening yet (or whose
 * container port is published before the process accepts) produces. These come
 * from Node's net layer directly, from undici's `fetch` wrappers
 * (`TypeError: fetch failed` with the real code under `cause`), or from Bun's
 * fetch error, which carries the code on the error itself.
 */
const TRANSIENT_TRANSPORT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  'ERR_HTTP_REQUEST_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_CONNECT_ERROR',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/**
 * True only for connection-level failures, walking the `cause` chain and any
 * `AggregateError` members so the same classification works for Node, undici
 * and Bun. A server that answered with an S3 error code is *not* a transport
 * failure and must not be mistaken for one.
 */
function isTransientTransportError(error: unknown): boolean {
  const seen = new Set<unknown>();
  const queue: unknown[] = [ error ];
  while (queue.length > 0) {
    const current = queue.shift();
    if (typeof current !== 'object' || current === null || seen.has(current)) {
      continue;
    }
    seen.add(current);
    const candidate = current as { code?: unknown; name?: unknown; cause?: unknown; errors?: unknown };
    if (typeof candidate.code === 'string' && TRANSIENT_TRANSPORT_CODES.has(candidate.code)) {
      return true;
    }
    if (typeof candidate.cause === 'object' && candidate.cause !== null) {
      queue.push(candidate.cause);
    }
    if (Array.isArray(candidate.errors)) {
      queue.push(...candidate.errors);
    }
  }
  return false;
}

/**
 * Readiness probe for the object store: the authenticated bucket probe the
 * accessor itself needs, so an endpoint that listens but cannot serve the test
 * bucket is not reported as ready.
 *
 * Transport failures return a diagnostic verdict. While a container is still coming up,
 * `ECONNRESET`/`ECONNREFUSED` is the *expected* reply, and a caller that retries
 * has to be able to retry: an escaping rejection used to abort a 60-attempt
 * readiness loop on its first try (and, under Bun, to kill the runner with an
 * unhandled error), which is what made the full integration stack look flaky.
 * The reason travels with the verdict so a caller that does give up can say why.
 * Permanent S3/configuration errors still throw, rather than waiting out the readiness deadline.
 */
export async function probeObjectStore(
  port: number,
  bucket: string,
  accessKey = OBJECT_STORE_ACCESS_KEY,
  secretKey = OBJECT_STORE_SECRET_KEY,
): Promise<{ ok: boolean; detail: string }> {
  const client = new Client({
    endPoint: '127.0.0.1',
    port,
    useSSL: false,
    accessKey,
    secretKey,
  });
  try {
    const exists = await client.bucketExists(bucket);
    return {
      ok: exists,
      detail: exists ? `bucket ${bucket} is served on :${port}` : `bucket ${bucket} does not exist on :${port}`,
    };
  } catch (error) {
    if (!isTransientTransportError(error)) throw error;
    const failure = error as Error & { code?: string | number };
    const detail = `${failure.code !== undefined ? `code ${String(failure.code)}: ` : ''}${failure.message}`;
    return { ok: false, detail: detail.replace(/\s+/gu, ' ').slice(0, 200) };
  }
}

export async function hasObjectStore(
  port: number,
  bucket: string,
  accessKey = OBJECT_STORE_ACCESS_KEY,
  secretKey = OBJECT_STORE_SECRET_KEY,
): Promise<boolean> {
  return (await probeObjectStore(port, bucket, accessKey, secretKey)).ok;
}
