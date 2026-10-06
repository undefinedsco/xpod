import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');

describe('environment object-store bucket verification', () => {
  it.each(['xpod-cn', 'xpod-co'])('checks the selected %s bucket using the real S3 client', async bucket => {
    const requests: string[] = [];
    let missing = false;
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'application/xml' });
        response.end('<LocationConstraint>us-east-1</LocationConstraint>');
      } else {
        response.writeHead(missing ? 404 : 200);
        response.end();
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const parent = path.join(root, '.test-data/environment-bucket-verification');
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(path.join(parent, 'case-'));
    const file = path.join(directory, 'runtime.env');
    async function run(endpoint: string, selectedBucket = bucket): Promise<{ exit: number | null; output: string }> {
      await writeFile(file, [
        `CSS_MINIO_ENDPOINT=${endpoint}`, `CSS_MINIO_BUCKET_NAME=${selectedBucket}`,
        'CSS_MINIO_ACCESS_KEY=fixture-access', 'CSS_MINIO_SECRET_KEY=fixture-secret',
      ].join('\n'), { mode: 0o600 });
      const child = spawn('bun', ['--no-env-file', 'scripts/verify-r2-bucket.ts', file], { cwd: root });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      const exit = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject); child.once('close', resolve);
      });
      return { exit, output };
    }
    try {
      const endpoint = `http://127.0.0.1:${port}/${bucket}`;
      expect(await run(endpoint)).toMatchObject({ exit: 0, output: expect.stringContaining(`${bucket} is accessible`) });
      expect(requests).toContain(`HEAD /${bucket}`);
      missing = true;
      expect(await run(endpoint)).toMatchObject({ exit: 1, output: expect.stringContaining('does not exist or is not reachable') });
      const requestCount = requests.length;
      expect(await run(endpoint, 'different-bucket')).toMatchObject({ exit: 1, output: expect.stringContaining('does not match CSS_MINIO_BUCKET_NAME') });
      expect(requests).toHaveLength(requestCount);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
