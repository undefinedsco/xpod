import { describe, expect, it, vi } from 'vitest';
import { ExternalLoginProviderFactory } from '../../../src/identity/external/ExternalLoginProviderFactory';
import { LogtoSocialConnectorAdapter } from '../../../src/identity/external/LogtoSocialConnectorAdapter';
import { configuredExternalLoginEntries, createExternalLoginProviderFactory } from '../../../src/identity/external/externalLoginProviders';

const metadata = { id: 'social', provider: 'example', name: 'Example', namespace: 'app' };
const mapping = { subject: { source: 'profile' as const, field: 'id' } };

describe('external login provider factory', () => {
  it('creates independent applications of the published connector with their own identity scope', async () => {
    const factory = createExternalLoginProviderFactory();
    const first = factory.create({ id: 'wechat-web', connector: 'logto-wechat-web', config: { appId: 'app-one', appSecret: 'secret-one' } });
    const second = factory.create({ id: 'wechat-second', connector: 'logto-wechat-web', name: '第二个网站', config: { appId: 'app-two', appSecret: 'secret-two' } });
    expect(first).toMatchObject({ id: 'wechat-web', provider: 'wechat', namespace: 'app-one', name: '微信' });
    expect(second).toMatchObject({ id: 'wechat-second', provider: 'wechat', namespace: 'app-two', name: '第二个网站' });
    const urls = await Promise.all([first, second].map(provider => provider.authorizationUrl('state', `https://id.test/${provider.id}/callback/`)));
    expect(urls.map(url => new URL(url).searchParams.get('appid'))).toEqual(['app-one', 'app-two']);
    expect(urls.every(url => !url.includes('secret'))).toBe(true);
  });

  it('keeps absent deployment credentials disabled and rejects incomplete or invalid credentials', () => {
    expect(configuredExternalLoginEntries({})).toEqual([]);
    expect(() => configuredExternalLoginEntries({ wechatAppId: 'app' })).toThrow('both');
    const entries = configuredExternalLoginEntries({ wechatAppId: 'app', wechatAppSecret: 'secret' });
    expect(createExternalLoginProviderFactory().create(entries[0])).toMatchObject({ id: 'wechat', provider: 'wechat', namespace: 'app' });
    expect(() => createExternalLoginProviderFactory().create({ ...entries[0], config: { appId: 'app', appSecret: ' ' } })).toThrow('both');
  });

  it('accepts another supplier through the same factory and rejects ambiguous registrations', () => {
    const factory = new ExternalLoginProviderFactory();
    const connector = { id: 'other-supplier', create: (entry: { id: string }) => ({ ...metadata, id: entry.id,
      authorizationUrl: async () => 'https://example.test/authorize', identity: async () => ({ subject: 'subject' }) }) };
    factory.register(connector);
    const entry = { id: 'external', connector: connector.id, config: {} };
    expect(factory.create(entry)).toMatchObject({ id: 'external', provider: 'example' });
    expect(() => factory.register(connector)).toThrow('Duplicate');
    expect(() => factory.create({ ...entry, connector: 'unknown' })).toThrow('not registered');
    expect(() => factory.create({ ...entry, id: '../callback' })).toThrow('Invalid');
  });
});

describe('Logto social connector adapter', () => {
  it('lazily shares one connector initialization across concurrent operations', async () => {
    const initialize = vi.fn(async () => ({ getAuthorizationUri: async () => 'https://example.test/authorize',
      getUserInfo: async () => ({ id: 'stable-subject' }) }));
    const adapter = new LogtoSocialConnectorAdapter(metadata, initialize, mapping);
    expect(initialize).not.toHaveBeenCalled();
    const results = await Promise.all([adapter.authorizationUrl('state', 'https://id.test/callback/'), adapter.identity('code'), adapter.identity('second')]);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(results.slice(1)).toEqual([{ subject: 'stable-subject' }, { subject: 'stable-subject' }]);
  });

  it('sanitizes failed initialization and authorization errors, and permits a later retry', async () => {
    const getAuthorizationUri = vi.fn(async () => 'https://example.test/authorize');
    const initialize = vi.fn(async () => ({ getAuthorizationUri, getUserInfo: async () => ({ id: 'stable' }) }));
    initialize.mockRejectedValueOnce(new Error('https://upstream.test/?secret=DO_NOT_EXPOSE'));
    const adapter = new LogtoSocialConnectorAdapter(metadata, initialize, mapping);
    await expect(adapter.authorizationUrl('state', 'https://id.test/callback/')).rejects.toThrow(/^EXTERNAL_AUTHORIZATION_FAILED$/u);
    getAuthorizationUri.mockRejectedValueOnce(new Error('token=DO_NOT_EXPOSE'));
    await expect(adapter.authorizationUrl('state', 'https://id.test/callback/')).rejects.toThrow(/^EXTERNAL_AUTHORIZATION_FAILED$/u);
    expect(await adapter.identity('code')).toEqual({ subject: 'stable' });
    expect(initialize).toHaveBeenCalledTimes(2);
  });

  it('requires the declared stable subject instead of silently falling back to another identity field', async () => {
    const adapter = new LogtoSocialConnectorAdapter(metadata, async () => ({ getAuthorizationUri: async () => '',
      getUserInfo: async () => ({ id: 'union-id', rawData: { unionid: 'union-id' } }) }), {
      subject: { source: 'rawData', field: 'openid' },
    });
    await expect(adapter.identity('code')).rejects.toThrow('EXTERNAL_AUTHORIZATION_FAILED');
  });
});
