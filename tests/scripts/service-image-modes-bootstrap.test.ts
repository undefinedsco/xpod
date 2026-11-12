import {test, expect} from 'bun:test';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {
  assertManagedLocalRegistration,
  exportSessionSafeEvidence,
  awaitReadiness,
  isRetryableReadinessError,
  ManagedLocalBootstrapError,
  runOrderedManagedLocalBootstrap,
} from '../../scripts/accept-service-image-modes';

const facts0 = {registered: false, publicUrl: false, provisionCode: false};

test('HTTP 200 with registered false hard-fails on the first observation', async () => {
  const error = new ManagedLocalBootstrapError({phase: 'local-registration', reason: 'incomplete-state', httpStatus: 200, required: facts0});
  let call = 0;
  await expect(awaitReadiness({
    phase: 'local-registration', emptyFacts: facts0, deadline: 10_000, budgetMs: 600_000,
    isCancelled: () => false, now: () => 0, isRetryable: isRetryableReadinessError,
    observe: async () => { call += 1; if (call === 1) throw error; return {registered: true}; },
  })).rejects.toThrow(/incomplete-state/);
  expect(call).toBe(1);
});

test('missing or invalid local state hard-fails without consuming the budget', async () => {
  for (const failure of [
    {phase: 'local-registration' as const, reason: 'incomplete-state' as const, httpStatus: 200, required: {...facts0}},
    {phase: 'local-registration' as const, reason: 'incomplete-state' as const, httpStatus: 200, required: {registered: true, publicUrl: true, provisionCode: false}},
  ]) {
    let observed = 0;
    await expect(awaitReadiness({
      phase: 'local-registration', emptyFacts: facts0, deadline: 10_000, budgetMs: 600_000,
      isCancelled: () => false, now: () => 0, isRetryable: isRetryableReadinessError,
      observe: async () => { observed += 1; throw new ManagedLocalBootstrapError(failure); },
    })).rejects.toThrow();
    expect(observed).toBe(1);
  }
});

test('transient unreachable then ready succeeds and leaves no stale facts', async () => {
  const attempts: Array<() => any> = [
    () => { const e: any = new Error('connect ECONNREFUSED'); return e; },
    () => { const e: any = new Error('startup'); e.readinessStatus = 503; return e; },
    () => ({edition: 'cloud'}),
  ];
  let calls = 0;
  const result = await awaitReadiness({
    phase: 'cloud-api-readiness', emptyFacts: facts0, deadline: 1_000_000, budgetMs: 600_000,
    isCancelled: () => false, now: () => 0, isRetryable: isRetryableReadinessError,
    observe: async () => {
      const next = attempts[Math.min(calls, attempts.length - 1)]!;
      calls += 1;
      const value = next();
      if (value instanceof Error) throw value;
      return value;
    },
  });
  expect(result).toEqual({edition: 'cloud'});
  expect(calls).toBe(3);
});

test('a hard 4xx is not readiness and fails fast', async () => {
  let calls = 0;
  await expect(awaitReadiness({
    phase: 'cloud-api-readiness', emptyFacts: facts0, deadline: 1_000_000, budgetMs: 600_000,
    isCancelled: () => false, now: () => 0, isRetryable: isRetryableReadinessError,
    observe: async () => {
      calls += 1;
      const error: any = new Error('not found');
      error.readinessStatus = 404;
      error.readinessFacts = {phase: 'cloud-api-readiness', reason: 'http', httpStatus: 404, required: facts0};
      throw error;
    },
  })).rejects.toThrow(/http/);
  expect(calls).toBe(1);
});

