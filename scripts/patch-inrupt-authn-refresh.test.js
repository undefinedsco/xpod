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
