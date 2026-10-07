import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ErrorHandler, ResponseWriter, HttpHandlerInput, HttpError } from '@solid/community-server';
import { LocalPodDeletionHttpHandler } from '../../src/http/LocalPodDeletionHttpHandler';
import type { PodDeletionLifecycleService } from '../../src/service/PodDeletionLifecycleService';
import { upsertLocalProvisionState } from '../../src/provision/LocalProvisionState';
import { createServiceAccessToken } from '../../src/provision/ServiceAccessTokenCodec';

mkdirSync('.test-data/local-pod-deletion-handler', { recursive: true });
const rootDir = mkdtempSync(path.resolve('.test-data/local-pod-deletion-handler/run-'));
const operationId = '7f71524a-64b0-4c57-a244-c1b76c3b46e0';
const grant = 'a'.repeat(43);
const storageUrl = 'https://node.test/alice/';
const ownerWebIds = ['https://node.test/alice/profile/card#me'];
const remotePodId = '86feef06-afef-434b-a859-e6c737c7fd50';
const expectedTarget = { podId: remotePodId, ownerWebIds };
const deleteLocal = vi.fn(async (_storageUrl: string, _operationId?: string, _expected?: typeof expectedTarget) => undefined);
let handler: LocalPodDeletionHttpHandler;
const errorHandler = { handleSafe: vi.fn(async ({ error }: { error: HttpError }) => ({ statusCode: error.statusCode, error: error.message })) };
const responseWriter = { handleSafe: vi.fn(async ({ response, result }: { response: HttpHandlerInput['response']; result: { statusCode: number; error: string } }) => {
  response.statusCode = result.statusCode;
  response.end(JSON.stringify({ error: result.error }));
}) };
function input(authorization: string, extra: Record<string, string> = {}, url = '/provision/pods/alice', method = 'DELETE'): HttpHandlerInput {
  return { request: { method, url, headers: { authorization, ...extra } }, response: { setHeader: vi.fn(), end: vi.fn() } } as unknown as HttpHandlerInput;
}
function command(overrides: Record<string, unknown> = {}): unknown {
  return { operation: { operationId, nodeId: 'node-1', accountId: 'cloud-account', podId: 'cloud-pod', storageUrl,
    action: 'delete-pod', state: 'claimed', ownerWebIds, remotePodId, ...overrides } };
}
async function expectStatus(request: HttpHandlerInput, status: number): Promise<void> {
  await handler.handleSafe(request);
  expect(request.response.statusCode).toBe(status);
}
describe('Local Pod deletion authorization and acknowledgment', () => {
  beforeEach(() => {
    deleteLocal.mockClear();
    errorHandler.handleSafe.mockClear(); responseWriter.handleSafe.mockClear();
    vi.stubEnv('XPOD_LOCAL_SETUP_PATH', path.join(rootDir, 'setup.json'));
    vi.stubEnv('XPOD_PROVIDER_ID', 'local'); vi.stubEnv('XPOD_SERVICE_TOKEN', '');
    upsertLocalProvisionState(path.join(rootDir, 'setup.json'), 'local', {
      nodeId: 'node-1', nodeToken: 'node-secret', serviceToken: 'root-service-secret', provisionCode: 'unused',
      publicUrl: 'https://node.test/', cloudUrl: 'https://api.cloud.test/',
    });
    handler = new LocalPodDeletionHttpHandler({ lifecycle: { deleteLocal } as unknown as PodDeletionLifecycleService,
      storageBaseUrl: 'https://node.test/', rootFilePath: rootDir,
      errorHandler: errorHandler as unknown as ErrorHandler, responseWriter: responseWriter as unknown as ResponseWriter });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  afterAll(() => { rmSync(rootDir, { recursive: true, force: true }); });
  it('accepts the local root service token and uses canonical storage, ignoring request host', async () => {
    const request = input('Bearer root-service-secret', { host: 'evil.test' });
    await handler.handleSafe(request);
    expect(deleteLocal).toHaveBeenCalledWith(storageUrl);
    expect(request.response.statusCode).toBe(200);
  });
  it('rejects a provision access token with network read/connect scopes', async () => {
    const token = createServiceAccessToken({ serviceToken: 'root-service-secret', scopes: ['network:read', 'network:connect'], ttlSeconds: 60 });
    await expectStatus(input(`Bearer ${token}`), 401);
    expect(deleteLocal).not.toHaveBeenCalled();
  });
  it('keeps this runtime configuration after global environment restoration, while reading fresh registration', async () => {
    vi.stubEnv('XPOD_LOCAL_SETUP_PATH', path.join(rootDir, 'other-runtime.json'));
    vi.stubEnv('XPOD_PROVIDER_ID', 'other-runtime');
    vi.stubEnv('XPOD_SERVICE_TOKEN', 'other-runtime-token');
    upsertLocalProvisionState(path.join(rootDir, 'setup.json'), 'local', {
      nodeId: 'node-1', nodeToken: 'rotated-node-secret', serviceToken: 'rotated-root-token', provisionCode: 'unused',
      publicUrl: 'https://node.test/', cloudUrl: 'https://api.cloud.test/',
    });
    await handler.handleSafe(input('Bearer rotated-root-token'));
    expect(deleteLocal).toHaveBeenCalledWith(storageUrl);
  });
  it.each(['Bearer wrong', '', `XpodPodDelete ${grant}`])('rejects missing or unverified command credentials: %s', async (authorization) => {
    await expectStatus(input(authorization), 401);
    expect(deleteLocal).not.toHaveBeenCalled();
  });
  it.each(['/provision/pods/../alice', '/provision/pods/%2e%2e', '/provision/pods/alice/file', '/provision/pods/%2falice', '/provision/pods/'])('never claims another destructive target: %s', async (url) => {
    await expect(handler.handleSafe(input('Bearer root-service-secret', {}, url))).rejects.toMatchObject({ statusCode: 501 });
    expect(deleteLocal).not.toHaveBeenCalled();
  });
  it('validates the fixed Cloud claim before deleting, then acknowledges after durable completion', async () => {
    const events: string[] = [];
    deleteLocal.mockImplementationOnce(async () => { events.push('delete'); });
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toMatch(/^https:\/\/api\.cloud\.test\/api\/pod-deletions\//);
      expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { authorization: 'XpodNode node-1:node-secret' } });
      expect(JSON.parse(String(init?.body))).toEqual({ grant, storageUrl });
      const claim = String(url).endsWith('/claim'); events.push(claim ? 'claim' : 'complete');
      return Response.json(claim ? command() : { success: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    await handler.handleSafe(input(`XpodPodDelete ${grant}`, { 'x-xpod-pod-deletion-operation': operationId, 'x-cloud-api-url': 'https://evil.test/' }));
    expect(events).toEqual(['claim', 'delete', 'complete']);
    expect(deleteLocal).toHaveBeenCalledWith(storageUrl, operationId, expectedTarget);
  });
  it.each([{ storageUrl: 'https://node.test/bob/' }, { nodeId: 'other-node' }, { action: 'create-pod' }, { operationId: 'other-op' }, { state: 'pending' }, { ownerWebIds: [] }, { ownerWebIds: [42] }, { remotePodId: '' }])('rejects a mismatching claim: %j', async (overrides) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(command(overrides))));
    await expectStatus(input(`XpodPodDelete ${grant}`, { 'x-xpod-pod-deletion-operation': operationId }), 403);
    expect(deleteLocal).not.toHaveBeenCalled();
  });
  it('does not acknowledge a failed deletion', async () => {
    const fetchMock = vi.fn(async () => Response.json(command())); vi.stubGlobal('fetch', fetchMock);
    deleteLocal.mockRejectedValueOnce(new Error('index unavailable'));
    const request = input(`XpodPodDelete ${grant}`, { 'x-xpod-pod-deletion-operation': operationId });
    await expectStatus(request, 500);
    expect(errorHandler.handleSafe).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ message: 'POD_DELETE_NODE_FAILED' }) }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('reports acknowledgment loss as failure and retries the same durable operation', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(command())).mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(Response.json(command())).mockResolvedValueOnce(Response.json({ success: true }));
    vi.stubGlobal('fetch', fetchMock);
    const request = () => input(`XpodPodDelete ${grant}`, { 'x-xpod-pod-deletion-operation': operationId });
    await expectStatus(request(), 502);
    await handler.handleSafe(request());
    expect(deleteLocal.mock.calls).toEqual([[storageUrl, operationId, expectedTarget], [storageUrl, operationId, expectedTarget]]);
  });
  it('never deletes a new Pod at the same address when Cloud already completed the operation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(command({ state: 'completed' })))
      .mockResolvedValueOnce(Response.json({ success: true })));
    await handler.handleSafe(input(`XpodPodDelete ${grant}`, { 'x-xpod-pod-deletion-operation': operationId }));
    expect(deleteLocal).not.toHaveBeenCalled();
  });
});
