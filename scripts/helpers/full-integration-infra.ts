import { readFile } from 'node:fs/promises';
import { parse } from 'dotenv';
import { Client as PostgresClient } from 'pg';
import Redis from 'ioredis';
import { Client as S3Client } from 'minio';

const keys = [
  'XPOD_FULL_PG_URL', 'CSS_REDIS_CLIENT', 'CSS_REDIS_USERNAME', 'CSS_REDIS_PASSWORD',
  'CSS_MINIO_ENDPOINT', 'CSS_MINIO_ACCESS_KEY', 'CSS_MINIO_SECRET_KEY', 'CSS_MINIO_BUCKET_NAME',
] as const;
export type FullIntegrationInfra = Record<typeof keys[number], string>;
const invalid = (): Error => new Error('Full integration external configuration invalid');

export function parseFullIntegrationInfra(text: string): FullIntegrationInfra {
  const values = parse(text);
  if (Object.keys(values).some((key) => !keys.includes(key as typeof keys[number])) ||
    keys.some((key) => !(key in values) || (!values[key].trim() && key !== 'CSS_REDIS_USERNAME' && key !== 'CSS_REDIS_PASSWORD'))) throw invalid();
  const config = values as FullIntegrationInfra;
  try {
    const pg = new URL(config.XPOD_FULL_PG_URL);
    const s3 = new URL(config.CSS_MINIO_ENDPOINT);
    const redis = redisUrl(config);
    if (!['postgres:', 'postgresql:'].includes(pg.protocol) || !pg.hostname ||
      !['http:', 'https:'].includes(s3.protocol) || !s3.hostname || s3.username || s3.password ||
      s3.pathname !== '/' || s3.search || s3.hash || !['redis:', 'rediss:'].includes(redis.protocol) || !redis.hostname) throw invalid();
  } catch { throw invalid(); }
  return config;
}

function redisUrl(config: FullIntegrationInfra): URL {
  const url = new URL(config.CSS_REDIS_CLIENT.includes('://') ? config.CSS_REDIS_CLIENT : `redis://${config.CSS_REDIS_CLIENT}`);
  // Explicit file credentials are authoritative, including intentionally empty authentication.
  url.username = config.CSS_REDIS_USERNAME;
  url.password = config.CSS_REDIS_PASSWORD;
  return url;
}

export function fullIntegrationInfraEnv(config: FullIntegrationInfra): Record<string, string> {
  const canonicalRedisUrl = redisUrl(config).toString().replace(/\/$/u, '');
  return { ...config, CSS_REDIS_CLIENT: canonicalRedisUrl, XPOD_AGENT_DIRECTORY_TEST_REDIS_URL: canonicalRedisUrl };
}

export async function loadFullIntegrationInfra(file: string | undefined): Promise<FullIntegrationInfra | undefined> {
  if (file === undefined) return undefined;
  try { return parseFullIntegrationInfra(await readFile(file, 'utf8')); } catch { throw invalid(); }
}

interface InfraProbes {
  postgres: (config: FullIntegrationInfra) => Promise<boolean>;
  redis: (config: FullIntegrationInfra) => Promise<boolean>;
  s3: (config: FullIntegrationInfra) => Promise<boolean>;
}

const probes: InfraProbes = {
  async postgres(config) {
    const client = new PostgresClient({ connectionString: config.XPOD_FULL_PG_URL, connectionTimeoutMillis: 1500, query_timeout: 1500 });
    try {
      await client.connect();
      const result = await client.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
      return result.rowCount === 1;
    } finally { await client.end(); }
  },
  async redis(config) {
    const client = new Redis(redisUrl(config).toString(), { lazyConnect: true, connectTimeout: 1500, commandTimeout: 1500, retryStrategy: () => null, maxRetriesPerRequest: 0 });
    // Connection errors are represented by the awaited command; suppress emitter logging.
    client.on('error', () => undefined);
    try { await client.connect(); return await client.ping() === 'PONG'; } finally { client.disconnect(); }
  },
  async s3(config) {
    const url = new URL(config.CSS_MINIO_ENDPOINT);
    const client = new S3Client({ endPoint: url.hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)), useSSL: url.protocol === 'https:', accessKey: config.CSS_MINIO_ACCESS_KEY, secretKey: config.CSS_MINIO_SECRET_KEY });
    return client.bucketExists(config.CSS_MINIO_BUCKET_NAME);
  },
};

export async function checkFullIntegrationInfra(config: FullIntegrationInfra, health: InfraProbes = probes): Promise<void> {
  for (const service of ['postgres', 'redis', 's3'] as const) {
    try { if (!await health[service](config)) throw new Error(); } catch {
      // Never expose endpoint, credentials, or an upstream response in runner logs.
      throw new Error(`Full integration external ${service} unhealthy`);
    }
  }
}