test('cancellation stops before local start and deadline bounds the wait', async () => {
  let calls = 0;
  await expect(awaitReadiness({
    phase: 'cloud-api-readiness', emptyFacts: facts0, deadline: 1_000_000, budgetMs: 600_000,
    isCancelled: () => true, now: () => 0, isRetryable: isRetryableReadinessError,
    observe: async () => { calls += 1; },
  })).rejects.toThrow(/cancelled/);
  expect(calls).toBe(0);

  let now = 0;
  await expect(awaitReadiness({
    phase: 'local-registration', emptyFacts: facts0, deadline: 5, budgetMs: 600_000,
    isCancelled: () => false, now: () => now, isRetryable: isRetryableReadinessError,
    observe: async () => { now += 10; const e: any = new Error('slow'); e.readinessStatus = 503; throw e; },
  })).rejects.toThrow(/deadline/);
});

test('ordering: Cloud readiness strictly precedes local start', async () => {
  const order: string[] = [];
  await runOrderedManagedLocalBootstrap({
    startInfrastructureAndCloud: async () => { order.push('cloud'); },
    awaitCloudApiReady: async () => { order.push('ready'); },
    startLocal: async () => { order.push('local'); },
    awaitLocalRegistration: async () => { order.push('registered'); },
  });
  expect(order).toEqual(['cloud', 'ready', 'local', 'registered']);
});

test('cancellation aborts a pending Cloud observation before Local can start', async () => {
  const controller = new AbortController();
  let localStarted = false;
  const pending = runOrderedManagedLocalBootstrap({
    startInfrastructureAndCloud: async () => {},
    awaitCloudApiReady: () => awaitReadiness({
      phase: 'cloud-api-readiness', emptyFacts: facts0,
      deadline: Date.now() + 10_000, budgetMs: 10_000,
      signal: controller.signal, isCancelled: () => controller.signal.aborted,
      now: Date.now, isRetryable: isRetryableReadinessError,
      observe: signal => new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {once: true});
        controller.abort();
      }),
    }),
    startLocal: async () => { localStarted = true; },
    awaitLocalRegistration: async () => {},
  });
  await expect(pending).rejects.toMatchObject({facts: {reason: 'cancelled'}});
  expect(localStarted).toBe(false);
});

test('a Cloud readiness failure never starts local', async () => {
  const order: string[] = [];
  await expect(runOrderedManagedLocalBootstrap({
    startInfrastructureAndCloud: async () => { order.push('cloud'); },
    awaitCloudApiReady: async () => { order.push('ready'); throw new ManagedLocalBootstrapError({phase: 'cloud-api-readiness', reason: 'deadline', required: facts0}); },
    startLocal: async () => { order.push('local'); },
    awaitLocalRegistration: async () => { order.push('registered'); },
  })).rejects.toThrow(/deadline/);
  expect(order).toEqual(['cloud', 'ready']);
  expect(order).not.toContain('local');
});

test('accepts only a complete Cloud-issued managed-local registration', () => {
  const issued = {
    registered: true,
    publicUrl: 'https://a-local-1a2b3c4d.nodes.acceptance.test/',
    provisionCode: 'eyJub2RlSWQiOiJ4In0.signature',
  };
  expect(() => assertManagedLocalRegistration(issued)).not.toThrow();
  for (const mutate of [
    (v: any) => { v.registered = false; },
    (v: any) => { delete v.publicUrl; },
    (v: any) => { v.publicUrl = 'http://a-local.nodes.acceptance.test/'; },
    (v: any) => { v.publicUrl = 'https://localhost/'; },
    (v: any) => { delete v.provisionCode; },
  ]) {
    const value = JSON.parse(JSON.stringify(issued));
    mutate(value);
    expect(() => assertManagedLocalRegistration(value)).toThrow();
  }
  expect(() => assertManagedLocalRegistration(undefined)).toThrow();
});

/** Stale-diagnosis contract: a bootstrap error is reported only while that
 * bootstrap is the current failure. A successful bootstrap followed by an
 * unrelated failure must not surface any bootstrap phase. */
