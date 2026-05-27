import type { Session } from '@inrupt/solid-client-authn-node';
import { getSqliteRuntime } from '../../../src/storage/SqliteRuntime';
import { loadSqliteVecExtension } from '../../../src/storage/vector/SqliteVecExtension';
import { XpodTestStack } from '../../helpers/XpodTestStack';
import { resolveTestRuntimeTransport } from '../../helpers/runtimeTransport';
import { loginWithClientCredentials, setupAccount } from '../../integration/helpers/solidAccount';
import { resolveSolidIntegrationConfig } from '../../http/utils/integrationEnv';
import { createTestDir } from '../../utils/sqlite';

export const DIMENSION = 768;

export interface SqliteVecCapability {
  available: boolean;
  reason?: string;
}

export class VectorApiClient {
  public constructor(
    private readonly podUrl: string,
    private readonly authenticatedFetch: typeof fetch,
  ) {}

  private get vectorEndpoint(): string {
    return `${this.podUrl}-/vector`;
  }

  public async upsert(
    model: string,
    vectors: Array<{ id: number; vector: number[]; metadata?: Record<string, unknown> }>,
  ): Promise<{
    upserted: number;
    errors: string[];
    took_ms: number;
  }> {
    const response = await this.authenticatedFetch(`${this.vectorEndpoint}/upsert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, vectors }),
    });
    return this.handleResponse(response);
  }

  public async search(
    model: string,
    vector: number[],
    options?: { limit?: number; threshold?: number; excludeIds?: number[] },
  ): Promise<{
    results: Array<{ id: number; score: number; distance: number }>;
    model: string;
    took_ms: number;
  }> {
    const response = await this.authenticatedFetch(`${this.vectorEndpoint}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, vector, ...options }),
    });
    return this.handleResponse(response);
  }

  public async delete(
    model: string,
    ids: number[],
    method: 'POST' | 'DELETE' = 'POST',
  ): Promise<{
    deleted: number;
    errors: string[];
    took_ms: number;
  }> {
    const response = await this.authenticatedFetch(`${this.vectorEndpoint}/delete`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, ids }),
    });
    return this.handleResponse(response);
  }

  public async getStatus(): Promise<{
    byModel: Array<{ model: string; count: number }>;
    totalCount: number;
  }> {
    const response = await this.authenticatedFetch(`${this.vectorEndpoint}/status`, {
      method: 'GET',
    });
    return this.handleResponse(response);
  }

  private async handleResponse<T>(response: Response): Promise<T> {
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(data?.message || `HTTP ${response.status}`) as Error & {
        status: number;
        code?: string;
        details?: Record<string, unknown>;
      };
      error.status = response.status;
      error.code = data?.code;
      error.details = data?.details;
      throw error;
    }
    return data as T;
  }
}

export interface VectorIntegrationContext {
  baseUrl: string;
  podUrl: string;
  session: Session;
  fetch: typeof fetch;
  client: VectorApiClient;
  stop: () => Promise<void>;
}

export function getSqliteVecCapability(): SqliteVecCapability {
  try {
    const db = getSqliteRuntime().openDatabase(':memory:');
    try {
      loadSqliteVecExtension(db);
      db.exec(`
        CREATE VIRTUAL TABLE vec_capability_probe USING vec0(
          embedding float[2]
        )
      `);
    } finally {
      db.close();
    }
    return { available: true };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function randomVector(dim = DIMENSION): number[] {
  const vec = Array.from({ length: dim }, () => Math.random() * 2 - 1);
  const norm = Math.sqrt(vec.reduce((sum, x) => sum + x * x, 0));
  return vec.map((x) => x / norm);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function createVectorIntegrationContext(prefix: string): Promise<VectorIntegrationContext> {
  const runExternalIntegration = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true';

  let stack: XpodTestStack | undefined;
  let baseUrl: string;

  if (runExternalIntegration) {
    baseUrl = resolveSolidIntegrationConfig({ defaultPodId: 'test' }).baseUrl;
  } else {
    stack = new XpodTestStack();
    await stack.start('local', {
      open: false,
      authMode: 'acp',
      transport: resolveTestRuntimeTransport(),
      runtimeRoot: createTestDir(`${prefix}-runtime`),
      logLevel: 'warn',
    });
    baseUrl = stack.baseUrl;
  }

  const credentials = await setupAccount(baseUrl.replace(/\/$/, ''), prefix);

  if (!credentials) {
    await stack?.stop();
    throw new Error(`Failed to self-bootstrap account for ${baseUrl}`);
  }

  const session = await loginWithClientCredentials(credentials);
  const authenticatedFetch = session.fetch.bind(session) as typeof fetch;
  const client = new VectorApiClient(credentials.podUrl, authenticatedFetch);

  return {
    baseUrl,
    podUrl: credentials.podUrl,
    session,
    fetch: authenticatedFetch,
    client,
    stop: async(): Promise<void> => {
      await session.logout().catch(() => undefined);
      await stack?.stop();
    },
  };
}
