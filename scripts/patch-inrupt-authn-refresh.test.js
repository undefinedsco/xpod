const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const {
  patchBundle,
  patchSource,
} = require('./patch-inrupt-authn-refresh.js');

const coreRoot = path.join(
  __dirname,
  '..',
  'node_modules',
  '@inrupt',
  'solid-client-authn-core',
);

test('patches source refresh failures with bounded retry and terminal expiry', () => {
  const source = fs.readFileSync(
    path.join(coreRoot, 'src/authenticatedFetch/fetchFactory.ts'),
    'utf8',
  );
  const patched = patchSource(source);

  assert.match(patched, /XPOD_REFRESH_RETRY_MAX_DELAY_MS = 60_000/);
  assert.match(patched, /setTimeout\(proactivelyRefreshToken, retryDelay\)/);
  assert.match(patched, /e\.error !== "temporarily_unavailable"/);
  assert.match(patched, /emit\(EVENTS\.SESSION_EXPIRED\)/);
  assert.equal(patchSource(patched), patched);
});

test('patches both distributed bundle shapes idempotently', () => {
  for (const filename of ['index.js', 'index.mjs']) {
    const bundle = fs.readFileSync(path.join(coreRoot, 'dist', filename), 'utf8');
    const patched = patchBundle(bundle);
    assert.match(patched, /XPOD_REFRESH_RETRY_MAX_DELAY_MS = 60000/);
    assert.match(patched, /setTimeout\(proactivelyRefreshToken, retryDelay\)/);
    assert.equal(patchBundle(patched), patched);
  }
});