test('a successful bootstrap leaves no stale diagnosis for a later failure', async () => {
  let reported: any;
  const run = async (bootstrapBehaviour: 'transient-then-ok' | 'ok' | 'fail') => {
    reported = undefined;
    try {
      await runOrderedManagedLocalBootstrap({
        startInfrastructureAndCloud: async () => {},
        awaitCloudApiReady: async () => {
          if (bootstrapBehaviour === 'fail') throw new ManagedLocalBootstrapError({phase: 'cloud-api-readiness', reason: 'deadline', required: facts0});
          if (bootstrapBehaviour === 'transient-then-ok') {
            let attempt = 0;
            await awaitReadiness({
              phase: 'cloud-api-readiness', emptyFacts: facts0, deadline: 10_000, budgetMs: 600_000,
              isCancelled: () => false, now: () => 0, isRetryable: isRetryableReadinessError,
              observe: async () => {
                attempt += 1;
                if (attempt === 1) { const e: any = new Error('refused'); throw e; }
                return {edition: 'cloud'};
              },
            });
          }
        },
        startLocal: async () => {},
        awaitLocalRegistration: async () => {},
      });
      // An unrelated later failure in the same run.
      throw new Error('chat layer failed');
    } catch (error) {
      const facts = error instanceof ManagedLocalBootstrapError ? error.facts : undefined;
      if (facts) reported = facts;
    }
  };

  await run('fail');
  expect(reported?.phase).toBe('cloud-api-readiness');

  await run('transient-then-ok');
  expect(reported).toBeUndefined();

  await run('ok');
  expect(reported).toBeUndefined();
});

// platformFixtureBaseUrl / platformBuiltinServiceEnvironment / platformBuiltinLiveEnvironment
import {
  platformBuiltinLiveEnvironment,
  platformBuiltinServiceEnvironment,
  platformFixtureBaseUrl,
} from '../../scripts/accept-service-image-modes';

test('the shared platform fixture base URL must be public HTTPS and is normalized once', () => {
  expect(platformFixtureBaseUrl('https://id-rc.undefineds.cn/v1/')).toBe('https://id-rc.undefineds.cn/v1');
  for (const rejected of [undefined, '', 'not-a-url', 'http://id-rc.undefineds.cn/v1',
    'https://localhost/v1', 'https://127.0.0.1/v1', 'https://[::1]/v1',
    'https://user:pass@id-rc.undefineds.cn/v1', 'https://id-rc.undefineds.cn/v1?x=1',
    'https://id-rc.undefineds.cn/v1#fragment']) {
    expect(() => platformFixtureBaseUrl(rejected)).toThrow();
  }
});

test('only the owned Cloud service receives the real DEFAULT_* builtin config, key by interpolation', () => {
  const base = 'https://id-rc.undefineds.cn/v1';
  expect(platformBuiltinServiceEnvironment('local', base)).toEqual({});
  expect(platformBuiltinServiceEnvironment('standalone', base)).toEqual({});
  expect(platformBuiltinServiceEnvironment('cloud', base)).toEqual({
    DEFAULT_API_BASE: base,
    // Private process env is interpolated by compose; the literal secret never enters this file.
    DEFAULT_API_KEY: '${XPOD_MATRIX_PLATFORM_API_KEY:?required}',
  });
  // A key value must never be accepted as an argument at all.
  expect(platformBuiltinServiceEnvironment.length).toBe(2);
});

test('the live platform-builtin flag is passed only to cloud mode', () => {
  expect(platformBuiltinLiveEnvironment('cloud')).toEqual({ XPOD_LIVE_PLATFORM_BUILTIN: '1' });
  expect(platformBuiltinLiveEnvironment('local')).toEqual({});
  expect(platformBuiltinLiveEnvironment('standalone')).toEqual({});
});

