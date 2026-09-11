import { createServer, request, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoopbackAuthorizationCallbackReceiver } from '../../../src/api/ai-gateway/connect/LoopbackAuthorizationCallbackReceiver';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async() => { for (const cleanup of cleanups.splice(0).reverse()) { await cleanup(); } });
async function listen(): Promise<{ server: Server; port: number }> {
  const server = createServer((_request, response) => response.end('third party'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as { port: number }).port };
}
async function close(server: Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()));
}
async function freePort(): Promise<number> {
  const holder = await listen();
  await close(holder.server);
  return holder.port;
}
function get(port: number, path: string, host = `localhost:${port}`, method = 'GET'): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host }, agent: false }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, body, headers: response.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}
async function register(receiver: LoopbackAuthorizationCallbackReceiver, port: number, state = 'random-state', expiresAt = new Date(Date.now() + 60_000)) {
  const onCallback = vi.fn();
  const registration = await receiver.register({ redirectUris: [`http://localhost:${port}/auth/callback`], state, expiresAt, onCallback });
  cleanups.push(registration.close);
  return { ...registration, onCallback };
}

describe('LoopbackAuthorizationCallbackReceiver', () => {
  it('shares listeners, consumes each state once, and never exposes callback secrets', async() => {
    const receiver = new LoopbackAuthorizationCallbackReceiver();
    const port = await freePort();
    const [first, second] = await Promise.all([register(receiver, port, 'first'), register(receiver, port, 'second')]);
    expect(first.redirectUri).toBe(`http://localhost:${port}/auth/callback`);
    expect((await get(port, '/auth/callback?state=wrong&code=secret')).status).toBe(400);
    const response = await get(port, '/auth/callback?state=first&code=secret');
    expect(response.status).toBe(200);
    expect(response.body).toBe('授权已返回 Xpod，请切回应用完成连接。');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.connection).toBe('close');
    expect(first.onCallback).toHaveBeenCalledTimes(1);
    expect(first.onCallback).toHaveBeenCalledWith({ code: 'secret' });
    expect((await get(port, '/auth/callback?state=first&code=replay')).status).toBe(400);
    expect(second.onCallback).not.toHaveBeenCalled();
    const failure = await get(port, '/auth/callback?state=second&error=secret-error&error_description=secret-description');
    expect(failure.body).not.toContain('secret');
    expect(second.onCallback).toHaveBeenCalledTimes(1);
    expect(second.onCallback).toHaveBeenCalledWith({ error: 'secret-error' });
  });

  it('rejects confused host, path, method, and ambiguous parameters without consuming the state', async() => {
    const receiver = new LoopbackAuthorizationCallbackReceiver();
    const port = await freePort();
    const registered = await register(receiver, port);
    for (const path of [
      '/other?state=random-state&code=secret',
      '/other/../auth/callback?state=random-state&code=secret',
      '/auth/callback?state=random-state&state=random-state&code=secret',
      '/auth/callback?state=random-state&code=a&code=b',
      '/auth/callback?state=random-state&error=a&error=b',
      '/auth/callback?state=random-state',
      '/auth/callback?state=random-state&code=secret&error=bad',
      '/auth/callback?state=random-state&code=secret&error=',
    ]) { expect((await get(port, path)).status).toBe(400); }
    expect((await get(port, '/auth/callback?state=random-state&code=secret', 'attacker.example')).status).toBe(400);
    expect((await get(port, '/auth/callback?state=random-state&code=secret', `localhost:${port}`, 'POST')).status).toBe(400);
    expect(registered.onCallback).not.toHaveBeenCalled();
    expect((await get(port, '/auth/callback?state=random-state&code=secret', `127.0.0.1:${port}`)).status).toBe(200);
    expect(registered.onCallback).toHaveBeenCalledTimes(1);
  });

  it('releases ports on cancellation and expiry', async() => {
    const receiver = new LoopbackAuthorizationCallbackReceiver();
    const port = await freePort();
    const first = await register(receiver, port);
    first.close();
    first.close();
    await new Promise(resolve => setTimeout(resolve, 10));
    const second = await register(receiver, port, 'expiring', new Date(Date.now() + 30));
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(second.onCallback).not.toHaveBeenCalled();
    const holder = createServer();
    await new Promise<void>((resolve, reject) => { holder.once('error', reject); holder.listen(port, '127.0.0.1', resolve); });
    cleanups.push(() => close(holder));
  });

  it('uses the registered fallback without disturbing another application', async() => {
    const holder = await listen();
    cleanups.push(() => close(holder.server));
    const fallback = await freePort();
    const receiver = new LoopbackAuthorizationCallbackReceiver();
    const result = await receiver.register({ redirectUris: [`http://localhost:${holder.port}/auth/callback`, `http://localhost:${fallback}/auth/callback`], state: 'fallback', expiresAt: new Date(Date.now() + 60_000), onCallback: vi.fn() });
    cleanups.push(result.close);
    expect(result.redirectUri).toBe(`http://localhost:${fallback}/auth/callback`);
    expect((await get(holder.port, '/')).body).toBe('third party');
  });

  it('reports unavailable ports safely and refuses non-loopback URIs', async() => {
    const first = await listen(); const second = await listen();
    cleanups.push(() => close(first.server), () => close(second.server));
    const receiver = new LoopbackAuthorizationCallbackReceiver();
    const input = { state: 'state', expiresAt: new Date(Date.now() + 60_000), onCallback: vi.fn() };
    await expect(receiver.register({ ...input, redirectUris: [`http://localhost:${first.port}/callback`, `http://localhost:${second.port}/callback`] })).rejects.toThrow('ports are unavailable');
    for (const uri of ['https://localhost:1455/callback', 'http://example.com:1455/callback', 'http://user:secret@localhost:1455/callback', 'http://localhost:1455/callback?secret=value']) {
      await expect(receiver.register({ ...input, redirectUris: [uri] })).rejects.toThrow('Invalid loopback');
    }
    expect((await get(first.port, '/')).body).toBe('third party');
    expect((await get(second.port, '/')).body).toBe('third party');
  });
});
