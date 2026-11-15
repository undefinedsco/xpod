import {
  AGENT_DIRECTORY_SIDECAR,
  type AgentDirectoryListResponse,
  type AgentDirectoryReadResponse,
  type AgentDirectorySearchResponse,
} from './protocol';

/**
 * Caller-provided, already-authenticated request function.
 *
 * Production callers pass the CLI's existing `authFetch` (or an equivalent
 * solid-sdk session fetch) so the client never builds its own token header and
 * never introduces a parallel authentication path.
 */
export type AgentDirectoryRequest = (url: string, init: RequestInit) => Promise<Response>;

export interface AgentDirectoryClientOptions {
  baseUrl: string;
  /** Authenticated request function; preferred production path. */
  request?: AgentDirectoryRequest;
  /**
   * Legacy/test fallback. When `request` is absent, the client sends this as a
   * Bearer token. Not used by the CLI production path.
   */
  accessToken?: string;
  fetch?: typeof fetch;
}

export interface ListParams {
  root: string;
  pathPrefix?: string;
  limit?: number;
  cursor?: string;
}

export interface SearchParams {
  root: string;
  query: string;
  ignoreCase?: boolean;
  pathPrefix?: string;
  limit?: number;
  cursor?: string;
  maxFileBytes?: number;
}

export class AgentDirectoryHttpError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentDirectoryHttpError';
  }
}

export class AgentDirectoryClient {
  private readonly baseUrl: string;
  private readonly accessToken?: string;
  private readonly request?: AgentDirectoryRequest;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: AgentDirectoryClientOptions) {
    this.baseUrl = options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`;
    this.accessToken = options.accessToken;
    this.request = options.request;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  public async list(params: ListParams): Promise<AgentDirectoryListResponse> {
    return this.requestJson<AgentDirectoryListResponse>('list', {
      root: params.root,
      ...(params.pathPrefix ? { pathPrefix: params.pathPrefix } : {}),
      ...(params.limit ? { limit: String(params.limit) } : {}),
      ...(params.cursor ? { cursor: params.cursor } : {}),
    });
  }

  public async listAll(params: ListParams): Promise<AgentDirectoryListResponse> {
    const entries: AgentDirectoryListResponse['entries'] = [];
    let cursor = params.cursor;
    let scanned = 0;
    let complete = true;
    let pages = 0;
    do {
      const page = await this.list({ ...params, ...(cursor ? { cursor } : {}) });
      entries.push(...page.entries);
      scanned += page.scanned;
      // `complete` is coverage completeness; a truncated page with a cursor is
      // normal pagination, but a truncated page without a cursor is an omission.
      complete = complete && page.complete && !(page.truncated && !page.nextCursor);
      cursor = page.nextCursor;
      pages += 1;
      if (pages > 100) {
        complete = false;
        break;
      }
    } while (cursor);
    return {
      root: params.root,
      entries,
      truncated: false,
      complete,
      scanned,
    };
  }

  public async search(params: SearchParams): Promise<AgentDirectorySearchResponse> {
    return this.requestJson<AgentDirectorySearchResponse>('search', {
      root: params.root,
      q: params.query,
      mode: 'literal',
      ...(params.ignoreCase ? { ignoreCase: '1' } : {}),
      ...(params.pathPrefix ? { pathPrefix: params.pathPrefix } : {}),
      ...(params.limit ? { limit: String(params.limit) } : {}),
      ...(params.cursor ? { cursor: params.cursor } : {}),
      ...(params.maxFileBytes ? { maxFileBytes: String(params.maxFileBytes) } : {}),
    });
  }

  public async searchAll(params: SearchParams): Promise<AgentDirectorySearchResponse> {
    const matches: AgentDirectorySearchResponse['matches'] = [];
    let cursor = params.cursor;
    let scannedFiles = 0;
    let skippedUnsupported = 0;
    let truncated = false;
    let complete = true;
    let hasUnscannedScope = false;
    let pages = 0;
    do {
      const page = await this.search({ ...params, ...(cursor ? { cursor } : {}) });
      matches.push(...page.matches);
      scannedFiles += page.scannedFiles;
      skippedUnsupported += page.skippedUnsupported;
      truncated = truncated || page.truncated;
      // Accumulate incompleteness across pages: a later complete page must not
      // erase an earlier partial one. A truncated page without a cursor is an
      // unrecoverable omission, not normal pagination.
      complete = complete && page.complete && !(page.truncated && !page.nextCursor);
      hasUnscannedScope = hasUnscannedScope || page.hasUnscannedScope || (page.truncated && !page.nextCursor);
      cursor = page.nextCursor;
      pages += 1;
      if (pages > 100) {
        complete = false;
        hasUnscannedScope = true;
        break;
      }
    } while (cursor);
    return {
      root: params.root,
      query: params.query,
      mode: 'literal',
      ignoreCase: Boolean(params.ignoreCase),
      matches,
      truncated,
      complete,
      scannedFiles,
      skippedUnsupported,
      hasUnscannedScope,
    };
  }

  public async read(url: string): Promise<AgentDirectoryReadResponse> {
    return this.requestJson<AgentDirectoryReadResponse>('read', { url });
  }

  public buildBase(): string {
    return this.baseUrl;
  }

  private async requestJson<T>(operation: string, params: Record<string, string>): Promise<T> {
    const target = new URL(`${AGENT_DIRECTORY_SIDECAR}/${operation}`, this.baseUrl);
    for (const [ key, value ] of Object.entries(params)) {
      target.searchParams.set(key, value);
    }
    const init: RequestInit = {
      method: 'GET',
      headers: { Accept: 'application/json' },
    };
    const response = this.request
      ? await this.request(target.href, init)
      : await this.fetchImpl(target.href, {
        ...init,
        headers: {
          ...init.headers,
          ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
        },
      });
    const body = await response.text();
    if (!response.ok) {
      let code = `HTTP_${response.status}`;
      let message = body;
      try {
        const parsed = JSON.parse(body) as { code?: string; message?: string };
        code = parsed.code ?? code;
        message = parsed.message ?? message;
      } catch {
        // keep raw body
      }
      throw new AgentDirectoryHttpError(response.status, code, message);
    }
    return JSON.parse(body) as T;
  }
}