test('the matrix harness serializes the platform base URL but never the platform key', async () => {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const script = await readFile(path.resolve('scripts/accept-service-image-modes.ts'), 'utf8');
  // The compose document can only reference the key through interpolation.
  expect(script).toContain("DEFAULT_API_KEY: '${XPOD_MATRIX_PLATFORM_API_KEY:?required}'");
  expect(/DEFAULT_API_KEY:\s*`\$\{provider/.test(script)).toBe(false);
  expect(script).not.toContain('DEFAULT_API_KEY: provider');
  // The raw inspect document is projected so Config.Env can never reach the private command log.
  expect(script).toContain("'inspect', '--format'");
  expect(script).not.toContain("['inspect', id]");
  // The cloud builtin lane requires the exact declared model instead of accepting any projection.
  const canary = await readFile(path.resolve('scripts/accept-live-gateway-login-chat.ts'), 'utf8');
  expect(canary).toContain("projectModelsAndChat(gatewayKey, ['linx-lite'], 'linx-lite')");
  expect(canary).not.toContain("projectModelsAndChat(gatewayKey, ['linx-lite'])");
});

async function withSessionEvidence(run: (directory: string) => Promise<void>): Promise<void> {
  await mkdir(path.resolve('.test-data'), {recursive: true});
  const directory = await mkdtemp(path.resolve('.test-data/session-export-'));
  try { await run(directory); } finally { await rm(directory, {recursive: true, force: true}); }
}

const sessionFailure = {schemaVersion: 1, diagnostic: {
  phase: 'restart-runtime', reason: 'assertion-failed', authorizationCodes: 1,
  passwordPosts: 1, refreshGrants: 1, refreshFailures: 0, requestCount: 181,
  // The closed schema gained this 8th field. A failure recorded before a restart
  // observer existed legitimately has no observer data, so the honest projection
  // is all zeros with present=0 - not an omitted key.
  restartObserver: {present: 0, authorizationCodes: 0, passwordPosts: 0,
    refreshTokens: 0, opaquePosts: 0, ready: 0, hostImported: 0, failed: 0},
  // The closed schema also carries the bounded private-read class and the two
  // readiness flags, so a real RC failure names WHAT failed, not just where.
  privateRead: 'not-reached', privateReadStatus: 0, authenticated: 0, hostReady: 0,
}};

test('failed session exports its bounded checkpoint and excludes private output', async () => {
  await withSessionEvidence(async directory => {
    const safe = path.join(directory, 'safe');
    await mkdir(safe, {mode: 0o700});
    await writeFile(path.join(safe, 'failure.safe.json'), JSON.stringify(sessionFailure), {mode: 0o600});
    await writeFile(path.join(directory, 'stdout.private.log'), 'private-test-key', {mode: 0o600});
    const exported = new Map<string, Buffer>();
    await exportSessionSafeEvidence(safe, async (name, bytes) => { exported.set(name, bytes); }, 'session-cloud-renew');
    expect([...exported.keys()]).toEqual([path.join('session-cloud-renew', 'failure.safe.json')]);
    expect(JSON.parse(exported.values().next().value!.toString())).toEqual(sessionFailure);
    expect([...exported.values()].some(bytes => bytes.includes('private-test-key'))).toBe(false);
  });
});

test('session export drops malformed, oversized and out-of-schema failure data', async () => {
  await withSessionEvidence(async directory => {
    for (const bytes of [
      '{invalid-json',
      JSON.stringify({...sessionFailure, token: 'private-test-key'}),
      JSON.stringify({...sessionFailure, diagnostic: {...sessionFailure.diagnostic, requestCount: -1}}),
      // The OLD 7-key shape (no restartObserver) must stay inadmissible: the schema
      // is closed at exactly 8 keys, so accepting it would silently weaken the
      // contract this fixture was updated to satisfy.
      JSON.stringify({schemaVersion: 1, diagnostic: {
        phase: 'restart-runtime', reason: 'assertion-failed', authorizationCodes: 1,
        passwordPosts: 1, refreshGrants: 1, refreshFailures: 0, requestCount: 181,
      }}),
      ' '.repeat(4097) + JSON.stringify(sessionFailure),
    ]) {
      await writeFile(path.join(directory, 'failure.safe.json'), bytes, {mode: 0o600});
      const exported: string[] = [];
      await exportSessionSafeEvidence(directory, async name => { exported.push(name); }, 'session-cloud-renew');
      expect(exported).toEqual([]);
    }
  });
});
