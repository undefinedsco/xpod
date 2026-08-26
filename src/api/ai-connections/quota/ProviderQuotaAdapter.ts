import type { ProviderRequestCredential, ProviderRequestSecret } from '../ProviderCredential';

export type QuotaSnapshotStatus = 'available' | 'unsupported' | 'error';

export interface QuotaWindow {
  name: string;
  used?: number;
  usedExact?: string;
  limit?: number;
  limitExact?: string;
  remaining?: number;
  remainingExact?: string;
  displayApprox?: boolean;
  currency?: string;
  resetsAt?: string;
}

export interface NormalizedQuotaSnapshot {
  id?: string;
  credential: string;
  status: QuotaSnapshotStatus;
  balance?: number;
  windows: QuotaWindow[];
  observedAt: string;
  expiresAt: string;
  source: string;
  stale?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ProviderQuotaFetchInput {
  credential: ProviderRequestCredential;
  secret: ProviderRequestSecret;
  now: Date;
  signal?: AbortSignal;
}

export interface ProviderQuotaAdapter {
  readonly provider: string;
  fetch(input: ProviderQuotaFetchInput): Promise<NormalizedQuotaSnapshot>;
}

export function unsupportedQuotaSnapshot(
  input: {
    credential: string;
    source: string;
    now: Date;
    ttlMs?: number;
    metadata?: Record<string, unknown>;
  },
): NormalizedQuotaSnapshot {
  return {
    credential: input.credential,
    status: 'unsupported',
    windows: [],
    observedAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + (input.ttlMs ?? 60 * 60_000)).toISOString(),
    source: input.source,
    metadata: input.metadata,
  };
}

export function errorQuotaSnapshot(
  input: {
    credential: string;
    source: string;
    now: Date;
    status?: number;
    retryAfter?: string | null;
    ttlMs?: number;
    metadata?: Record<string, unknown>;
  },
): NormalizedQuotaSnapshot {
  return {
    credential: input.credential,
    status: 'error',
    windows: [],
    observedAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + (input.ttlMs ?? 5 * 60_000)).toISOString(),
    source: input.source,
    metadata: {
      ...input.metadata,
      ...(input.status ? { providerStatusCode: input.status } : {}),
      ...(input.status === 429 ? {
        cooldown: {
          reason: 'rate_limited',
          ...(retryAfterSeconds(input.retryAfter) !== undefined ? { retryAfterSeconds: retryAfterSeconds(input.retryAfter) } : {}),
        },
      } : {}),
    },
  };
}

export function apiKeyFromSecret(secret: ProviderRequestSecret): string | undefined {
  const apiKey = secret.apiKey;
  return typeof apiKey === 'string' && apiKey.trim() ? apiKey : undefined;
}

export async function fetchJsonWithBearer(input: {
  fetch: typeof fetch;
  url: string;
  apiKey: string;
  signal?: AbortSignal;
}): Promise<{ ok: true; body: unknown } | { ok: false; status: number; retryAfter?: string | null }> {
  const headers = new Headers();
  headers.set('Authorization', `Bearer ${input.apiKey}`);
  const response = await input.fetch(input.url, {
    method: 'GET',
    headers,
    signal: input.signal,
  });
  if (!response.ok) {
    await response.text().catch(() => '');
    return {
      ok: false,
      status: response.status,
      retryAfter: response.headers.get('Retry-After') ?? response.headers.get('retry-after'),
    };
  }
  return { ok: true, body: await response.json() };
}

export function numeric(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function decimalAmount(value: unknown): {
  exact?: string;
  numeric?: number;
  displayApprox?: boolean;
} {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return {
      exact: String(value),
      numeric: value,
      ...(Number.isSafeInteger(value) ? {} : { displayApprox: true }),
    };
  }
  if (typeof value !== 'string') {
    return {};
  }
  const exact = value.trim();
  if (!exact) {
    return {};
  }
  const parsed = Number(exact);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > Number.MAX_SAFE_INTEGER) {
    return { exact };
  }
  return {
    exact,
    numeric: parsed,
    ...(/[.eE]/u.test(exact) ? { displayApprox: true } : {}),
  };
}

export function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase();
}

function retryAfterSeconds(value: string | null | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return seconds;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1000));
}
