import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { registerAgentWakeRoutes } from '../../../src/api/handlers/AgentWakeHandler';
import type { ApiServer } from '../../../src/api/ApiServer';
import type { AgentWakeRuntimeService } from '../../../src/api/reconciler/AgentWakeRuntimeService';
import { MatrixError } from '../../../src/api/matrix/MatrixError';

function fixture() {
  const routes: Record<string, Function> = {};
  const server = { post: vi.fn((path: string, handler: Function) => { routes[path] = handler; }) } as unknown as ApiServer;
  const service = { claim: vi.fn(async () => ({ job: null })), renew: vi.fn(async () => ({ ok: true })), complete: vi.fn(async () => ({ eventId: '$result', run: 'run' })), fail: vi.fn(async () => ({ ok: true })) };
  const resolveContext = vi.fn(async () => ({ webId: 'https://alice/#me' }));
  registerAgentWakeRoutes(server, { service: service as unknown as AgentWakeRuntimeService, resolveContext });
  const invoke = async (operation: string, body: unknown, raw = false) => {
    const request = new PassThrough();
    request.end(raw ? body : JSON.stringify(body));
    const response = { writeHead: vi.fn(), end: vi.fn() };
    await routes[`/v1/agent-wakes/${operation}`](request, response);
    return { status: response.writeHead.mock.calls[0][0], body: JSON.parse(response.end.mock.calls[0][0]) };
  };
  return { server, service, resolveContext, invoke, routes };
}
const request = { roomId: '!room', agent: 'https://pod/agent', runtimeId: 'worker' };

describe('AgentWakeHandler', () => {
  it('registers four authenticated routes and passes resolved context', async () => {
    const f = fixture();
    expect(f.server.post).toHaveBeenCalledTimes(4);
    expect(await f.invoke('claim', request)).toEqual({ status: 200, body: { job: null } });
    expect(f.service.claim).toHaveBeenCalledWith(request, { webId: 'https://alice/#me' });
    for (const call of vi.mocked(f.server.post).mock.calls) { expect(call[2]).toBeUndefined(); }
  });
  it.each([null, [], { ...request, runtimeId: 1 }, { ...request, leaseMs: 0 }, { ...request, evidence: [1] }])('rejects malformed body %j', async body => {
    const f = fixture();
    expect((await f.invoke('claim', body)).status).toBe(400);
    expect(f.service.claim).not.toHaveBeenCalled();
  });
  it('bounds body bytes and validates completion fields', async () => {
    const f = fixture();
    expect((await f.invoke('claim', 'x'.repeat(65_537), true)).status).toBe(413);
    expect((await f.invoke('complete', { ...request, id: 'wake', fencingToken: '1' })).status).toBe(400);
    expect((await f.invoke('complete', { ...request, id: 'wake', fencingToken: '1', body: 'done', evidence: ['https://pod/result'] })).status).toBe(200);
  });
  it('preserves authorization errors and hides internal errors', async () => {
    const f = fixture();
    f.resolveContext.mockRejectedValueOnce(new MatrixError(403, 'M_FORBIDDEN', 'denied'));
    expect((await f.invoke('claim', request)).status).toBe(403);
    f.service.claim.mockRejectedValueOnce(new Error('secret backend detail'));
    expect(await f.invoke('claim', request)).toEqual({ status: 500, body: { errcode: 'M_UNKNOWN', error: 'Agent runtime request failed' } });
  });
  it('returns 413 without destroying an unfinished oversized request stream', async () => {
    const f = fixture();
    const stream = new PassThrough();
    const response = { writeHead: vi.fn(), end: vi.fn() };
    const handling = f.routes['/v1/agent-wakes/claim'](stream, response);
    stream.write('x'.repeat(65_537));
    await handling;
    expect(response.writeHead).toHaveBeenCalledWith(413, expect.any(Object));
    expect(stream.destroyed).toBe(false);
    expect(f.service.claim).not.toHaveBeenCalled();
    stream.end();
  });
});
