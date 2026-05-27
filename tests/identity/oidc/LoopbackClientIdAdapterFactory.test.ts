import { beforeEach, describe, expect, it, vi } from 'vitest';
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
});
