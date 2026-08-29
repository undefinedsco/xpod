import { beforeEach, describe, expect, it, vi } from 'vitest';
import { interactionPolicy } from 'oidc-provider';
import { LoopbackClientIdAdapterFactory } from '../../../src/identity/oidc/LoopbackClientIdAdapterFactory';

describe('LoopbackClientIdAdapterFactory', () => {
  const converter = {} as any;
  let source: { createStorageAdapter: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    source = {
      createStorageAdapter: vi.fn(),
    };
  });

  it('marks loopback redirect clients as native', async () => {
    source.createStorageAdapter.mockReturnValue({
      find: vi.fn().mockResolvedValue({
        client_id: 'https://client.example/app',
        redirect_uris: [ 'http://127.0.0.1:61226/auth/callback' ],
      }),
    });

    const factory = new LoopbackClientIdAdapterFactory(source as any, converter);
    const adapter = factory.createStorageAdapter('Client');
    const payload = await adapter.find('https://client.example/app');

    expect(payload).toMatchObject({
      application_type: 'native',
      redirect_uris: [ 'http://127.0.0.1:61226/auth/callback' ],
    });
  });

  it('preserves explicit web application_type for loopback redirect clients', async () => {
    source.createStorageAdapter.mockReturnValue({
      find: vi.fn().mockResolvedValue({
        client_id: 'https://client.example/app',
        application_type: 'web',
        redirect_uris: [
          'http://127.0.0.1:61226/auth/callback',
          'http://localhost:5173/auth/callback',
          'http://[::1]:5173/auth/callback',
        ],
      }),
    });

    const factory = new LoopbackClientIdAdapterFactory(source as any, converter);
    const adapter = factory.createStorageAdapter('Client');
    const payload = await adapter.find('https://client.example/app');

    expect(payload).toMatchObject({
      application_type: 'web',
      redirect_uris: [
        'http://127.0.0.1:61226/auth/callback',
        'http://localhost:5173/auth/callback',
        'http://[::1]:5173/auth/callback',
      ],
    });
  });

  it('preserves explicit native application_type', async () => {
    source.createStorageAdapter.mockReturnValue({
      find: vi.fn().mockResolvedValue({
        client_id: 'https://client.example/app',
        application_type: 'native',
        redirect_uris: [ 'https://app.example/callback' ],
      }),
    });

    const factory = new LoopbackClientIdAdapterFactory(source as any, converter);
    const adapter = factory.createStorageAdapter('Client');
    const payload = await adapter.find('https://client.example/app');

    expect(payload).toMatchObject({
      application_type: 'native',
      redirect_uris: [ 'https://app.example/callback' ],
    });
  });

  it('leaves regular web clients unchanged', async () => {
    source.createStorageAdapter.mockReturnValue({
      find: vi.fn().mockResolvedValue({
        client_id: 'https://client.example/app',
        redirect_uris: [ 'https://app.example/callback' ],
      }),
    });

    const factory = new LoopbackClientIdAdapterFactory(source as any, converter);
    const adapter = factory.createStorageAdapter('Client');
    const payload = await adapter.find('https://client.example/app');

    expect(payload).not.toHaveProperty('application_type');
  });

  it('does not mask unknown application_type values as native', async () => {
    source.createStorageAdapter.mockReturnValue({
      find: vi.fn().mockResolvedValue({
        client_id: 'https://client.example/app',
        application_type: 'desktop',
        redirect_uris: [ 'http://127.0.0.1:61226/auth/callback' ],
      }),
    });

    const factory = new LoopbackClientIdAdapterFactory(source as any, converter);
    const adapter = factory.createStorageAdapter('Client');
    const payload = await adapter.find('https://client.example/app');

    expect(payload).toMatchObject({
      application_type: 'desktop',
      redirect_uris: [ 'http://127.0.0.1:61226/auth/callback' ],
    });
  });
});

describe('oidc-provider native consent policy', () => {
  function nativeClientPromptCheck(): any {
    const consentPrompt = interactionPolicy.base().get('consent');
    const check = [ ...consentPrompt!.checks ].find(({ reason }) => reason === 'native_client_prompt');
    if (!check) {
      throw new Error('Missing oidc-provider native_client_prompt check');
    }
    return check;
  }

  it('does not trigger native_client_prompt for explicit web loopback clients', async () => {
    const check = nativeClientPromptCheck();
    const result = await check.check({
      oidc: {
        client: { applicationType: 'web' },
        params: { response_type: 'code' },
      },
    });

    expect(result).toBe(false);
  });

  it('still triggers native_client_prompt for explicit native clients', async () => {
    const check = nativeClientPromptCheck();
    const result = await check.check({
      oidc: {
        client: { applicationType: 'native' },
        params: { response_type: 'code' },
      },
    });

    expect(result).toBe(true);
    expect(check.error).toBe('interaction_required');
  });
});
