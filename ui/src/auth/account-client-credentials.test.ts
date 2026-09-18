// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAccountClientCredentialsCapability } from './account-client-credentials';
import { bindAccountSessionAuthority, clearAccountSessionToken, storeAccountSessionToken } from '../utils/account-session';

const index = 'https://id.example/.account/';
const collection = `${index}account/alice/client-credentials/`;
const resource = `${collection}credential-1/`;
const webId = 'https://id.example/alice/profile/card#me';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => clearAccountSessionToken());

describe('account-owned coding client credentials', () => {
  it('uses the discovered Account endpoint and wraps the returned id and secret in UTF-8 Base64', async () => {
    bindAccountSessionAuthority(index);
    storeAccountSessionToken('account-test-token');
    const fetch = vi.fn(async () => json({ id: '工作客户端', secret: 'secret:with-colon', resource }));
    const capability = createAccountClientCredentialsCapability({ collection, accountIndex: index, fetch, assertCurrent: () => undefined });
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
    expect(Object.values(window.localStorage)).not.toContain('account-test-token');
  });

  it('checks resource identity before revoking a credential', async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'DELETE'
      ? new Response(null, { status: 204 }) : json({ id: 'client-1', webId }));
    const capability = createAccountClientCredentialsCapability({ collection, accountIndex: index, fetch, assertCurrent: () => undefined });
    await capability.revoke({ clientId: 'client-1', resource, webId });
    expect(fetch).toHaveBeenLastCalledWith(resource, expect.objectContaining({ method: 'DELETE', redirect: 'error' }));
  });

  it('rejects a different credential or WebID without deleting anything', async () => {
    const fetch = vi.fn(async () => json({ id: 'other-client', webId }));
    const capability = createAccountClientCredentialsCapability({ collection, accountIndex: index, fetch, assertCurrent: () => undefined });
    await expect(capability.revoke({ clientId: 'client-1', resource, webId }))
      .rejects.toThrow('不匹配');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('never sends the account token to an untrusted credential resource', async () => {
    const fetch = vi.fn(async () => json({}));
    const capability = createAccountClientCredentialsCapability({ collection, accountIndex: index, fetch, assertCurrent: () => undefined });
    await expect(capability.revoke({
      clientId: 'client-1', resource: 'https://evil.example/.account/credential/', webId,
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
    const capability = createAccountClientCredentialsCapability({ collection, accountIndex: index, fetch, assertCurrent: () => undefined });
    const input = { clientId: 'client-1', resource, webId };
    await capability.revoke(input);
    await expect(capability.revoke(input)).resolves.toBeUndefined();
    await expect(capability.revoke({ ...input, webId: 'https://id.example/bob/profile/card#me' }))
      .rejects.toThrow('Key 记录已保留');
    await expect(capability.revoke({ ...input, clientId: 'other-client' }))
      .rejects.toThrow('Key 记录已保留');
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
    const recreated = createAccountClientCredentialsCapability({ collection, accountIndex: index, fetch, assertCurrent: () => undefined });
    await expect(recreated.revoke(input)).rejects.toThrow('Key 记录已保留');
  });

  it.each([404, 410])('preserves the record when Account access hides the credential with %s', async (status) => {
    const fetch = vi.fn(async () => new Response(null, { status }));
    const capability = createAccountClientCredentialsCapability({ collection, accountIndex: index, fetch, assertCurrent: () => undefined });
    await expect(capability.revoke({ clientId: 'client-1', resource, webId }))
      .rejects.toThrow('Key 记录已保留');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([404, 410])('rejects an ambiguous DELETE %s after the identity check', async (status) => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'DELETE'
      ? new Response(null, { status }) : json({ id: 'client-1', webId }));
    const capability = createAccountClientCredentialsCapability({ collection, accountIndex: index, fetch, assertCurrent: () => undefined });
    await expect(capability.revoke({ clientId: 'client-1', resource, webId }))
      .rejects.toThrow('撤销客户端凭据失败');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

});


describe('Account capability session binding', () => {
  it.each(['create', 'list', 'revoke'] as const)('rejects old A %s before sending B credentials', async (method) => {
    let active = true;
    const assertCurrent = () => { if (!active) throw new Error('account session changed'); };
    const fetch = vi.fn(async () => json({ id: 'client-1', secret: 'secret', resource, webId }));
    const capability = createAccountClientCredentialsCapability({ collection, accountIndex: index, fetch, assertCurrent });
    active = false;
    const operation = method === 'create' ? capability.create({ name: 'test', webId }) : method === 'list' ? capability.list!() : capability.revoke({ clientId: 'client-1', resource, webId });
    await expect(operation).rejects.toThrow('account session changed');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['create', 'revoke'] as const)('rejects a late %s response after switching account', async (method) => {
    let active = true;
    let release!: (response: Response) => void;
    const response = new Promise<Response>(resolve => { release = resolve; });
    const fetch = vi.fn(() => response);
    const capability = createAccountClientCredentialsCapability({ collection, accountIndex: index, fetch, assertCurrent: () => { if (!active) throw new Error('account session changed'); } });
    const operation = method === 'create' ? capability.create({ name: 'test', webId }) : capability.revoke({ clientId: 'client-1', resource, webId });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    active = false;
    release(json({ id: 'client-1', secret: 'secret', resource, webId }));
    await expect(operation).rejects.toThrow('account session changed');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

it('does not attach a token bound to another Account authority', async () => {
  bindAccountSessionAuthority('https://other.example/.account/');
  storeAccountSessionToken('other-authority-token');
  const fetch = vi.fn(async () => json({ clientCredentials: {} }));
  await createAccountClientCredentialsCapability({ collection, accountIndex: index, fetch, assertCurrent: () => undefined }).list!();
  expect(fetch).toHaveBeenCalledWith(collection, expect.objectContaining({ headers: { Accept: 'application/json' } }));
});


it.each(['create', 'list', 'revoke'] as const)('rejects %s after response JSON completes under a different account', async (method) => {
  let active = true;
  const response = json({});
  vi.spyOn(response, 'json').mockImplementation(async () => { active = false; return { id: 'client-1', secret: 'secret', resource, webId, clientCredentials: {} }; });
  const fetch = vi.fn(async () => response);
  const capability = createAccountClientCredentialsCapability({ collection, accountIndex: index, fetch, assertCurrent: () => { if (!active) throw new Error('account changed'); } });
  const operation = method === 'create' ? capability.create({ name: 'test', webId }) : method === 'list' ? capability.list!() : capability.revoke({ clientId: 'client-1', resource, webId });
  await expect(operation).rejects.toThrow('account changed');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('cancels a stale response stream without claiming an issued POST was undone', async () => {
  let active = true;
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }));
  const fetch = vi.fn(async () => { active = false; return response; });
  const capability = createAccountClientCredentialsCapability({ collection, accountIndex: index, fetch, assertCurrent: () => { if (!active) throw new Error('account changed'); } });
  await expect(capability.create({ name: 'test', webId })).rejects.toThrow('account changed');
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
});
