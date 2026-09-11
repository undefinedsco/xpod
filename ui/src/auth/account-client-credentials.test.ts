// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAccountClientCredentialsCapability } from './account-client-credentials';
import { clearAccountSessionToken, storeAccountSessionToken } from '../utils/account-session';

const index = 'https://id.example/.account/';
const collection = `${index}account/alice/client-credentials/`;
const resource = `${collection}credential-1/`;
const webId = 'https://id.example/alice/profile/card#me';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => clearAccountSessionToken());

describe('account-owned coding client credentials', () => {
  it('uses the discovered Account endpoint and wraps the returned id and secret in UTF-8 Base64', async () => {
    storeAccountSessionToken('account-test-token');
    const fetch = vi.fn(async () => json({ id: '工作客户端', secret: 'secret:with-colon', resource }));
    const capability = createAccountClientCredentialsCapability({ collection, accountIndex: index, fetch });
    const created = await capability.create({ name: 'Codex', webId });
    expect(created).toEqual({
      apiKey: `sk-${Buffer.from('工作客户端:secret:with-colon').toString('base64')}`,
      resource,
    });
    expect(fetch).toHaveBeenCalledWith(collection, expect.objectContaining({
      method: 'POST', credentials: 'include', redirect: 'error',
      headers: expect.objectContaining({ Authorization: 'CSS-Account-Token account-test-token' }),
      body: JSON.stringify({ name: 'Codex', webId }),
    }));
    expect(window.localStorage.length).toBe(0);
  });

  it('checks resource identity before revoking a credential', async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'DELETE'
      ? new Response(null, { status: 204 }) : json({ id: 'client-1', webId }));
    const capability = createAccountClientCredentialsCapability({ collection, accountIndex: index, fetch });
    await capability.revoke({ apiKey: `sk-${btoa('client-1:secret')}`, resource, webId });
    expect(fetch).toHaveBeenLastCalledWith(resource, expect.objectContaining({ method: 'DELETE', redirect: 'error' }));
  });

  it('rejects a different credential or WebID without deleting anything', async () => {
    const fetch = vi.fn(async () => json({ id: 'other-client', webId }));
    const capability = createAccountClientCredentialsCapability({ collection, accountIndex: index, fetch });
    await expect(capability.revoke({ apiKey: `sk-${btoa('client-1:secret')}`, resource, webId }))
      .rejects.toThrow('不匹配');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('never sends the account token to an untrusted credential resource', async () => {
    const fetch = vi.fn(async () => json({}));
    const capability = createAccountClientCredentialsCapability({ collection, accountIndex: index, fetch });
    await expect(capability.revoke({
      apiKey: `sk-${btoa('client-1:secret')}`, resource: 'https://evil.example/.account/credential/', webId,
    })).rejects.toThrow('可信');
    expect(fetch.mock.calls.some(([url]) => String(url).startsWith('https://evil.example'))).toBe(false);
  });

  it.each([404, 410])('allows cleanup retries after a verified successful revocation returns %s', async (status) => {
    let revoked = false;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        revoked = true;
        return new Response(null, { status: 204 });
      }
      return revoked ? new Response(null, { status }) : json({ id: 'client-1', webId });
    });
    const capability = createAccountClientCredentialsCapability({ collection, accountIndex: index, fetch });
    const input = { apiKey: `sk-${btoa('client-1:secret')}`, resource, webId };
    await capability.revoke(input);
    await expect(capability.revoke(input)).resolves.toBeUndefined();
    await expect(capability.revoke({ ...input, webId: 'https://id.example/bob/profile/card#me' }))
      .rejects.toThrow('Key 记录已保留');
    await expect(capability.revoke({ ...input, apiKey: `sk-${btoa('other-client:secret')}` }))
      .rejects.toThrow('Key 记录已保留');
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
    const recreated = createAccountClientCredentialsCapability({ collection, accountIndex: index, fetch });
    await expect(recreated.revoke(input)).rejects.toThrow('Key 记录已保留');
  });

  it.each([404, 410])('preserves the record when Account access hides the credential with %s', async (status) => {
    const fetch = vi.fn(async () => new Response(null, { status }));
    const capability = createAccountClientCredentialsCapability({ collection, accountIndex: index, fetch });
    await expect(capability.revoke({ apiKey: `sk-${btoa('client-1:secret')}`, resource, webId }))
      .rejects.toThrow('Key 记录已保留');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([404, 410])('rejects an ambiguous DELETE %s after the identity check', async (status) => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'DELETE'
      ? new Response(null, { status }) : json({ id: 'client-1', webId }));
    const capability = createAccountClientCredentialsCapability({ collection, accountIndex: index, fetch });
    await expect(capability.revoke({ apiKey: `sk-${btoa('client-1:secret')}`, resource, webId }))
      .rejects.toThrow('撤销客户端凭据失败');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

});
