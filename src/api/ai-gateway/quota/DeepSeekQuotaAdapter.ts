import {
  apiKeyFromSecret,
  errorQuotaSnapshot,
  fetchJsonWithBearer,
  numeric,
  type NormalizedQuotaSnapshot,
  type ProviderQuotaAdapter,
  type ProviderQuotaFetchInput,
  type QuotaWindow,
} from './ProviderQuotaAdapter';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const SOURCE = 'deepseek:/user/balance';

export interface DeepSeekQuotaAdapterOptions {
  fetch?: typeof fetch;
}

export class DeepSeekQuotaAdapter implements ProviderQuotaAdapter {
  public readonly provider = 'deepseek';
  private readonly fetchFn: typeof fetch;

  public constructor(options: DeepSeekQuotaAdapterOptions = {}) {
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
      url: `${deepSeekApiRoot(input.credential.baseUrl)}/user/balance`,
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
    const object = result.body && typeof result.body === 'object'
      ? result.body as Record<string, unknown>
      : {};
    return {
      credential: input.credential.credentialIri,
      status: 'available',
      windows: deepSeekWindows(object.balance_infos),
      observedAt: input.now.toISOString(),
      expiresAt: new Date(input.now.getTime() + 5 * 60_000).toISOString(),
      source: SOURCE,
      metadata: {
        isAvailable: Boolean(object.is_available),
      },
    };
  }
}

function deepSeekWindows(value: unknown): QuotaWindow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }
    const object = entry as Record<string, unknown>;
    const currency = typeof object.currency === 'string' && object.currency ? object.currency : 'unknown';
    return [
      ['total_balance', object.total_balance],
      ['granted_balance', object.granted_balance],
      ['topped_up_balance', object.topped_up_balance],
    ].flatMap(([name, amount]) => {
      const remaining = numeric(amount);
      return remaining === undefined ? [] : [{ name: `${currency}.${String(name)}`, remaining }];
    });
  });
}

function deepSeekApiRoot(baseUrl: string | undefined): string {
  return (baseUrl ?? DEEPSEEK_BASE_URL).replace(/\/v1\/?$/u, '').replace(/\/+$/u, '');
}
