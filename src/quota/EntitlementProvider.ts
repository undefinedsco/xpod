import { getLoggerFor } from 'global-logger-factory';
import type { AccountQuota } from './QuotaService';

export interface AccountEntitlement {
  accountId: string;
  quota: Partial<AccountQuota>;
}

export interface EntitlementProvider {
  getAccountEntitlement(accountId: string): Promise<AccountEntitlement | undefined>;
}

export class NoopEntitlementProvider implements EntitlementProvider {
  public async getAccountEntitlement(): Promise<AccountEntitlement | undefined> {
    return undefined;
  }
}

interface HttpEntitlementProviderOptions {
  baseUrl: string;
  serviceToken?: string;
  cacheTtlMs?: number;
  timeoutMs?: number;
}

interface CachedEntitlement {
  expiresAt: number;
  value: AccountEntitlement | undefined;
}

const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;

function envMs(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeQuotaValue(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function buildEndpoint(baseUrl: string, accountId: string): string {
  const url = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const basePath = url.pathname.replace(/\/$/, '');
  url.pathname = `${basePath}/v1/internal/accounts/${encodeURIComponent(accountId)}/entitlements/current`.replace(/\/{2,}/g, '/');
  url.search = '';
  url.hash = '';
  return url.toString();
}

export class HttpEntitlementProvider implements EntitlementProvider {
  private readonly logger = getLoggerFor(this);
  private readonly baseUrl: string;
  private readonly serviceToken?: string;
  private readonly cacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, CachedEntitlement>();

  public constructor(options: HttpEntitlementProviderOptions) {
    this.baseUrl = options.baseUrl.trim();
    this.serviceToken = options.serviceToken?.trim() || undefined;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  public async getAccountEntitlement(accountId: string): Promise<AccountEntitlement | undefined> {
    const cached = this.cache.get(accountId);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    try {
      const value = await this.fetchAccountEntitlement(accountId);
      this.cache.set(accountId, {
        value,
        expiresAt: now + this.cacheTtlMs,
      });
      return value;
    } catch (error) {
      this.logger.warn(`Failed to fetch entitlement for ${accountId}: ${error}`);
      return undefined;
    }
  }

  private async fetchAccountEntitlement(accountId: string): Promise<AccountEntitlement | undefined> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (this.serviceToken) {
      headers.Authorization = `Bearer ${this.serviceToken}`;
    }

    const response = await fetch(buildEndpoint(this.baseUrl, accountId), {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (response.status === 404) {
      return undefined;
    }

    if (!response.ok) {
      const body = (await response.text()).slice(0, 500);
      throw new Error(`status=${response.status} body=${body}`);
    }

    const payload = await response.json() as unknown;
    if (!isRecord(payload) || !isRecord(payload.quota)) {
      throw new Error('invalid entitlement payload');
    }

    const quotaPayload = payload.quota;
    return {
      accountId,
      quota: {
        storageLimitBytes: normalizeQuotaValue(quotaPayload.storageLimitBytes),
        bandwidthLimitBps: normalizeQuotaValue(quotaPayload.bandwidthLimitBps),
        computeLimitSeconds: normalizeQuotaValue(quotaPayload.computeLimitSeconds),
        tokenLimitMonthly: normalizeQuotaValue(quotaPayload.tokenLimitMonthly),
      },
    };
  }
}

export function createEntitlementProviderFromEnv(): EntitlementProvider {
  const baseUrl = process.env.XPOD_ENTITLEMENTS_BASE_URL?.trim();
  if (!baseUrl) {
    return new NoopEntitlementProvider();
  }

  return new HttpEntitlementProvider({
    baseUrl,
    serviceToken: process.env.XPOD_ENTITLEMENTS_SERVICE_TOKEN,
    cacheTtlMs: envMs('XPOD_ENTITLEMENTS_CACHE_TTL_MS', DEFAULT_CACHE_TTL_MS),
    timeoutMs: envMs('XPOD_ENTITLEMENTS_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
  });
}
