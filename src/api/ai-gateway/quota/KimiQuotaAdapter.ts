import {
  apiKeyFromSecret,
  decimalAmount,
  errorQuotaSnapshot,
  fetchJsonWithBearer,
  type NormalizedQuotaSnapshot,
  type ProviderQuotaAdapter,
  type ProviderQuotaFetchInput,
  type QuotaWindow,
} from './ProviderQuotaAdapter';

const KIMI_BASE_URL = 'https://api.moonshot.ai/v1';
const SOURCE = 'kimi:/v1/users/me/balance';

export interface KimiQuotaAdapterOptions {
  fetch?: typeof fetch;
}

export class KimiQuotaAdapter implements ProviderQuotaAdapter {
  public readonly provider = 'kimi';
  public readonly capability = { protocol: 'api-balance', profile: 'moonshot' } as const;
  private readonly fetchFn: typeof fetch;

  public constructor(options: KimiQuotaAdapterOptions = {}) {
    this.fetchFn = options.fetch ?? fetch;
  }

  public async fetch(input: ProviderQuotaFetchInput): Promise<NormalizedQuotaSnapshot> {
    const apiKey = apiKeyFromSecret(input.secret);
    if (!apiKey) {
      return errorQuotaSnapshot({
        credential: input.credential.credentialIri,
        source: SOURCE,
        now: input.now,
        metadata: { reason: 'missing_api_key' },
      });
    }
    const result = await fetchJsonWithBearer({
      fetch: this.fetchFn,
      url: `${KIMI_BASE_URL}/users/me/balance`,
      apiKey,
      signal: input.signal,
    });
    if (!result.ok) {
      return errorQuotaSnapshot({
        credential: input.credential.credentialIri,
        source: SOURCE,
        now: input.now,
        status: result.status,
        retryAfter: result.retryAfter,
      });
    }
    return {
      credential: input.credential.credentialIri,
      status: 'available',
      windows: kimiWindows(result.body),
      observedAt: input.now.toISOString(),
      expiresAt: new Date(input.now.getTime() + 5 * 60_000).toISOString(),
      source: SOURCE,
    };
  }
}

function kimiWindows(body: unknown): QuotaWindow[] {
  const data = body && typeof body === 'object' && 'data' in body
    ? (body as { data?: unknown }).data
    : body;
  const object = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  return [
    ['available_balance', object.available_balance],
    ['voucher_balance', object.voucher_balance],
    ['cash_balance', object.cash_balance],
  ].flatMap(([name, value]) => {
    const amount = decimalAmount(value);
    if (!amount.exact) {
      return [];
    }
    return [{
      name: String(name),
      ...(amount.numeric !== undefined ? { remaining: amount.numeric } : {}),
      remainingExact: amount.exact,
      ...(amount.displayApprox ? { displayApprox: true } : {}),
    }];
  });
}
