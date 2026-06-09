import { describe, expect, it, vi, afterEach } from 'vitest';
import { VectorStoreService } from '../../src/api/service/VectorStoreService';
import type { AuthContext } from '../../src/api/auth/AuthContext';
import type { EmbeddingService } from '../../src/ai/service/EmbeddingService';

describe('VectorStoreService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('filters vector search candidates and hydrated file results through resource read access', async () => {
    const publicFile = 'https://pod.example/alice/docs/public.md';
    const privateFile = 'https://pod.example/alice/docs/private.md';
    const outsideFile = 'https://pod.example/alice/other/outside.md';
    let searchRequestBody: any;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === 'https://pod.example/-/vector/search') {
        searchRequestBody = JSON.parse(String(init?.body));
        return jsonResponse({
          results: [
            { id: 101, score: 0.9, distance: 0.1 },
            { id: 202, score: 0.8, distance: 0.2 },
            { id: 999, score: 0.7, distance: 0.3 },
          ],
        });
      }
      if (url === publicFile) {
        return new Response(null, { status: 200 });
      }
      if (url === privateFile) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 404 });
    });
    const service = new VectorStoreService({
      cssBaseUrl: 'https://pod.example',
      tokenEndpoint: 'https://id.example/token',
      embeddingService: {
        embed: vi.fn(async () => [0.1, 0.2, 0.3]),
      } as unknown as EmbeddingService,
    });
    const auth = { webId: 'https://id.example/alice/profile/card#me' } as AuthContext;

    (service as any).getVectorStore = vi.fn(async () => ({
      id: 'vs_docs',
      url: 'https://pod.example/alice/docs/',
    }));
    (service as any).getAiCredential = vi.fn(async () => ({
      provider: 'openai',
      apiKey: 'sk-test',
    }));
    (service as any).getAIConfig = vi.fn(async () => ({
      embeddingModel: 'text-embedding-3-small',
    }));
    (service as any).getPodDb = vi.fn(async () => ({
      select: () => ({
        from: () => [
          { fileUrl: publicFile, vectorId: 101 },
          { fileUrl: privateFile, vectorId: 202 },
          { fileUrl: outsideFile, vectorId: 303 },
        ],
      }),
    }));
    (service as any).getFileUrlByVectorId = vi.fn(async (vectorId: number) => {
      if (vectorId === 101) return publicFile;
      if (vectorId === 202) return privateFile;
      return null;
    });

    const result = await service.search('vs_docs', { query: 'runtime approvals' }, auth, 'access-token');

    expect(searchRequestBody).toEqual(expect.objectContaining({
      model: 'text-embedding-3-small',
      vector: [0.1, 0.2, 0.3],
      limit: 10,
      filter: {
        subject: { $startsWith: 'https://pod.example/alice/docs/' },
      },
      excludeIds: [202],
    }));
    expect(result.data).toEqual([
      expect.objectContaining({
        file_id: '101',
        file_url: publicFile,
        filename: 'public.md',
        score: 0.9,
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledWith(privateFile, expect.objectContaining({
      method: 'HEAD',
      headers: { Authorization: 'Bearer access-token' },
    }));
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
