import { describe, expect, it, vi } from 'vitest';

import { createSessionRequestCredential } from './session-request-credential';
import type { AiClientCredentialsCapability } from '@undefineds.co/extension-sdk/web';

const WEB_ID = 'https://pod.example/alice/profile/card#me';
const API_KEY = `sk-${btoa('alice-client-1:secret-value')}`;

function capability(overrides: Partial<AiClientCredentialsCapability> = {}): AiClientCredentialsCapability {
  return {
    create: vi.fn(async() => ({ apiKey: API_KEY, resource: 'https://pod.example/.account/credential/1' })),
    list: vi.fn(async() => []),
    revoke: vi.fn(async() => undefined),
    ...overrides,
  } as AiClientCredentialsCapability;
}

describe('createSessionRequestCredential', () => {
  it('creates the credential once and returns an sk authorization', async() => {
    const credentials = capability();
    const credential = createSessionRequestCredential({ capability: credentials, webId: WEB_ID });

    await expect(credential.authorization()).resolves.toBe(`Bearer ${API_KEY}`);
    await expect(credential.authorization()).resolves.toBe(`Bearer ${API_KEY}`);

    expect(credentials.create).toHaveBeenCalledTimes(1);
    expect(credentials.create).toHaveBeenCalledWith({ name: 'Xpod 会话凭据', webId: WEB_ID });
    expect(credential.clientId()).toBe('alice-client-1');
  });

  it('creates the credential once when several requests start together', async() => {
    let resolveCreate: ((value: { apiKey: string; resource: string }) => void) | undefined;
    const credentials = capability({
      create: vi.fn(() => new Promise<{ apiKey: string; resource: string }>((resolve) => {
        resolveCreate = resolve;
      })),
    });
    const credential = createSessionRequestCredential({ capability: credentials, webId: WEB_ID });

    const first = credential.authorization();
    const second = credential.authorization();
    resolveCreate?.({ apiKey: API_KEY, resource: 'https://pod.example/.account/credential/1' });

    await expect(Promise.all([ first, second ])).resolves.toEqual([ `Bearer ${API_KEY}`, `Bearer ${API_KEY}` ]);
    expect(credentials.create).toHaveBeenCalledTimes(1);
  });

  it('revokes the credential on release and stops handing it out', async() => {
    const credentials = capability();
    const credential = createSessionRequestCredential({ capability: credentials, webId: WEB_ID });
    await credential.authorization();

    await credential.release();

    expect(credentials.revoke).toHaveBeenCalledWith({
      clientId: 'alice-client-1',
      resource: 'https://pod.example/.account/credential/1',
      webId: WEB_ID,
    });
    await expect(credential.authorization()).resolves.toBeUndefined();
    expect(credential.clientId()).toBeUndefined();
  });

  it('revokes a credential that was created after the session ended', async() => {
    let resolveCreate: ((value: { apiKey: string; resource: string }) => void) | undefined;
    const credentials = capability({
      create: vi.fn(() => new Promise<{ apiKey: string; resource: string }>((resolve) => {
        resolveCreate = resolve;
      })),
    });
    const credential = createSessionRequestCredential({ capability: credentials, webId: WEB_ID });

    const pending = credential.authorization();
    await credential.release();
    resolveCreate?.({ apiKey: API_KEY, resource: 'https://pod.example/.account/credential/1' });

    await expect(pending).resolves.toBeUndefined();
    expect(credentials.revoke).toHaveBeenCalledTimes(1);
    expect(credentials.revoke).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'alice-client-1' }));
  });

  it('hands out nothing when the session cannot create credentials', async() => {
    const credential = createSessionRequestCredential({ webId: WEB_ID });
    await expect(credential.authorization()).resolves.toBeUndefined();
    await expect(credential.release()).resolves.toBeUndefined();

    const anonymous = createSessionRequestCredential({ capability: capability() });
    await expect(anonymous.authorization()).resolves.toBeUndefined();
  });

  it('releases a credential whose id cannot be read without failing', async() => {
    const credentials = capability({
      create: vi.fn(async() => ({ apiKey: 'sk-not-base64', resource: 'https://pod.example/.account/credential/2' })),
    });
    const credential = createSessionRequestCredential({ capability: credentials, webId: WEB_ID });
    await credential.authorization();

    await expect(credential.release()).resolves.toBeUndefined();
    expect(credentials.revoke).toHaveBeenCalledWith(expect.objectContaining({ clientId: '' }));
  });
});