test('retries a transient refresh and replaces the stale access token', async () => {
  const { buildAuthenticatedFetch, EVENTS } = require(
    path.join(coreRoot, 'dist', 'index.js')
  );
  const emitter = new EventEmitter();
  const scheduledTimeouts = [];
  emitter.on(EVENTS.TIMEOUT_SET, (timeout) => scheduledTimeouts.push(timeout));

  let refreshAttempts = 0;
  let authorization;
  const authenticatedFetch = buildAuthenticatedFetch('stale-access-token', {
    expiresIn: 0,
    eventEmitter: emitter,
    fetch: async (_url, init) => {
      authorization = new Headers(init.headers).get('authorization');
      return new Response(null, { status: 200 });
    },
    refreshOptions: {
      refreshToken: 'still-valid-refresh-token',
      sessionId: 'test-session',
      tokenRefresher: {
        async refresh(_sessionId, refreshToken) {
          refreshAttempts += 1;
          assert.equal(refreshToken, 'still-valid-refresh-token');
          if (refreshAttempts === 1) {
            throw new TypeError('temporary network failure');
          }
          return {
            accessToken: 'fresh-access-token',
            expiresIn: 60,
          };
        },
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await authenticatedFetch('http://127.0.0.1/private');

  assert.equal(refreshAttempts, 2);
  assert.equal(authorization, 'Bearer fresh-access-token');
  for (const timeout of scheduledTimeouts) clearTimeout(timeout);
});

function requestRefreshFixture(refresh, expiresIn = 0) {
  const { buildAuthenticatedFetch, EVENTS } = require(path.join(coreRoot, 'dist/index.js'));
  const emitter = new EventEmitter();
  const events = [];
  const requests = [];
  emitter.on(EVENTS.TIMEOUT_SET, (timeout) => clearTimeout(timeout));
  emitter.on(EVENTS.ERROR, (error) => events.push(error));
  emitter.on(EVENTS.SESSION_EXPIRED, () => events.push('expired'));
  return {
    events, requests,
    fetch: buildAuthenticatedFetch('expired-access', {
      expiresIn, eventEmitter: emitter,
      refreshOptions: { refreshToken: 'valid-refresh', sessionId: 'idle', tokenRefresher: { refresh } },
      fetch: async (_url, init) => {
        requests.push({ authorization: new Headers(init.headers).get('authorization'), method: init.method });
        return new Response(null, { status: 200 });
      },
    }),
  };
}

test('first request after real idle refreshes before sending a write', async () => {
  let attempts = 0;
  const fixture = requestRefreshFixture(async () => {
    attempts += 1;
    return { accessToken: 'fresh-access', expiresIn: 60 };
  }, 0.01);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(attempts, 0);
  await fixture.fetch('https://pod.example/private', { method: 'PUT', body: 'once' });
  assert.equal(attempts, 1);
  assert.deepEqual(fixture.requests, [{ authorization: 'Bearer fresh-access', method: 'PUT' }]);
});

test('concurrent first actions share one renewal and reuse its rotated refresh token', async () => {
  let release;
  let attempts = 0;
  const fixture = requestRefreshFixture(async (_session, refreshToken) => {
    attempts += 1;
    assert.equal(refreshToken, attempts === 1 ? 'valid-refresh' : 'rotated-refresh');
    if (attempts === 2) return { accessToken: 'next-access', expiresIn: 60 };
    return await new Promise(resolve => { release = resolve; });
  });
  const pending = [fixture.fetch('https://pod.example/one'), fixture.fetch('https://pod.example/two')];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 1);
  assert.equal(fixture.requests.length, 0);
  release({ accessToken: 'fresh-access', refreshToken: 'rotated-refresh', expiresIn: 0 });
  await Promise.all(pending);
  assert.equal(fixture.requests.length, 2);
  assert.ok(fixture.requests.every(request => request.authorization === 'Bearer fresh-access'));
  await fixture.fetch('https://pod.example/next');
  assert.equal(attempts, 2);
  assert.equal(fixture.requests[2].authorization, 'Bearer next-access');
});

test('a transient first-action refresh error rejects without sending stale authority or expiring the session', async () => {
  let attempts = 0;
  const fixture = requestRefreshFixture(async () => {
    if (++attempts === 1) throw new TypeError('offline');
    return { accessToken: 'fresh-access', expiresIn: 60 };
  });
  await assert.rejects(fixture.fetch('https://pod.example/private'), /offline/);
  assert.deepEqual(fixture.requests, []);
  assert.deepEqual(fixture.events, []);
  await fixture.fetch('https://pod.example/private');
  assert.equal(attempts, 2);
  assert.equal(fixture.requests.length, 1);
});

test('terminal refresh rejection keeps the existing reauthorization signals and sends no resource request', async () => {
  const { OidcProviderError } = require(path.join(coreRoot, 'dist/index.js'));
  let attempts = 0;
  const fixture = requestRefreshFixture(async () => {
    attempts += 1;
    throw new OidcProviderError('Revoked refresh', 'invalid_grant');
  });
  await assert.rejects(fixture.fetch('https://pod.example/private'), /Revoked refresh/);
  await assert.rejects(fixture.fetch('https://pod.example/private'), /Revoked refresh/);
  assert.equal(attempts, 1);
  assert.deepEqual(fixture.requests, []);
  assert.deepEqual(fixture.events, ['invalid_grant', 'expired']);
});

test('an unrelated provider 401 does not trigger refresh or a session-expired signal', async () => {
  const { buildAuthenticatedFetch, EVENTS } = require(path.join(coreRoot, 'dist/index.js'));
  const emitter = new EventEmitter();
  emitter.on(EVENTS.TIMEOUT_SET, clearTimeout);
  let attempts = 0;
  let expired = false;
  emitter.on(EVENTS.SESSION_EXPIRED, () => { expired = true; });
  const authenticatedFetch = buildAuthenticatedFetch('current-access', {
    expiresIn: 60, eventEmitter: emitter,
    refreshOptions: { sessionId: 'current', refreshToken: 'current-refresh', tokenRefresher: { async refresh() { attempts += 1; throw new Error('must not refresh'); } } },
    fetch: async () => new Response(null, { status: 401 }),
  });
  assert.equal((await authenticatedFetch('https://provider.example/connection')).status, 401);
  assert.equal(attempts, 0);
  assert.equal(expired, false);
});


test('rejects a partial request-renewal patch instead of accepting its old retry marker', () => {
  const source = fs.readFileSync(path.join(coreRoot, 'src/authenticatedFetch/fetchFactory.ts'), 'utf8');
  assert.throws(() => patchSource(source.replace('let refreshTerminated = false;', '')), /Incomplete XPOD_REFRESH_ON_REQUEST/);
  for (const filename of ['index.js', 'index.mjs']) {
    const bundle = fs.readFileSync(path.join(coreRoot, 'dist', filename), 'utf8');
    assert.throws(() => patchBundle(bundle.replace('await refreshBeforeRequest();', '')), /Incomplete XPOD_REFRESH_ON_REQUEST/);
  }
});
