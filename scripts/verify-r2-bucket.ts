#!/usr/bin/env bun
/**
 * Check that the object-store bucket named by an environment file is reachable.
 *
 * `verify-rc-r2-access.ts` is the RC gate: it asserts the bucket is specifically
 * `xpod-rc`. This is the general form, for checking any environment's bucket
 * (cn uses `xpod-cn`, co uses `xpod-co`) with the same mechanism.
 *
 *   bun scripts/verify-r2-bucket.ts <path-to-env-file>
 */
import { readFile } from 'node:fs/promises';
import { Client } from 'minio';

const file = process.argv[2];
if (!file) {
  console.error('usage: bun scripts/verify-r2-bucket.ts <path-to-env-file>');
  process.exit(2);
}

const entries = new Map<string, string>();
for (const line of (await readFile(file, 'utf8')).split(/\r?\n/u)) {
  if (!line || line.trimStart().startsWith('#')) continue;
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
  if (match) entries.set(match[1]!, match[2]!);
}

const required = [ 'CSS_MINIO_ENDPOINT', 'CSS_MINIO_BUCKET_NAME', 'CSS_MINIO_ACCESS_KEY', 'CSS_MINIO_SECRET_KEY' ];
for (const key of required) {
  if (!entries.get(key)) {
    console.error(`[verify-r2-bucket] ${key} is missing from ${file}`);
    process.exit(1);
  }
}

const endpoint = new URL(entries.get('CSS_MINIO_ENDPOINT')!);
const bucket = entries.get('CSS_MINIO_BUCKET_NAME')!;
// The endpoint is path style and carries the bucket in its path, so a bucket
// rename that only touched one of the two would be caught here.
const pathBucket = endpoint.pathname.replace(/^\/+|\/+$/gu, '');
if (pathBucket && pathBucket !== bucket) {
  console.error(`[verify-r2-bucket] endpoint path ${pathBucket} does not match CSS_MINIO_BUCKET_NAME ${bucket}`);
  process.exit(1);
}

const client = new Client({
  endPoint: endpoint.hostname,
  port: endpoint.port ? Number(endpoint.port) : 443,
  useSSL: endpoint.protocol === 'https:',
  accessKey: entries.get('CSS_MINIO_ACCESS_KEY')!,
  secretKey: entries.get('CSS_MINIO_SECRET_KEY')!,
  pathStyle: true,
});

const exists = await client.bucketExists(bucket);
if (!exists) {
  console.error(`[verify-r2-bucket] bucket ${bucket} does not exist or is not reachable`);
  process.exit(1);
}
console.log(`[verify-r2-bucket] ${bucket} is accessible`);
