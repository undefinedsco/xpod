import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvExtractor } from '../../../src/init/EnvExtractor';
import config from '../../../config/external-login.json';
import { ExternalLoginRequestGuard } from '../../../src/identity/external/ExternalLoginRequestGuard';
import type { ExternalLoginService } from '../../../src/identity/external/ExternalLoginService';

afterEach(() => { vi.unstubAllEnvs(); });
describe('external login configuration boundaries', () => {
  it('rejects cross-origin browser mutations, including sibling sites, but permits the public GET callback', async () => {
    const service = { accountRoot: new URL('https://id.example.test/.account/'), providers: new Map([['wechat', {}]]) } as unknown as ExternalLoginService;
    const guard = new ExternalLoginRequestGuard(service);
    const request = (method: string, url: string, headers = {}) => ({ request: { method, url, headers } } as Parameters<ExternalLoginRequestGuard['handle']>[0]);
    await expect(guard.handle(request('DELETE', '/.account/login/wechat/', { origin: 'https://evil.example.test' }))).rejects.toThrow('SAME_ORIGIN');
    await expect(guard.handle(request('POST', '/.account/interaction/flow/login/wechat/callback/', { 'sec-fetch-site': 'same-site' }))).rejects.toThrow('SAME_ORIGIN');
    await expect(guard.handle(request('POST', '/.account/login/wechat/', { origin: 'null' }))).rejects.toThrow('SAME_ORIGIN');
    await expect(guard.handle(request('POST', '/.account/login/wechat/', { origin: 'https://id.example.test', 'sec-fetch-site': 'same-origin' }))).resolves.toBeUndefined();
    await expect(guard.handle(request('GET', '/.account/login/wechat/callback/', { origin: 'https://open.weixin.qq.com', 'sec-fetch-site': 'cross-site' }))).resolves.toBeUndefined();
    await expect(guard.handle(request('POST', '/.account/login/password/', { origin: 'https://elsewhere.test' }))).resolves.toBeUndefined();
  });
  it('reads the canonical deployment secret from ENV, never from the CLI arguments', async () => {
    vi.stubEnv('XPOD_WECHAT_APP_SECRET', 'fixture-secret');
    const extractor = new EnvExtractor('XPOD_WECHAT_APP_SECRET');
    expect(await extractor.handleSafe({ XPOD_WECHAT_APP_SECRET: 'untrusted-cli-value' })).toBe('fixture-secret');
    delete process.env.XPOD_WECHAT_APP_SECRET;
    expect(await extractor.handleSafe({})).toBe('');
  });
  it('registers the provider relative to the current CSS LoginRoute, without a second API server', () => {
    const route = config['@graph'].find(value => value['@id'] === 'urn:undefineds:xpod:ExternalLoginRoute');
    expect(route).toMatchObject({ '@type': 'IdInteractionRoute', base: { '@id': 'urn:solid-server:default:LoginRoute' }, idName: 'providerId' });
    expect(JSON.stringify(config)).not.toContain('/start/');
    expect(JSON.stringify(config)).not.toContain('localhost');
  });
});
