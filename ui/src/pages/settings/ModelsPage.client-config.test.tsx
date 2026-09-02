import { describe, expect, it, vi } from 'vitest';
import { createXpodAiClientConfigurationBridge } from '../../api/ai-connections';

const POD_URL = 'https://pod.example/alice/';

describe('ModelsPage coding-client configuration capability', () => {
  it('preserves structured client-config errors for failed-and-restored recovery UI', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/applets/service-access/ai-connections') {
        return json({
          aiClientConfiguration: {
            available: true,
            authority: 'local-filesystem',
            invocation: {
              baseUrl: 'https://pod.example',
              token: 'xpod_inv_v1.client-config-token',
            },
          },
        });
      }
      if (url.pathname.endsWith('/apply')) {
        return json({
          code: 'verification_failed_restored',
          message: '配置验证失败，已自动恢复原配置。',
          details: { restored: true },
        }, { status: 502 });
      }
      return json({ status: 'notConfigured' });
    }) as typeof fetch;
    const bridge = createXpodAiClientConfigurationBridge({
      podUrl: POD_URL,
      authenticatedFetch: fetchImpl,
    });

    await expect(bridge.apply({
      client: 'codex',
      planId: 'plan-1',
      apiKey: 'sk-Y2xpZW50LWlkOmNsaWVudC1zZWNyZXQ=',
    })).rejects.toMatchObject({
      code: 'verification_failed_restored',
      status: 502,
      details: { restored: true },
    });
  });
});

function json(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}
