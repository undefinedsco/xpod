import { getLoggerFor } from 'global-logger-factory';

interface AiGatewayModelCache {
  fetchedAt: number;
  items: any[];
  modelIds: Set<string>;
}

export class AiGatewayTransport {
  private static readonly MODEL_CACHE_TTL_MS = 30_000;
  private readonly logger = getLoggerFor(this);
  private modelCache: AiGatewayModelCache | null = null;
  private modelCachePromise: Promise<AiGatewayModelCache | null> | null = null;

  public constructor(private readonly options: {
    getBaseUrl(): string | null;
    getApiKey(): string | null;
    getTimeoutMs(): number;
  }) {}

  public async shouldHandleModel(model?: string): Promise<boolean> {
    if (!model || !this.options.getBaseUrl()) {
      return false;
    }

    const cache = await this.getModelCache();
    return cache?.modelIds.has(model) ?? false;
  }

  public async listModels(): Promise<any[] | null> {
    const cache = await this.getModelCache();
    return cache?.items ?? null;
  }

  public buildUrl(path: string): string {
    const baseUrl = this.options.getBaseUrl();
    if (!baseUrl) {
      throw new Error('DEFAULT_API_BASE is not configured');
    }

    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    if (baseUrl.endsWith('/v1') && normalizedPath.startsWith('/v1/')) {
      return `${baseUrl}${normalizedPath.slice(3)}`;
    }

    return `${baseUrl}${normalizedPath}`;
  }

  public async sendJson(path: string, body: unknown): Promise<any> {
    const response = await this.sendRequest(path, 'POST', body, {
      Accept: 'application/json',
    });
    return response.json();
  }

  public async sendStream(path: string, body: unknown): Promise<{
    toTextStreamResponse: () => Response;
  }> {
    const response = await this.sendRequest(path, 'POST', body, {
      Accept: 'text/event-stream',
    });

    return {
      toTextStreamResponse: () => new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers),
      }),
    };
  }

  private isModelCacheFresh(): boolean {
    return !!this.modelCache
      && Date.now() - this.modelCache.fetchedAt < AiGatewayTransport.MODEL_CACHE_TTL_MS;
  }

  private async getModelCache(): Promise<AiGatewayModelCache | null> {
    if (!this.options.getBaseUrl()) {
      return null;
    }

    if (this.isModelCacheFresh()) {
      return this.modelCache;
    }

    if (this.modelCachePromise) {
      return this.modelCachePromise;
    }

    this.modelCachePromise = (async() => {
      const response = await this.sendRequest('/v1/models', 'GET', undefined, {
        Accept: 'application/json',
      });
      const data = await response.json() as { data?: any[] };
      const items = Array.isArray(data.data) ? data.data : [];
      const cache: AiGatewayModelCache = {
        fetchedAt: Date.now(),
        items,
        modelIds: new Set(items.map((item) => typeof item?.id === 'string' ? item.id : JSON.stringify(item))),
      };
      this.modelCache = cache;
      return cache;
    })();

    try {
      return await this.modelCachePromise;
    } catch (error) {
      if (this.modelCache) {
        this.logger.warn(`Failed to refresh ai-gateway models, using stale cache: ${error}`);
        return this.modelCache;
      }
      this.logger.warn(`Failed to fetch ai-gateway models: ${error}`);
      return null;
    } finally {
      this.modelCachePromise = null;
    }
  }

  private createAbortSignal(): AbortSignal | undefined {
    const abortSignal = AbortSignal as typeof AbortSignal & {
      timeout?: (milliseconds: number) => AbortSignal;
    };
    return typeof abortSignal.timeout === 'function'
      ? abortSignal.timeout(this.options.getTimeoutMs())
      : undefined;
  }

  private async sendRequest(
    path: string,
    method: 'GET' | 'POST',
    body?: unknown,
    headers?: HeadersInit,
  ): Promise<Response> {
    const apiKey = this.options.getApiKey();
    if (!apiKey) {
      throw new Error('DEFAULT_API_KEY is not configured');
    }

    const requestHeaders = new Headers(headers);
    requestHeaders.set('Authorization', `Bearer ${apiKey}`);
    if (body !== undefined && !requestHeaders.has('Content-Type')) {
      requestHeaders.set('Content-Type', 'application/json');
    }

    const response = await fetch(this.buildUrl(path), {
      method,
      headers: requestHeaders,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: this.createAbortSignal(),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      this.logger.warn(`Platform AI request failed: ${response.status} ${errorText}`);

      const error = new Error(`Platform AI error: ${response.status} ${response.statusText}`);
      (error as any).status = response.status;
      (error as any).headers = response.headers;
      (error as any).body = errorText;
      throw error;
    }

    return response;
  }
}
