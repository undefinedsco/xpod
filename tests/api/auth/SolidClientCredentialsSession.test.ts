import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionState = vi.hoisted(() => ({
  login: vi.fn(),
  fetch: vi.fn(),
  sessionConstructor: vi.fn(),
}));

vi.mock('@inrupt/solid-client-authn-node', () => ({
  Session: sessionState.sessionConstructor,
}));

import { loginWithClientCredentials } from '../../../src/api/auth/SolidClientCredentialsSession';

describe('loginWithClientCredentials', () => {
  beforeEach(() => {
    sessionState.login.mockReset().mockResolvedValue(undefined);
    sessionState.fetch.mockReset();
    sessionState.sessionConstructor.mockReset().mockImplementation(() => ({
      login: sessionState.login,
      fetch: sessionState.fetch,
      info: {
        isLoggedIn: true,
        webId: 'https://pod.example/alice/profile/card#me',
      },
    }));
  });

  it('creates a fresh Node Solid session instead of replaying the API access token', async () => {
    const session = await loginWithClientCredentials({
      type: 'solid',
      webId: 'https://pod.example/alice/profile/card#me',
      clientId: 'solid-client-id',
      clientSecret: 'solid-client-secret',
      oidcIssuer: 'https://pod.example/',
      accessToken: 'api-token-that-must-not-be-replayed',
      tokenType: 'DPoP',
      viaApiKey: true,
    });

    expect(sessionState.login).toHaveBeenCalledWith({
      clientId: 'solid-client-id',
      clientSecret: 'solid-client-secret',
      oidcIssuer: 'https://pod.example/',
      tokenType: 'Bearer',
    });
    expect(session.fetch).toBe(sessionState.fetch);
    expect(sessionState.fetch).not.toHaveBeenCalled();
  });

  it('fails closed when the Node Solid session did not log in', async () => {
    sessionState.sessionConstructor.mockImplementation(() => ({
      login: sessionState.login,
      fetch: sessionState.fetch,
      info: { isLoggedIn: false },
    }));

    await expect(loginWithClientCredentials({
      type: 'solid',
      webId: 'https://pod.example/alice/profile/card#me',
      clientId: 'solid-client-id',
      clientSecret: 'solid-client-secret',
      viaApiKey: true,
    })).rejects.toThrow('Client credentials Solid session login failed');
  });
});
