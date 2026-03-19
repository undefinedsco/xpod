import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cosineSimilarity,
  createVectorIntegrationContext,
  getSqliteVecCapability,
  randomVector,
} from './helpers/vectorIntegration';

const capability = getSqliteVecCapability();
const suite = capability.available ? describe : describe.skip;
const TEST_MODEL = `integration-test-model-${Date.now()}`;

function getVectorEndpoint(podUrl: string): string {
  return `${podUrl}-/vector`;
}

suite('VectorHttpHandler Integration', () => {
  let context: Awaited<ReturnType<typeof createVectorIntegrationContext>> | undefined;
  const testVectors = Array.from({ length: 5 }, (_, index) => ({
    id: index + 1,
    vector: randomVector(),
  }));

  beforeAll(async() => {
    context = await createVectorIntegrationContext('vector-http');
  }, 120_000);

  afterAll(async() => {
    if (!context) {
      return;
    }

    await context.client.delete(TEST_MODEL, testVectors.map((vector) => vector.id)).catch(() => undefined);
    await context.stop();
  });

  describe('Vector CRUD Operations', () => {
    it('stores vectors via upsert', async () => {
      const result = await context!.client.upsert(TEST_MODEL, testVectors);

      expect(result.upserted).toBe(testVectors.length);
      expect(result.errors).toHaveLength(0);
      expect(result.took_ms).toBeGreaterThanOrEqual(0);
    });

    it('updates existing vectors via upsert', async () => {
      const updatedVector = randomVector();
      const result = await context!.client.upsert(TEST_MODEL, [{ id: 1, vector: updatedVector }]);

      expect(result.upserted).toBe(1);
      expect(result.errors).toHaveLength(0);

      const search = await context!.client.search(TEST_MODEL, updatedVector, { limit: 1 });
      expect(search.results).toHaveLength(1);
      expect(search.results[0].id).toBe(1);
      expect(search.results[0].score).toBeCloseTo(1, 5);
      expect(search.results[0].distance).toBeCloseTo(0, 5);
    });

    it('searches vectors successfully', async () => {
      const queryVector = testVectors[1].vector;
      const result = await context!.client.search(TEST_MODEL, queryVector, { limit: 3 });

      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results.length).toBeLessThanOrEqual(3);
      expect(result.model).toBe(TEST_MODEL);
      expect(result.took_ms).toBeGreaterThanOrEqual(0);
      expect(result.results[0].id).toBe(2);
      expect(result.results[0].score).toBeCloseTo(1, 5);
      expect(result.results[0].distance).toBeCloseTo(0, 5);
    });

    it('finds similar vectors', async () => {
      const baseVector = testVectors[1].vector;
      const similarVector = baseVector.map((value) => value + (Math.random() - 0.5) * 0.01);
      const norm = Math.sqrt(similarVector.reduce((sum, value) => sum + value * value, 0));
      const normalized = similarVector.map((value) => value / norm);

      expect(cosineSimilarity(baseVector, normalized)).toBeGreaterThan(0.99);

      const result = await context!.client.search(TEST_MODEL, normalized, { limit: 1 });
      expect(result.results).toHaveLength(1);
      expect(result.results[0].id).toBe(2);
    });

    it('respects limit and threshold parameters', async () => {
      const limitResult = await context!.client.search(TEST_MODEL, testVectors[0].vector, { limit: 2 });
      expect(limitResult.results.length).toBeLessThanOrEqual(2);

      const thresholdResult = await context!.client.search(TEST_MODEL, testVectors[0].vector, {
        limit: 10,
        threshold: 0.99,
      });

      for (const result of thresholdResult.results) {
        expect(result.score).toBeGreaterThanOrEqual(0.99);
      }
    });

    it('respects excludeIds parameter', async () => {
      const result = await context!.client.search(TEST_MODEL, testVectors[0].vector, {
        limit: 10,
        excludeIds: [1, 2],
      });

      const resultIds = result.results.map((item) => item.id);
      expect(resultIds).not.toContain(1);
      expect(resultIds).not.toContain(2);
    });

    it('deletes vectors successfully', async () => {
      const result = await context!.client.delete(TEST_MODEL, [testVectors[4].id]);

      expect(result.deleted).toBe(1);
      expect(result.errors).toHaveLength(0);

      const searchResult = await context!.client.search(TEST_MODEL, testVectors[4].vector, { limit: 10 });
      const resultIds = searchResult.results.map((item) => item.id);
      expect(resultIds).not.toContain(testVectors[4].id);
    });

    it('reports vector index status', async () => {
      const status = await context!.client.getStatus();

      expect(Array.isArray(status.byModel)).toBe(true);
      expect(typeof status.totalCount).toBe('number');
      expect(status.totalCount).toBeGreaterThanOrEqual(testVectors.length - 1);
      expect(status.byModel.some((item) => item.count >= testVectors.length - 1)).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('rejects missing model field', async () => {
      const response = await context!.fetch(`${getVectorEndpoint(context!.podUrl)}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vector: randomVector() }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ code: 'INVALID_REQUEST' });
    });

    it('rejects missing vector field', async () => {
      const response = await context!.fetch(`${getVectorEndpoint(context!.podUrl)}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: TEST_MODEL }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ code: 'INVALID_REQUEST' });
    });

    it('rejects empty vectors on upsert', async () => {
      const response = await context!.fetch(`${getVectorEndpoint(context!.podUrl)}/upsert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: TEST_MODEL, vectors: [] }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ code: 'INVALID_REQUEST' });
    });

    it('rejects invalid JSON body', async () => {
      const response = await context!.fetch(`${getVectorEndpoint(context!.podUrl)}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ code: 'INVALID_REQUEST' });
    });

    it('rejects wrong HTTP method and unknown action', async () => {
      const wrongMethod = await context!.fetch(`${getVectorEndpoint(context!.podUrl)}/upsert`, {
        method: 'GET',
      });
      expect(wrongMethod.status).toBe(405);

      const unknownAction = await context!.fetch(`${getVectorEndpoint(context!.podUrl)}/unknown`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(unknownAction.status).toBe(404);
    });
  });

  describe('Authorization', () => {
    it('rejects unauthenticated writes', async () => {
      const response = await fetch(`${getVectorEndpoint(context!.podUrl)}/upsert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: TEST_MODEL, vectors: [{ id: 999, vector: randomVector() }] }),
      });

      expect([401, 403]).toContain(response.status);
    });
  });
});
