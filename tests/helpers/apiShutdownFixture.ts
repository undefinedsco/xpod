import { spawn } from 'node:child_process';
import { DeviceNotificationWebSocketServer } from '../../src/http/DeviceNotificationWebSocketServer';
import { DeviceNotificationHub } from '../../src/notifications/DeviceNotificationHub';
import { DeviceNotificationTicketStore } from '../../src/api/handlers/DeviceNotificationTicketHandler';
import { registerDeviceNotificationRuntime } from '../../src/api/handlers/DeviceNotificationRuntime';
import assert from 'node:assert/strict';
import { WebSocket, WebSocketServer } from 'ws';
import { ApiServer } from '../../src/api/ApiServer';
import { AuthMiddleware } from '../../src/api/middleware/AuthMiddleware';
import { GatewayProxy } from '../../src/runtime/Proxy';
import { getFreePort } from '../../src/runtime/port-finder';
import { Supervisor } from '../../src/supervisor/Supervisor';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function createApi(): ApiServer {
  return new ApiServer({ port: 0, host: '127.0.0.1', authMiddleware: new AuthMiddleware({
    authenticator: { canAuthenticate: () => false, authenticate: async () => ({ success: false, error: 'unused' }) },
  }) });
}
function origin(api: ApiServer): string {
  const address = api.address();
  assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
export async function verifyUpgradeShutdown(): Promise<void> {
  const api = createApi();
  const wss = new WebSocketServer({ noServer: true });
  const transports = new Set<import('node:stream').Duplex>();
  api.addUpgradeHandler((request, socket, head) => { transports.add(socket); socket.once('close', () => transports.delete(socket)); wss.handleUpgrade(request, socket, head, () => {}); });
  api.addShutdownHandler(() => new Promise<void>((resolve, reject) => {
    wss.close((error) => { error ? reject(error) : resolve(); });
    for (const socket of transports) { socket.destroy(); }
  }));
  await api.start();
  let closed = false;
  api.getHttpServer()!.once('close', () => { closed = true; });
  const port = await getFreePort(29701, '127.0.0.1');
  const gateway = new GatewayProxy(port, new Supervisor({ handleProcessSignals: false }), '127.0.0.1');
  gateway.setTargets({ api: origin(api) }); await gateway.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/notifications/ws`);
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const socketClosed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  socket.close(); await socketClosed;
  // No artificial settling delay: this exposed Bun's lost close callback.
  await api.stop();
  assert(closed, 'API shutdown must observe a real HTTP server close event');
  await gateway.stop();
}
export async function verifyInFlightShutdown(disconnect: boolean): Promise<void> {
  const api = createApi(); const entered = deferred(); const release = deferred();
  let written = false; let stopFinished = false;
  api.post('/api/write', async (_request, response) => {
    entered.resolve(); await release.promise;
    written = true; response.end('committed');
  }, { public: true });
  api.get('/api/new', async (_request, response) => { response.end('unexpected new work'); }, { public: true });
  await api.start(); const base = origin(api); const controller = new AbortController();
  const request = fetch(`${base}/api/write`, { method: 'POST', signal: controller.signal })
    .then(async (response) => response.text()).catch((error: Error) => error.name);
  await entered.promise;
  if (disconnect) { controller.abort(); await request; }
  const stopping = api.stop().then(() => { stopFinished = true; });
  try {
    const denied = await fetch(`${base}/api/new`);
    assert.equal(denied.status, 503); await denied.text();
    assert.equal(written, false); assert.equal(stopFinished, false);
    release.resolve(); await stopping;
    assert(written); assert(stopFinished);
    if (!disconnect) { assert.equal(await request, 'committed'); }
    else { await request; }
  } finally { release.resolve(); await stopping; }
}

export async function verifyWebSocketLogicalDrain(): Promise<void> {
  const entered = deferred(); const release = deferred(); let completed = false; let stopped = false;
  const api = new ApiServer({ port: 0, host: '127.0.0.1', authMiddleware: {
    process: async (request: any) => { request.auth = { type: 'solid', webId: 'https://owned.example/alice#me' }; return true; },
  } as any });
  registerDeviceNotificationRuntime(api, { origin: 'https://owned.example', authorizeTopic: async () => {
    entered.resolve(); await release.promise; completed = true; return true;
  } });
  await api.start(); const base = origin(api);
  const ticketResponse = await fetch(`${base}/v1/notifications/tickets`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocol: 'xpod.notifications.v1', sessionId: 'fixture', origin: 'https://owned.example' }),
  });
  assert.equal(ticketResponse.status, 201);
  const ticket = await ticketResponse.json() as { ticket: string };
  const socket = new WebSocket(`${base.replace('http:', 'ws:')}/v1/notifications/ws`, ['xpod.notifications.v1', ticket.ticket]);
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify({ type: 'register', requestId: 'held', topics: ['https://owned.example/alice/'] }));
  await entered.promise;
  const clientClosed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  const stopping = api.stop().then(() => { stopped = true; });
  try {
    await clientClosed;
    assert.equal(completed, false); assert.equal(stopped, false);
    release.resolve(); await stopping; assert(completed);
  } finally { release.resolve(); await stopping; }
}

export async function verifyServerInitiatedWebSocketClose(mode: 'replacement' | 'heartbeat'): Promise<void> {
  const api = createApi();
  const ticketStore = new DeviceNotificationTicketStore();
  const notification = new DeviceNotificationWebSocketServer({
    hub: new DeviceNotificationHub({ origin: 'https://owned.example' }), ticketStore,
    heartbeatIntervalMs: mode === 'heartbeat' ? 100 : 30_000,
  });
  api.addUpgradeHandler((request, socket, head) => notification.handleUpgrade(request, socket, head));
  api.addShutdownHandler(() => notification.stop());
  await api.start(); let httpClosed = false;
  api.getHttpServer()!.once('close', () => { httpClosed = true; });
  const connect = async (): Promise<WebSocket> => {
    const ticket = ticketStore.mint({ identity: { webId: 'https://owned.example/alice#me', localPart: 'alice' }, deviceSessionId: 'same-session', origin: 'https://owned.example', ttlMs: 10_000 });
    const socket = new WebSocket(`${origin(api).replace('http:', 'ws:')}/v1/notifications/ws`, ['xpod.notifications.v1', ticket], { autoPong: mode !== 'heartbeat' });
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    return socket;
  };
  if (mode === 'heartbeat') {
    // Bun's ws client ignores autoPong=false. A real Node peer deliberately
    // withholds pong so this exercises the server heartbeat, not a mocked flag.
    const ticket = ticketStore.mint({ identity: { webId: 'https://owned.example/alice#me', localPart: 'alice' }, deviceSessionId: 'silent-session', origin: 'https://owned.example', ttlMs: 60_000 });
    const peer = spawn('node', ['-e', `const { WebSocket } = require('ws');
      const socket = new WebSocket(process.argv[1], ['xpod.notifications.v1', process.argv[2]], { autoPong: false });
      socket.once('error', error => { console.error(error); process.exit(1); });
      socket.once('close', (code, reason) => console.log(JSON.stringify({ code, reason: reason.toString() })));`,
      `${origin(api).replace('http:', 'ws:')}/v1/notifications/ws`, ticket], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    peer.stdout.on('data', (data) => { stdout += String(data); });
    peer.stderr.on('data', (data) => { stderr += String(data); });
    await new Promise<void>((resolve, reject) => {
      peer.once('error', reject); peer.once('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr)));
    });
    assert.deepEqual(JSON.parse(stdout.trim()), { code: process.versions.bun ? 1000 : 1005, reason: '' });
    await api.stop(); assert(httpClosed, 'heartbeat close must not strand HTTP shutdown');
    return;
  }
  const first = await connect();
  const closed = new Promise<{ code: number; reason: string }>((resolve) => first.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  if (mode === 'replacement') { await connect(); }
  const close = await closed;
  assert.deepEqual(close, mode === 'replacement' ? { code: 4000, reason: 'Replaced by newer device connection' } : { code: 1005, reason: '' });
  await api.stop(); assert(httpClosed, 'server initiated close must not strand HTTP shutdown');
}
