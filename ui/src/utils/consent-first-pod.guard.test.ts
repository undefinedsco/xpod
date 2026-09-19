// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createFirstPodAndWaitForBinding, createFirstPodAndWaitForWebIds } from './consent-first-pod';
import { prepareProvisionedPod } from './provision-scope';
vi.mock('./account-control-url', () => ({ resolveHostedAccountControlUrl: async (url: string) => url }));
vi.mock('./pod', () => ({ resolveProvisionCodeForPodCreate: async (code?: string) => code, buildPodCreatePayload: (name: string, provisionCode?: string, provisionReceipt?: string) => ({ name, provisionCode, provisionReceipt }), isManagedLocalProvisionHost: () => false }));
vi.mock('./provision-scope', async importOriginal => ({ ...await importOriginal<typeof import('./provision-scope')>(), prepareProvisionedPod: vi.fn(async () => undefined) }));
afterEach(() => { vi.clearAllMocks(); document.cookie = 'css-account=; Max-Age=0; Path=/'; });
const control = `${window.location.origin}/.account/pod/`;
const code = `${btoa(JSON.stringify({ spUrl: 'https://local.example/', serviceToken: 'fixture', exp: Math.floor(Date.now() / 1000) + 3600 }))}.signature`;
function fixture(pods: unknown, status = 200, onRead?: () => void) {
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return new Response(JSON.stringify({ webId: 'https://local.example/alice/profile/card#me', podUrl: 'https://local.example/alice/' }));
    onRead?.(); return new Response(JSON.stringify(pods), { status });
  });
}
it.each([createFirstPodAndWaitForBinding, createFirstPodAndWaitForWebIds])('blocks existing target Pod before any prepare or POST (%#)', async create => {
  const fetchImpl = fixture({ pods: { 'https://local.example/orphan/': '/.account/pod/id' } });
  await expect(create({ createPodUrl: control, username: 'different-name', provisionCode: code, fetchImpl })).rejects.toThrow(/绑定|binding/);
  expect(prepareProvisionedPod).not.toHaveBeenCalled();
  expect(fetchImpl.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
it.each([{}, { pods: [] }, { pods: null }, { pods: { bad: 'resource' } }])('fails closed for malformed inventory %j', async payload => {
  const fetchImpl = fixture(payload);
  await expect(createFirstPodAndWaitForBinding({ createPodUrl: control, username: 'alice', fetchImpl })).rejects.toThrow();
  expect(prepareProvisionedPod).not.toHaveBeenCalled();
});
it.each([401, 403, 500])('fails closed for inventory HTTP %i', async status => {
  const fetchImpl = fixture({ pods: {} }, status);
  await expect(createFirstPodAndWaitForBinding({ createPodUrl: control, username: 'alice', fetchImpl })).rejects.toThrow();
  expect(prepareProvisionedPod).not.toHaveBeenCalled();
});
it('permits genuinely new accounts with authoritative empty inventory', async () => {
  const fetchImpl = fixture({ pods: {} });
  await expect(createFirstPodAndWaitForBinding({ createPodUrl: control, username: 'alice', fetchImpl })).resolves.toHaveLength(1);
  expect(prepareProvisionedPod).toHaveBeenCalledTimes(1);
});
it('permits adding a new Local target when existing Pods belong to another scope', async () => {
  const fetchImpl = fixture({ pods: { 'https://cloud.example/alice/': '/.account/pod/id' } });
  await expect(createFirstPodAndWaitForBinding({ createPodUrl: control, username: 'alice', provisionCode: code, fetchImpl })).resolves.toHaveLength(1);
});
it('without authoritative target does not guess an IdP storage root', async () => {
  const fetchImpl = fixture({ pods: { 'https://different.example/existing/': '/.account/pod/id' } });
  await expect(createFirstPodAndWaitForBinding({ createPodUrl: control, username: 'alice', fetchImpl })).rejects.toThrow(/绑定|binding/);
});
it('stops before prepare if Account changes while reading inventory', async () => {
  document.cookie = 'css-account=account-a; Path=/';
  const fetchImpl = fixture({ pods: {} }, 200, () => { document.cookie = 'css-account=account-b; Path=/'; });
  await expect(createFirstPodAndWaitForBinding({ createPodUrl: control, username: 'alice', fetchImpl })).rejects.toThrow(/账号|Account/);
  expect(prepareProvisionedPod).not.toHaveBeenCalled();
});
it('preserves prepared Local receipt recovery while Account inventory is still empty', async () => {
  vi.mocked(prepareProvisionedPod).mockResolvedValueOnce({ provisionCode: code, provisionReceipt: 'own-receipt' });
  const fetchImpl = fixture({ pods: {} });
  await expect(createFirstPodAndWaitForBinding({ createPodUrl: control, username: 'alice', provisionCode: code, fetchImpl })).resolves.toHaveLength(1);
  expect(prepareProvisionedPod).toHaveBeenCalledWith(expect.any(Function), 'alice', code);
  expect(JSON.parse(fetchImpl.mock.calls.find(([, init]) => init?.method === 'POST')![1]!.body as string).provisionReceipt).toBe('own-receipt');
});
it('does not commit to Account after a session switch during Local prepare', async () => {
  document.cookie = 'css-account=account-a; Path=/';
  vi.mocked(prepareProvisionedPod).mockImplementationOnce(async () => { document.cookie = 'css-account=account-b; Path=/'; return undefined; });
  const fetchImpl = fixture({ pods: {} });
  await expect(createFirstPodAndWaitForBinding({ createPodUrl: control, username: 'alice', provisionCode: code, fetchImpl })).rejects.toThrow(/账号/);
  expect(fetchImpl.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
it('treats network failure as unavailable rather than an empty inventory', async () => {
  const fetchImpl = vi.fn(async () => { throw new TypeError('network unavailable'); });
  await expect(createFirstPodAndWaitForBinding({ createPodUrl: control, username: 'alice', fetchImpl })).rejects.toThrow(/暂时无法确认/);
  expect(prepareProvisionedPod).not.toHaveBeenCalled();
});
it('rejects a stale explicit CSS token after the cookie is cleared', async () => {
  const fetchImpl = fixture({ pods: {} });
  await expect(createFirstPodAndWaitForBinding({ createPodUrl: control, username: 'alice', fetchImpl,
    headers: { Authorization: 'CSS-Account-Token old-account' } })).rejects.toThrow(/账号/);
  expect(fetchImpl).not.toHaveBeenCalled();
});
it.each(['inventory', 'create', 'poll'])('rejects Account changes inside %s response JSON parsing', async phase => {
  document.cookie = 'css-account=account-a; Path=/';
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const current = String(url).includes('pick') ? 'poll' : init?.method === 'POST' ? 'create' : 'inventory';
    const response = new Response(JSON.stringify(current === 'inventory' ? { pods: {} } : current === 'create'
      ? { webId: 'https://local.example/alice/profile/card#me', podUrl: 'https://local.example/alice/' }
      : { entries: [{ webId: 'https://local.example/alice/profile/card#me', storageUrl: 'https://local.example/alice/' }] }));
    const json = response.json.bind(response);
    response.json = async () => { const result = await json(); if (current === phase) document.cookie = 'css-account=account-b; Path=/'; return result; };
    return response;
  });
  await expect(createFirstPodAndWaitForBinding({ createPodUrl: control, username: 'alice', fetchImpl,
    pickWebIdUrl: `${window.location.origin}/pick`, maxAttempts: 1 })).rejects.toThrow(/账号/);
  if (phase === 'inventory') expect(prepareProvisionedPod).not.toHaveBeenCalled();
});

it.each(['logout-start', 'account-a-b-a'])('rejects revoked account capability with unchanged cookie: %s', async () => {
  document.cookie = 'css-account=account-a; Path=/';
  let revoked = false;
  const fetchImpl = fixture({ pods: {} }, 200, () => { revoked = true; });
  const assertCurrentAccount = () => { if (revoked) throw new Error('revoked capability'); };
  await expect(createFirstPodAndWaitForBinding({ createPodUrl: control, username: 'alice', fetchImpl,
    assertCurrentAccount })).rejects.toThrow('账号已切换');
  expect(prepareProvisionedPod).not.toHaveBeenCalled();
  expect(fetchImpl.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it.each([createFirstPodAndWaitForBinding, createFirstPodAndWaitForWebIds])('immediately rejects revoked polling without scheduling another attempt', async create => {
  vi.useFakeTimers();
  try {
    let revoked = false;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('/pick')) { revoked = true; return new Response('{}'); }
      return new Response(JSON.stringify(init?.method === 'POST' ? {} : { pods: {} }));
    });
    let rejection: unknown;
    const operation = create({ createPodUrl: control, username: 'alice', fetchImpl,
      pickWebIdUrl: `${window.location.origin}/pick`,
      assertCurrentAccount: () => { if (revoked) throw new Error('revoked'); },
    }).catch(error => { rejection = error; });
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain('账号已切换');
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes('/pick'))).toHaveLength(1);
    await operation;
  } finally { vi.clearAllTimers(); vi.useRealTimers(); }
});
