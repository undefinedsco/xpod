import {test, expect} from 'bun:test';
import {
  assertManagedLocalRegistration,
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
