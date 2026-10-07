import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerPodManagementRoutes } from '../../../src/api/handlers/PodManagementHandler';
import type { ApiServer } from '../../../src/api/ApiServer';

vi.mock('../../../src/provision/LocalProvisionState', () => ({
  resolveLocalSetupPath: () => '/disposable-state', resolveLocalSetupProviderId: () => 'local',
  readLocalProvisionState: () => ({ nodeId: 'node', nodeToken: 'node-secret', cloudApiUrl: 'https://fixed-cloud.test/' }),
}));
const challenge = `aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.${'c'.repeat(43)}`;
const details = { challengeId: challenge.split('.')[0], accountId: 'cloud-owner', podId: 'cloud-pod', nodeId: 'node', storageUrl: 'http://localhost:5737/p/', expiresAt: Date.now() + 300_000, returnUrl: 'https://fixed-cloud.test/.account/account/' };
function fixture() {
  let handler!: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  const fetcher = vi.fn(async (_url: URL | string, init?: RequestInit) => new Response(JSON.stringify(init?.method === 'POST' ? { success: true } : { authorization: details }), { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  const server = { post: (url: string, callback: typeof handler) => { if (url === '/provision/pods') { handler = callback; } }, get: vi.fn(), delete: vi.fn() };
  registerPodManagementRoutes(server as unknown as ApiServer, {
    rootDir: '/not-written', verifyServiceToken: async (token) => token === 'sat', storageProviderBaseUrl: 'http://localhost:5737/',
    podLookupRepository: { findByWebIds: async () => [], findByResourceIdentifier: async () => ({ podId: 'local-current', accountId: 'local-account', baseUrl: details.storageUrl, webId: `${details.storageUrl}profile/card#me` }) },
  });
  async function call(body: object, headers: Record<string, string> = {}) {
    const req = Readable.from([JSON.stringify(body)]) as IncomingMessage;
    req.headers = { host: 'localhost:5737', origin: 'http://localhost:5737', ...headers };
    Object.defineProperty(req, 'socket', { value: { remoteAddress: '127.0.0.1' } });
    const res = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
    await handler(req, res as unknown as ServerResponse);
    return { status: res.statusCode, body: JSON.parse(res.end.mock.calls[0][0]) };
  }
  return { call, fetcher };
}
afterEach(() => { vi.unstubAllGlobals(); });
describe('explicit Local deletion authorization', () => {
  it('preflights against the fixed registered Cloud and never consumes or trusts browser callback/target facts', async () => {
    const f = fixture();
    const result = await f.call({ action: 'inspectDeletionAuthorization', challenge, podName: 'p', callbackUrl: 'https://attacker.test/', accountId: 'attacker' });
    expect(result.status).toBe(200);
    expect(result.body.deletionAuthorization).toMatchObject({ cloudAccountId: 'cloud-owner', currentLocalPodId: 'local-current', storageUrl: details.storageUrl });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(String(f.fetcher.mock.calls[0][0])).toContain('https://fixed-cloud.test/api/pod-deletions/');
    expect(f.fetcher.mock.calls[0][1]?.method).toBe('GET');
  });
  it('requires an explicit current-generation confirmation and sends the actual Local facts', async () => {
    const f = fixture();
    expect((await f.call({ action: 'authorizeDeletion', challenge, podName: 'p', expectedLocalPodId: 'old' })).status).toBe(409);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect((await f.call({ action: 'authorizeDeletion', challenge, podName: 'p', expectedLocalPodId: 'local-current' })).status).toBe(200);
    expect(JSON.parse(f.fetcher.mock.calls[2][1]!.body as string)).toMatchObject({ remotePodId: 'local-current', storageUrl: details.storageUrl });
  });
  it.each(['https://attacker.test', 'null', 'https://localhost:5737'])('rejects foreign or opaque Origin %s', async (origin) => {
    const f = fixture();
    expect((await f.call({ action: 'inspectDeletionAuthorization', challenge, podName: 'p' }, { origin })).body.error).toBe('POD_DELETE_ORIGIN_REQUIRED');
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('bounds the operator request before parsing authorization facts', async () => {
    const f = fixture();
    expect((await f.call({ action: 'inspectDeletionAuthorization', padding: 'x'.repeat(1_048_577) })).status).toBe(413);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('does not upgrade a valid service-access token through the loopback operator path', async () => {
    const f = fixture();
    expect((await f.call({ action: 'inspectDeletionAuthorization', challenge, podName: 'p' }, { authorization: 'Bearer sat' })).status).toBe(403);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
