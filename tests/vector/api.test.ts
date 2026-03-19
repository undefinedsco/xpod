import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createVectorIntegrationContext,
  getSqliteVecCapability,
  randomVector,
} from './helpers/vectorIntegration';

const capability = getSqliteVecCapability();
const suite = capability.available ? describe : describe.skip;
const TEST_MODEL = `vector-api-smoke-${Date.now()}`;

suite('Vector API Endpoints', () => {
  let context: Awaited<ReturnType<typeof createVectorIntegrationContext>> | undefined;
  let vectorEndpoint = '';

  const testVectors = Array.from({ length: 3 }, (_, index) => ({
    id: index + 101,
    vector: randomVector(),
  }));

  beforeAll(async() => {
    context = await createVectorIntegrationContext('vector-api');
    vectorEndpoint = `${context.podUrl}-/vector`;
  }, 120_000);

  afterAll(async () => {
    if (!context) {
      return;
    }

    await context.client.delete(TEST_MODEL, testVectors.map((vector) => vector.id)).catch(() => undefined);
    await context.stop();
  });

  it('POST /-/vector/upsert stores vectors', async () => {
    const response = await context!.fetch(`${vectorEndpoint}/upsert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: TEST_MODEL,
        vectors: testVectors,
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      upserted: testVectors.length,
      errors: [],
    });
  });

  it('POST /-/vector/search searches vectors', async () => {
    const response = await context!.fetch(`${vectorEndpoint}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: TEST_MODEL,
        vector: testVectors[0].vector,
        limit: 2,
      }),
    });

    expect(response.status).toBe(200);
    const data = await response.json() as {
      results: Array<{ id: number; score: number; distance: number }>;
      model: string;
    };

    expect(data.model).toBe(TEST_MODEL);
    expect(data.results.length).toBeGreaterThan(0);
    expect(data.results.length).toBeLessThanOrEqual(2);
    expect(data.results[0].id).toBe(testVectors[0].id);
    expect(data.results[0].score).toBeGreaterThanOrEqual(0.99);
  });

  it('GET /-/vector/status returns index status', async () => {
    const response = await context!.fetch(`${vectorEndpoint}/status`);

    expect(response.status).toBe(200);
    const data = await response.json() as {
      byModel: Array<{ model: string; count: number }>;
      totalCount: number;
    };

    expect(Array.isArray(data.byModel)).toBe(true);
    expect(typeof data.totalCount).toBe('number');
    expect(data.totalCount).toBeGreaterThanOrEqual(testVectors.length);
  });

  it('DELETE /-/vector/delete removes vectors', async () => {
    const response = await context!.fetch(`${vectorEndpoint}/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: TEST_MODEL,
        ids: [testVectors[2].id],
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      deleted: 1,
      errors: [],
    });

    const search = await context!.client.search(TEST_MODEL, testVectors[2].vector, { limit: 10 });
    expect(search.results.map((result) => result.id)).not.toContain(testVectors[2].id);
  });

  it('rejects malformed requests', async () => {
    const response = await context!.fetch(`${vectorEndpoint}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vector: randomVector() }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});
