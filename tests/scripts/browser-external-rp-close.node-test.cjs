const assert = require('node:assert/strict');
const { once } = require('node:events');
const net = require('node:net');
const { test } = require('node:test');

async function withRegistration(register, run) {
  const originalFetch = globalThis.fetch;
  let callback;
  globalThis.fetch = async (_input, init) => {
    if (!init) return Response.json({ issuer: 'https://id.example/',
      authorization_endpoint: 'https://id.example/authorize', token_endpoint: 'https://id.example/token',
      registration_endpoint: 'https://id.example/register' });
    callback = new URL(JSON.parse(init.body).redirect_uris[0]);
    return register();
  };
  try {
    const { startBrowserExternalRp } = await import('../helpers/browserExternalRp.ts');
    await run(() => startBrowserExternalRp('https://id.example/'), () => callback);
  } finally { globalThis.fetch = originalFetch; }
}

async function assertPortReleased(callback) {
  const probe = net.createServer();
  try {
    probe.listen(Number(callback.port), '127.0.0.1');
    await once(probe, 'listening');
  } finally { await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve())); }
}

test('RP close closes a real keep-alive peer and releases the port once', { timeout: 10_000 }, async () => {
  await withRegistration(() => Response.json({ client_id: 'fixture-client' }, { status: 201 }), async start => {
    const rp = await start();
    const callback = new URL(rp.callbackUrl);
    const peer = net.connect(Number(callback.port), '127.0.0.1');
    const disconnected = once(peer, 'close');
    try {
      await once(peer, 'connect');
      const response = once(peer, 'data');
      peer.write('GET /auth/callback HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n');
      assert.match((await response)[0].toString(), /HTTP\/1\.1 200/);
      await Promise.all([rp.close(), rp.close()]);
      await disconnected;
      assert.equal(peer.destroyed, true);
      await rp.close();
      await assertPortReleased(callback);
    } finally { peer.destroy(); await rp.close(); }
  });
});

test('RP startup cleanup preserves the registration transport error and releases its port', { timeout: 10_000 }, async () => {
  const primary = new Error('fixture registration transport failure');
  await withRegistration(() => { throw primary; }, async (start, callback) => {
    await assert.rejects(start(), error => error === primary);
    await assertPortReleased(callback());
  });
});

test('RP startup cleanup preserves the registration HTTP failure and releases its port', { timeout: 10_000 }, async () => {
  await withRegistration(() => new Response(null, { status: 503 }), async (start, callback) => {
    await assert.rejects(start(), /^Error: External RP registration failed: 503$/);
    await assertPortReleased(callback());
  });
});
