import type { ProviderSecret } from '../credentials/CredentialVault';
import {
  errorQuotaSnapshot,
  numeric,
  type NormalizedQuotaSnapshot,
  type ProviderQuotaAdapter,
  type ProviderQuotaFetchInput,
  type QuotaCredentialRecord,
  type QuotaWindow,
} from './ProviderQuotaAdapter';
import { ProviderHttpTransport } from '../../service/provider-http-transport';

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const KIMI_CODE_USAGE_URL = 'https://api.kimi.com/coding/v1/usages';
const QUOTA_TTL_MS = 5 * 60_000;

interface SubscriptionQuotaAdapterOptions {
  fetch?: typeof fetch;
  transport?: ProviderHttpTransport;
}

abstract class SubscriptionQuotaAdapter implements ProviderQuotaAdapter {
  public abstract readonly provider: string;
  protected readonly fetchFn: typeof fetch;
  protected readonly transport?: ProviderHttpTransport;

  public constructor(options: SubscriptionQuotaAdapterOptions = {}) {
    this.fetchFn = options.fetch ?? fetch;
    this.transport = options.transport;
  }

  public abstract supports(credential: QuotaCredentialRecord): boolean;
  public abstract fetch(input: ProviderQuotaFetchInput): Promise<NormalizedQuotaSnapshot>;

  protected snapshot(input: ProviderQuotaFetchInput, source: string, windows: QuotaWindow[]): NormalizedQuotaSnapshot {
    return {
      credential: input.credential.credentialIri,
      status: 'available',
      windows,
      observedAt: input.now.toISOString(),
      expiresAt: new Date(input.now.getTime() + QUOTA_TTL_MS).toISOString(),
      source,
    };
  }

  protected error(input: ProviderQuotaFetchInput, source: string, status?: number, retryAfter?: string | null): NormalizedQuotaSnapshot {
    return errorQuotaSnapshot({
      credential: input.credential.credentialIri,
      source,
      now: input.now,
      status,
      retryAfter,
      metadata: { reason: status ? 'provider_quota_request_failed' : 'missing_access_token' },
    });
  }
}

export class CodexSubscriptionQuotaAdapter extends SubscriptionQuotaAdapter {
  public readonly provider = 'openai';
  public readonly capability = { protocol: 'rolling-quota-windows', profile: 'codex' } as const;

  public supports(credential: QuotaCredentialRecord): boolean {
    return credential.offeringId === 'official-subscription' && credential.authMode === 'deviceCodeOAuth';
  }

  public async fetch(input: ProviderQuotaFetchInput): Promise<NormalizedQuotaSnapshot> {
    const token = bearerFromSecret(input.secret);
    if (!token) return this.error(input, 'openai:chatgpt-wham');
    const headers = bearerHeaders(token);
    const accountId = stringValue(input.secret.accountId ?? input.secret.account_id);
    if (accountId) headers.set('ChatGPT-Account-Id', accountId);
    const result = await fetchJson(this.fetchFn, CODEX_USAGE_URL, headers, input.signal, this.transport, input.credential.proxyUrl);
    if (!result.ok) return this.error(input, 'openai:chatgpt-wham', result.status, result.retryAfter);
    return this.snapshot(input, 'openai:chatgpt-wham', codexWindows(result.body));
  }
}

export class ClaudeSubscriptionQuotaAdapter extends SubscriptionQuotaAdapter {
  public readonly provider = 'anthropic';
  public readonly capability = { protocol: 'rolling-quota-windows', profile: 'claude-code' } as const;

  public supports(credential: QuotaCredentialRecord): boolean {
    return credential.offeringId === 'official-subscription' && credential.authMode === 'deviceCodeOAuth';
  }

  public async fetch(input: ProviderQuotaFetchInput): Promise<NormalizedQuotaSnapshot> {
    const token = bearerFromSecret(input.secret);
    if (!token) return this.error(input, 'anthropic:oauth-usage');
    const headers = bearerHeaders(token);
    headers.set('Accept', 'application/json, text/plain, */*');
    headers.set('Content-Type', 'application/json');
    headers.set('anthropic-beta', 'claude-code-20250219,oauth-2025-04-20');
    const result = await fetchJson(this.fetchFn, CLAUDE_USAGE_URL, headers, input.signal, this.transport, input.credential.proxyUrl);
    if (!result.ok) return this.error(input, 'anthropic:oauth-usage', result.status, result.retryAfter);
    return this.snapshot(input, 'anthropic:oauth-usage', claudeWindows(result.body));
  }
}

export class KimiCodeSubscriptionQuotaAdapter extends SubscriptionQuotaAdapter {
  public readonly provider = 'kimi';
  public readonly capability = { protocol: 'rolling-quota-windows', profile: 'kimi-code' } as const;

  public supports(credential: QuotaCredentialRecord): boolean {
    return (credential.offeringId === 'official-subscription' && credential.authMode === 'deviceCodeOAuth')
      || (credential.offeringId === 'subscription-key' && credential.authMode === 'apiKey');
  }

  public async fetch(input: ProviderQuotaFetchInput): Promise<NormalizedQuotaSnapshot> {
    const token = bearerFromSecret(input.secret);
    if (!token) return this.error(input, 'kimi-code:/usages');
    const result = await fetchJson(this.fetchFn, KIMI_CODE_USAGE_URL, bearerHeaders(token), input.signal, this.transport, input.credential.proxyUrl);
    if (!result.ok) return this.error(input, 'kimi-code:/usages', result.status, result.retryAfter);
    return this.snapshot(input, 'kimi-code:/usages', kimiCodeWindows(result.body));
  }
}

