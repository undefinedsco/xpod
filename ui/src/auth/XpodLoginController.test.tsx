import { describe, expect, test, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { createXpodLoginController } from './XpodLoginController';
import { createXpodLoginTransactionStore } from './xpod-login-transaction';

function installDom(url = 'https://app.example/dashboard/overview') {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url });
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
}

describe('XpodLoginController', () => {
  test('exposes exactly one current-origin route and starts one callback transaction', async () => {
    installDom();
    const login = vi.fn(async () => undefined);
    const controller = createXpodLoginController({
      runtime: { login },
      transactionStore: createXpodLoginTransactionStore({ origin: window.location.origin }),
    });

    expect(controller.routes).toHaveLength(1);
    expect(controller.routes[0]?.id).toBe('xpod-current-origin');
    expect(controller.routes[0]?.identityProvider.url).toBe(window.location.origin);
    expect(controller.routes[0]?.storageProvider?.url).toBe(window.location.origin);

    const transaction = await controller.startLogin();
    expect(login).toHaveBeenCalledWith(expect.objectContaining({
      route: controller.routes[0],
      authorizationSurface: 'redirect',
    }));
    expect(transaction.id).not.toBe(controller.routes[0]?.id);
    expect(transaction.id.length).toBeGreaterThan(20);
    expect(transaction.returnTo).toBe('/dashboard/overview');
    expect(controller.callbackUrl(transaction.id)).toBe(
      `https://app.example/auth/callback?transaction=${encodeURIComponent(transaction.id)}`,
    );
  });

  test('rejects a second live transaction without a second login call', async () => {
    installDom();
    const login = vi.fn(async () => undefined);
    const controller = createXpodLoginController({
      runtime: { login },
      transactionStore: createXpodLoginTransactionStore({ origin: window.location.origin }),
    });

    await controller.startLogin('/settings/models');
    await expect(controller.startLogin('/settings/models')).rejects.toThrow(/pending|active|transaction/i);
    expect(login).toHaveBeenCalledTimes(1);
  });

  test('allows only the application return-path prefixes', async () => {
    installDom('https://app.example/ai-connections?surface=ai-connections');
    const controller = createXpodLoginController({
      runtime: { login: vi.fn(async () => undefined) },
      transactionStore: createXpodLoginTransactionStore({ origin: window.location.origin }),
    });

    await expect(controller.startLogin('https://evil.example')).rejects.toThrow(/return|safe/i);
    const transaction = await controller.startLogin('/ai-connections?surface=ai-connections');
    expect(transaction.returnTo).toBe('/ai-connections?surface=ai-connections');
  });
});
