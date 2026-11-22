import type { ProviderRegistry } from '../providers/ProviderRegistry';
import { ProviderHttpTransport } from '../../service/provider-http-transport';
import {
  apiKeyFromSecret, errorQuotaSnapshot, unsupportedQuotaSnapshot,
  type NormalizedQuotaSnapshot, type ProviderQuotaAdapter, type ProviderQuotaFetchInput,
  type QuotaCredentialRecord, type QuotaWindow,
} from './ProviderQuotaAdapter';

interface UsageDeclaration { url: string; windows: Record<string, string> }

/** Normalizes credential-scoped percentage meters from a program-declared usage endpoint. */
export class DeclaredUsageQuotaAdapter implements ProviderQuotaAdapter {
  public readonly provider = 'metadata';
  public readonly capability = { protocol: 'usage-percent-windows' } as const;
  private readonly registry: ProviderRegistry;
  private readonly transport: ProviderHttpTransport;

  public constructor(options: { providerRegistry: ProviderRegistry; transport?: ProviderHttpTransport; fetch?: typeof fetch }) {
    this.registry = options.providerRegistry;
    this.transport = options.transport ?? new ProviderHttpTransport({ fetch: options.fetch });
  }

  public supports(credential: QuotaCredentialRecord): boolean {
    return this.declaration(credential) !== undefined;
  }

  public async fetch(input: ProviderQuotaFetchInput): Promise<NormalizedQuotaSnapshot> {
    const declaration = this.declaration(input.credential);
    const base = { credential: input.credential.credentialIri, now: input.now };
    if (!declaration) return unsupportedQuotaSnapshot({ ...base, source: 'usage-percent-windows:undeclared' });
    const source = declaration.url;
    const apiKey = apiKeyFromSecret(input.secret);
    if (!apiKey) return errorQuotaSnapshot({ ...base, source, metadata: { reason: 'missing_api_key' } });
    try {
      const body = await this.transport.getJson({
        url: declaration.url,
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', 'user-agent': 'Xpod-Quota/1.0' },
        proxy: input.credential.proxyUrl,
        signal: input.signal,
      });
      const usage = object(object(body)?.usage);
      const windows: QuotaWindow[] = [];
      for (const [key, name] of Object.entries(declaration.windows)) {
        const meter = object(usage?.[key]);
        const percent = meter?.percent;
        const resetsAt = meter?.resetsAt;
        if (!meter || !['ok', 'rate-limited'].includes(String(meter.status))
          || typeof percent !== 'number' || !Number.isInteger(percent) || percent < 0 || percent > 100
          || (meter.status === 'rate-limited' && percent !== 100)
          || !validReset(resetsAt)) {
          return errorQuotaSnapshot({ ...base, source, metadata: { reason: 'invalid_usage_response' } });
        }
        windows.push({ name, used: percent, limit: 100, remaining: 100 - percent, resetsAt: new Date(resetsAt).toISOString() });
      }
      return { credential: base.credential, status: 'available', windows, source,
        observedAt: input.now.toISOString(), expiresAt: new Date(input.now.getTime() + 5 * 60_000).toISOString() };
    } catch (error) {
      if (input.signal?.aborted || (error as Error)?.name === 'AbortError') throw error;
      const failure = error as { status?: number; headers?: Headers };
      return errorQuotaSnapshot({ ...base, source, status: failure?.status,
        retryAfter: failure?.headers?.get('retry-after'), metadata: { reason: 'provider_quota_unavailable' } });
    }
  }

  private declaration(credential: QuotaCredentialRecord): UsageDeclaration | undefined {
    if (!credential.offeringId || credential.authMode !== 'apiKey') return undefined;
    const offering = this.registry.getOffering(credential.provider, credential.offeringId);
    const capability = offering?.upstream.find((item) => item.capability === 'quota' && item.protocol === this.capability.protocol);
    const modes = capability?.options?.credentialAuthModes;
    if (Array.isArray(modes) && !modes.includes(credential.authMode)) return undefined;
    const url = capability?.options?.url;
    const windows = object(capability?.options?.windows);
    if (typeof url !== 'string' || !windows || Object.keys(windows).length === 0
      || Object.values(windows).some((name) => typeof name !== 'string' || !name)) return undefined;
    try { const target = new URL(url); if (target.protocol !== 'https:' || target.username || target.password) return undefined; }
    catch { return undefined; }
    return { url, windows: windows as Record<string, string> };
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function validReset(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.test(value)
    || !Number.isFinite(Date.parse(value))) return false;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
