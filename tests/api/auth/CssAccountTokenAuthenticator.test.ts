import type { IncomingMessage } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { CssAccountTokenAuthenticator } from '../../../src/api/auth/CssAccountTokenAuthenticator';

function request(authorization: string): IncomingMessage {
  return { headers: { authorization } } as IncomingMessage;
}

describe('CssAccountTokenAuthenticator', () => {
  it('authenticates a CSS account token to its own account context', async () => {
    const resolveAccountId = vi.fn(async (token: string) => token === 'account-token' ? 'account-1' : undefined);
    const authenticator = new CssAccountTokenAuthenticator({ resolveAccountId });

    expect(authenticator.canAuthenticate(request('CSS-Account-Token account-token'))).toBe(true);
    const result = await authenticator.authenticate(request('CSS-Account-Token account-token'));

    expect(result).toEqual({
      success: true,
      context: {
        type: 'account',
        accountId: 'account-1',
        tokenType: 'CSS-Account-Token',
      },
    });
    expect(resolveAccountId).toHaveBeenCalledWith('account-token');
  });

  it('rejects unknown or malformed CSS account tokens without creating a principal', async () => {
    const resolveAccountId = vi.fn(async () => undefined);
    const authenticator = new CssAccountTokenAuthenticator({ resolveAccountId });

    expect(authenticator.canAuthenticate(request('CSS-Account-Token'))).toBe(false);
    await expect(authenticator.authenticate(request('CSS-Account-Token unknown'))).resolves.toMatchObject({
      success: false,
      category: 'invalid_credentials',
      statusCode: 401,
    });
    expect(resolveAccountId).toHaveBeenCalledWith('unknown');
  });

  it('never includes the presented token in authentication failures', async () => {
    const presentedToken = 'secret-account-token';
    const authenticator = new CssAccountTokenAuthenticator({
      resolveAccountId: vi.fn(async () => undefined),
    });

    const result = await authenticator.authenticate(request(`CSS-Account-Token ${presentedToken}`));

    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain(presentedToken);
  });

  it('reports backing-store failures without exposing storage details', async () => {
    const authenticator = new CssAccountTokenAuthenticator({
      resolveAccountId: vi.fn(async () => {
        throw new Error('redis://secret.example:6379/0');
      }),
    });

    await expect(authenticator.authenticate(request('CSS-Account-Token token'))).resolves.toMatchObject({
      success: false,
      category: 'service_unavailable',
      statusCode: 503,
    });
    const result = await authenticator.authenticate(request('CSS-Account-Token token'));
    expect(JSON.stringify(result)).not.toContain('redis://secret.example');
  });
});
