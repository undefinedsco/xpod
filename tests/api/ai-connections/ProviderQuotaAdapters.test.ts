import { describe, expect, it, vi } from 'vitest';

import {
  AnthropicQuotaAdapter,
  BailianQuotaAdapter,
  DeepSeekQuotaAdapter,
  KimiQuotaAdapter,
  OpenAiQuotaAdapter,
} from '../../../src/api/ai-connections/quota';

function jsonFetch(
  handler: (url: string, init: RequestInit | undefined) => {
    status?: number;
    headers?: Record<string, string>;
    body?: unknown;
  },
): typeof fetch {
  return vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const result = handler(url, init);
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
      headers: result.headers,
    });
  }) as unknown as typeof fetch;
}

const NOW = new Date('2026-07-23T00:00:00.000Z');

describe('ProviderQuotaAdapters', () => {
  it('normalizes Kimi official API-key balance without inventing a percentage', async () => {
    const fetch = jsonFetch((url, init) => {
      expect(url).toBe('https://api.moonshot.ai/v1/users/me/balance');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer provider-secret');
      return {
        body: {
          data: {
            available_balance: '12.50',
            voucher_balance: '2.50',
            cash_balance: '10.00',
          },
        },
      };
    });

    const snapshot = await new KimiQuotaAdapter({ fetch }).fetch({
      credential: { provider: 'kimi' },
      secret: { apiKey: 'provider-secret' },
      now: NOW,
    });

    expect(snapshot).toMatchObject({
      credential: 'kimi',
      status: 'available',
      source: 'kimi:/v1/users/me/balance',
      observedAt: '2026-07-23T00:00:00.000Z',
      windows: [
        { name: 'available_balance', remaining: 12.5, remainingExact: '12.50' },
        { name: 'voucher_balance', remaining: 2.5, remainingExact: '2.50' },
        { name: 'cash_balance', remaining: 10, remainingExact: '10.00' },
      ],
    });
    expect(JSON.stringify(snapshot)).not.toContain('percent');
  });

  it('keeps Kimi quota on the official global endpoint even when a request base URL exists', async () => {
    const fetch = jsonFetch((url) => {
      expect(url).toBe('https://api.moonshot.ai/v1/users/me/balance');
      return { body: { data: { available_balance: '1.00' } } };
    });

    await expect(new KimiQuotaAdapter({ fetch }).fetch({
      credential: { provider: 'kimi', baseUrl: 'https://api.moonshot.cn/v1' },
      secret: { apiKey: 'provider-secret' },
      now: NOW,
    })).resolves.toMatchObject({
      status: 'available',
      windows: [{ name: 'available_balance', remaining: 1, remainingExact: '1.00' }],
    });
  });

  it('preserves Kimi official decimal strings as authoritative quota amounts', async () => {
    const fetch = jsonFetch(() => ({
      body: {
        data: {
          available_balance: '9007199254740993.01',
          voucher_balance: '0.1',
        },
      },
    }));

    const snapshot = await new KimiQuotaAdapter({ fetch }).fetch({
      credential: { provider: 'kimi' },
      secret: { apiKey: 'provider-secret' },
      now: NOW,
    });

    expect(snapshot.windows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'available_balance',
        remainingExact: '9007199254740993.01',
      }),
      expect.objectContaining({
        name: 'voucher_balance',
        remaining: 0.1,
        remainingExact: '0.1',
        displayApprox: true,
      }),
    ]));
    expect(snapshot.windows.find((window) => window.name === 'available_balance')).not.toHaveProperty('remaining');
  });

  it('normalizes DeepSeek official user balance endpoint fields', async () => {
    const fetch = jsonFetch((url, init) => {
      expect(url).toBe('https://api.deepseek.com/user/balance');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer deepseek-secret');
      return {
        body: {
          is_available: true,
          balance_infos: [
            {
              currency: 'USD',
              total_balance: '3.75',
              granted_balance: '1.25',
              topped_up_balance: '2.50',
            },
          ],
        },
      };
    });

    const snapshot = await new DeepSeekQuotaAdapter({ fetch }).fetch({
      credential: { provider: 'deepseek' },
      secret: { apiKey: 'deepseek-secret' },
      now: NOW,
    });

    expect(snapshot).toMatchObject({
      credential: 'deepseek',
      status: 'available',
      source: 'deepseek:/user/balance',
      windows: [
        { name: 'USD.total_balance', remaining: 3.75, remainingExact: '3.75', currency: 'USD' },
        { name: 'USD.granted_balance', remaining: 1.25, remainingExact: '1.25', currency: 'USD' },
        { name: 'USD.topped_up_balance', remaining: 2.5, remainingExact: '2.50', currency: 'USD' },
      ],
      metadata: {
        isAvailable: true,
      },
    });
  });

  it('always calls the exact DeepSeek balance endpoint and never sends Bearer to request baseUrl', async () => {
    const fetch = jsonFetch((url, init) => {
      expect(url).toBe('https://api.deepseek.com/user/balance');
      expect(url).not.toContain('attacker.example');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer deepseek-secret');
      return {
        body: {
          is_available: true,
          balance_infos: [{ currency: 'USD', total_balance: '0.1' }],
        },
      };
    });

    const snapshot = await new DeepSeekQuotaAdapter({ fetch }).fetch({
      credential: { provider: 'deepseek', baseUrl: 'https://attacker.example/v1' },
      secret: { apiKey: 'deepseek-secret' },
      now: NOW,
    });

    expect(snapshot.windows).toEqual([
      expect.objectContaining({
        name: 'USD.total_balance',
        remaining: 0.1,
        remainingExact: '0.1',
        displayApprox: true,
      }),
    ]);
  });

  it('returns unsupported for providers without credential-scoped official quota API', async () => {
    await expect(new OpenAiQuotaAdapter().fetch({
      credential: { provider: 'openai' },
      secret: { apiKey: 'openai-secret' },
      now: NOW,
    })).resolves.toMatchObject({
      credential: 'openai',
      status: 'unsupported',
      source: 'openai:no-credential-quota-api',
      windows: [],
    });
    await expect(new AnthropicQuotaAdapter().fetch({
      credential: { provider: 'anthropic' },
      secret: { apiKey: 'anthropic-secret' },
      now: NOW,
    })).resolves.toMatchObject({
      credential: 'anthropic',
      status: 'unsupported',
      source: 'anthropic:no-credential-quota-api',
      windows: [],
    });
    await expect(new BailianQuotaAdapter().fetch({
      credential: { provider: 'bailian' },
      secret: { apiKey: 'bailian-secret' },
      now: NOW,
    })).resolves.toMatchObject({
      credential: 'bailian',
      status: 'unsupported',
      source: 'bailian:console-only',
      windows: [],
    });
  });

  it('records 429 as cooldown metadata without leaking the request key', async () => {
    const fetch = jsonFetch(() => ({
      status: 429,
      headers: { 'retry-after': '30' },
      body: { error: { message: 'slow down and secret provider-secret' } },
    }));

    const snapshot = await new KimiQuotaAdapter({ fetch }).fetch({
      credential: { provider: 'kimi' },
      secret: { apiKey: 'provider-secret' },
      now: NOW,
    });

    expect(snapshot).toMatchObject({
      credential: 'kimi',
      status: 'error',
      source: 'kimi:/v1/users/me/balance',
      windows: [],
      metadata: {
        cooldown: {
          reason: 'rate_limited',
          retryAfterSeconds: 30,
        },
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain('provider-secret');
  });
});
