#!/usr/bin/env bun
import { readFile } from 'node:fs/promises';
import { Client } from 'minio';

export interface RcR2Config {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}

export interface RcR2BucketProbe {
  bucketExists(bucket: string): Promise<boolean>;
}

export type RcR2BucketProbeFactory = (config: RcR2Config) => RcR2BucketProbe;

const ENV_KEYS = {
  endpoint: 'CSS_MINIO_ENDPOINT',
  bucket: 'CSS_MINIO_BUCKET_NAME',
  accessKey: 'CSS_MINIO_ACCESS_KEY',
  secretKey: 'CSS_MINIO_SECRET_KEY',
} as const;

export function parseRcR2Config(text: string): RcR2Config {
  const entries = new Map<string, string>();
  for (const line of text.split(/\r?\n/u)) {
    if (!line || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (match) entries.set(match[1], match[2]);
  }

  return Object.fromEntries(Object.entries(ENV_KEYS).map(([field, envKey]) => {
    const value = entries.get(envKey)?.trim();
    if (!value) throw new Error(`missing required RC secret key: ${envKey}`);
    return [field, value];
  })) as unknown as RcR2Config;
}

export async function verifyRcR2Access(
  config: RcR2Config,
  createProbe: RcR2BucketProbeFactory = createMinioProbe,
): Promise<void> {
  if (config.bucket !== 'xpod-rc') {
    throw new Error('RC object-store bucket must be xpod-rc');
  }

  let endpoint: URL;
  try {
    endpoint = new URL(config.endpoint);
  } catch {
    throw new Error('CSS_MINIO_ENDPOINT must be a valid URL');
  }
  if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.r2.cloudflarestorage.com')) {
    throw new Error('RC object-store endpoint must use Cloudflare R2 over HTTPS');
  }

  try {
    if (!await createProbe(config).bucketExists(config.bucket)) {
      throw new Error('bucket does not exist');
    }
  } catch {
    throw new Error('RC R2 bucket xpod-rc is not accessible with the configured credentials');
  }
}

function createMinioProbe(config: RcR2Config): RcR2BucketProbe {
  const endpoint = new URL(config.endpoint);
  return new Client({
    endPoint: endpoint.hostname,
    port: endpoint.port ? Number(endpoint.port) : undefined,
    useSSL: endpoint.protocol === 'https:',
    accessKey: config.accessKey,
    secretKey: config.secretKey,
  });
}

function parseEnvFileArg(argv: string[]): string {
  if (argv.length !== 2 || argv[0] !== '--env-file' || !argv[1]) {
    throw new Error('usage: verify-rc-r2-access.ts --env-file PATH');
  }
  return argv[1];
}

if (import.meta.main) {
  try {
    const envFile = parseEnvFileArg(process.argv.slice(2));
    await verifyRcR2Access(parseRcR2Config(await readFile(envFile, 'utf8')));
    console.log('RC R2 bucket xpod-rc is accessible');
  } catch (error) {
    console.error(`[verify-rc-r2-access] ${error instanceof Error ? error.message : 'verification failed'}`);
    process.exit(1);
  }
}
