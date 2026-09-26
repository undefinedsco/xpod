import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hasObjectStore,
  OBJECT_STORE_BUCKET,
  OBJECT_STORE_IMAGE,
  probeObjectStore,
} from './dockerObjectStore';

/** A port nothing listens on: the state every runner sees before Compose is up. */
async function closedPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

describe('object store readiness probe', () => {
  it('reports "not ready" instead of throwing while the container is still coming up', async() => {
    const port = await closedPort();
    // The regression this guards: a transport failure used to escape as a rejected promise, so a
    // 60-attempt readiness loop aborted on its first probe - and under Bun the unhandled error
    // killed the whole integration runner. A probe answers; the caller decides whether to retry.
    const verdict = await probeObjectStore(port, OBJECT_STORE_BUCKET);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail.length).toBeGreaterThan(0);
    expect(verdict.detail).toMatch(/ECONNREFUSED|ECONNRESET|connect/iu);
    expect(await hasObjectStore(port, OBJECT_STORE_BUCKET)).toBe(false);
  });

  it('keeps the pinned image in sync with every Compose file that boots it', () => {
    // One digest, three stacks: the unit tests, the cluster stacks and the acceptance stack all
    // have to run the same object store, or "green locally" stops meaning what it says.
    for (const file of [
      'docker-compose.cluster.yml',
      'docker-compose.cluster.integration.yml',
      'docker-compose.acceptance.yml',
    ]) {
      const contents = readFileSync(path.resolve(file), 'utf8');
      expect(contents, `${file} must pin ${OBJECT_STORE_IMAGE}`).toContain(OBJECT_STORE_IMAGE);
    }
  });
});