function codexWindows(body: unknown): QuotaWindow[] {
  const root = record(body);
  const rateLimit = record(root?.rate_limit ?? root?.rateLimits);
  if (!rateLimit) return [];
  const candidates = [
    rateLimit.primary_window ?? rateLimit.primary,
    rateLimit.secondary_window ?? rateLimit.secondary,
    rateLimit.tertiary_window ?? rateLimit.tertiary,
  ];
  return candidates.flatMap((value) => {
    const row = record(value);
    if (!row) return [];
    const used = percent(row.used_percent ?? row.usedPercent);
    if (used === undefined) return [];
    const durationSeconds = durationInSeconds(row);
    const name = quotaWindowName(durationSeconds);
    if (!name) return [];
    return [{
      name,
      used,
      limit: 100,
      remaining: roundQuota(100 - used),
      ...(resetIso(row.reset_at ?? row.resetsAt) ? { resetsAt: resetIso(row.reset_at ?? row.resetsAt) } : {}),
    }];
  });
}

function claudeWindows(body: unknown): QuotaWindow[] {
  const root = record(body);
  if (!root) return [];
  return [
    ['five-hour', root.five_hour],
    ['weekly', root.seven_day],
    ['weekly-opus', root.seven_day_opus],
    ['weekly-sonnet', root.seven_day_sonnet],
  ].flatMap(([name, value]) => {
    const row = record(value);
    const used = percent(row?.utilization);
    if (!row || used === undefined) return [];
    const resetsAt = resetIso(row.resets_at);
    return [{ name: String(name), used, limit: 100, remaining: roundQuota(100 - used), ...(resetsAt ? { resetsAt } : {}) }];
  });
}

function kimiCodeWindows(body: unknown): QuotaWindow[] {
  const root = record(body);
  if (!root) return [];
  const limits = Array.isArray(root.limits) ? root.limits : [];
  const parsed = limits.flatMap((value) => {
    const item = record(value);
    const detail = record(item?.detail);
    const window = record(item?.window);
    if (!detail) return [];
    const duration = numeric(window?.duration);
    const unit = stringValue(window?.timeUnit);
    const name = duration === 300 && unit === 'TIME_UNIT_MINUTE'
      ? 'five-hour'
      : duration === 7 && unit === 'TIME_UNIT_DAY'
        ? 'weekly'
        : stringValue(item?.name ?? detail.name);
    return name ? usageAmountWindow(name, detail) : [];
  });
  const summary = record(root.usage);
  if (summary && !parsed.some((window) => window.name === 'weekly')) {
    parsed.push(...usageAmountWindow('weekly', summary));
  }
  return parsed;
}

function usageAmountWindow(name: string, row: Record<string, unknown>): QuotaWindow[] {
  const used = numeric(row.used);
  const limit = numeric(row.limit);
  if (used === undefined || limit === undefined) return [];
  const resetsAt = resetIso(row.resetTime);
  return [{ name, used, limit, remaining: Math.max(0, limit - used), ...(resetsAt ? { resetsAt } : {}) }];
}

function durationInSeconds(row: Record<string, unknown>): number | undefined {
  const seconds = numeric(row.limit_window_seconds);
  if (seconds !== undefined) return seconds;
  const minutes = numeric(row.windowDurationMins);
  return minutes === undefined ? undefined : minutes * 60;
}

function quotaWindowName(seconds: number | undefined): string | undefined {
  if (seconds === 18_000) return 'five-hour';
  if (seconds === 604_800) return 'weekly';
  if (seconds !== undefined && seconds >= 28 * 86_400) return 'monthly';
  return undefined;
}

function bearerFromSecret(secret: ProviderSecret): string | undefined {
  return stringValue(secret.accessToken ?? secret.apiKey ?? secret.token);
}

function bearerHeaders(token: string): Headers {
  const headers = new Headers();
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('Accept', 'application/json');
  return headers;
}

async function fetchJson(fetchFn: typeof fetch, url: string, headers: Headers, signal?: AbortSignal, transport?: ProviderHttpTransport, proxy?: string): Promise<
  { ok: true; body: unknown } | { ok: false; status: number; retryAfter?: string | null }
> {
  if (transport) {
    try {
      return { ok: true, body: await transport.getJson({ url, headers, proxy, signal }) };
    } catch (error) {
      const status = typeof (error as { status?: unknown })?.status === 'number'
        ? (error as { status: number }).status
        : undefined;
      if (status === undefined) throw error;
      const responseHeaders = (error as { headers?: Headers }).headers;
      return { ok: false, status, retryAfter: responseHeaders?.get('Retry-After') ?? responseHeaders?.get('retry-after') };
    }
  }
  const response = await fetchFn(url, { method: 'GET', headers, signal });
  if (!response.ok) {
    await response.text().catch(() => '');
    return { ok: false, status: response.status, retryAfter: response.headers.get('Retry-After') };
  }
  return { ok: true, body: await response.json() };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function percent(value: unknown): number | undefined {
  const parsed = numeric(value);
  return parsed === undefined ? undefined : Math.min(100, Math.max(0, parsed));
}

function resetIso(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  const seconds = numeric(value);
  if (seconds === undefined || seconds < 0) return undefined;
  return new Date(seconds * 1000).toISOString();
}

function roundQuota(value: number): number {
  return Math.round(value * 100) / 100;
}
