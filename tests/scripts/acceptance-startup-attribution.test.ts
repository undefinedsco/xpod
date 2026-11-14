import {test,expect} from 'bun:test';
import {runOrderedManagedLocalBootstrap,type ManagedLocalBootstrapPhase} from '../../scripts/accept-service-image-modes';

/** RC382 wiring correction: attribute a startup failure to the mode whose START
 * actually failed, never to an arbitrary awaited phase, and never fabricate an
 * exit code.
 *
 * These tests drive the REAL exported executor through its REAL diagnostics hook.
 * The phase tracking, the per-phase record boundary and the 0..255 code
 * derivation all live in the product function, so there is no mirrored
 * attribution logic here. */

type Fail = Partial<Record<ManagedLocalBootstrapPhase, Error>>;

/** Run the real executor with injected operations that ACTUALLY APPEND records,
 * exactly like `command()` does in the matrix. */
async function runReal(options: {
  fail?: Fail;
  // records appended by a phase before it throws (mimics the real command row)
  appendOn?: Partial<Record<ManagedLocalBootstrapPhase, any[]>>;
  hookThrows?: boolean;
  /** Make readCommandRecords throw while the named phase's work runs. */
  readerThrowsIn?: ManagedLocalBootstrapPhase;
  /** Append these (stale, earlier-phase) rows once the reader starts throwing. */
  staleOnReaderThrow?: any[];
  /** Reader recovers after `readerThrowsIn`; these stale rows remain visible. */
  recoverWithStale?: any[];
} = {}) {
  const commands: any[] = [];
  const seen: Array<{phase: string; mode?: string; commandExitCode?: number}> = [];
  const order: string[] = [];
  const rows = options.appendOn ?? {};
  const step = (phase: ManagedLocalBootstrapPhase) => async () => {
    order.push(phase);
    for (const row of rows[phase] ?? []) commands.push(row);
    if (options.fail?.[phase]) throw options.fail[phase];
  };
  let propagated: unknown;
  let readerFailing = false;
  let currentPhase: ManagedLocalBootstrapPhase | undefined;
  const tracked = (phase: ManagedLocalBootstrapPhase) => async () => {
    currentPhase = phase;
    if (options.readerThrowsIn === phase) {
      readerFailing = true;
      for (const row of options.staleOnReaderThrow ?? []) commands.push(row);
    }
    return step(phase)();
  };
  try {
    await runOrderedManagedLocalBootstrap({
      startInfrastructureAndCloud: tracked('infra-cloud'),
      awaitCloudApiReady: tracked('cloud-api-readiness'),
      startLocal: tracked('local'),
      awaitLocalRegistration: tracked('local-registration'),
    }, {
      readCommandRecords: () => {
        if (readerFailing) {
          // Recovery: stop throwing but keep the stale rows visible.
          if (options.recoverWithStale) {
            for (const row of options.recoverWithStale) commands.push(row);
            readerFailing = false;
          } else throw new Error('record reader exploded');
        }
        return commands;
      },
      onFailure: context => {
        seen.push(context as any);
        if (options.hookThrows) throw new Error('diagnostic callback exploded');
      },
    });
  } catch (error) { propagated = error; }
  return {propagated, seen, order, commands, currentPhase};
}

test('a cloud START failure is attributed to cloud by the real executor', async () => {
  const boom = new Error('cloud compose failed');
  const r = await runReal({fail: {'infra-cloud': boom}, appendOn: {'infra-cloud': [{code: 125}]}});
  expect(r.propagated).toBe(boom);
  expect(r.seen).toHaveLength(1);
  expect(r.seen[0]).toEqual({phase: 'infra-cloud', mode: 'cloud', commandExitCode: 125});
});

test('a local START failure is attributed to local by the real executor', async () => {
  const boom = new Error('local compose failed');
  const r = await runReal({fail: {local: boom}, appendOn: {local: [{code: 1}]}});
  expect(r.propagated).toBe(boom);
  expect(r.seen[0]).toEqual({phase: 'local', mode: 'local', commandExitCode: 1});
});

test('the observed code is the LAST own-phase record, never an earlier success', async () => {
  // infra-cloud appends a successful row; local appends 3 then 7. Only local's own
  // LAST record describes how the phase ended.
  const boom = new Error('local failed');
  const r = await runReal({
    fail: {local: boom},
    appendOn: {'infra-cloud': [{code: 0}], local: [{code: 3}, {code: 7}]},
  });
  expect(r.seen[0]).toEqual({phase: 'local', mode: 'local', commandExitCode: 7});
});

test('an earlier 0 never masks a later failing row', async () => {
  const boom = new Error('local failed after a success row');
  const r = await runReal({fail: {local: boom}, appendOn: {local: [{code: 0}, {code: 1}]}});
  expect(r.seen[0]).toEqual({phase: 'local', mode: 'local', commandExitCode: 1});
});

test('a trailing null is UNKNOWN and never falls back to an earlier 0', async () => {
  const boom = new Error('local failed with no numeric tail');
  const r = await runReal({fail: {local: boom}, appendOn: {local: [{code: 0}, {code: null}]}});
  expect(r.seen[0]).toEqual({phase: 'local', mode: 'local'});
  expect('commandExitCode' in r.seen[0]!).toBe(false);
});

test('readiness and registration failures keep a phase but no container or code', async () => {
  for (const phase of ['cloud-api-readiness', 'local-registration'] as const) {
    const boom = new Error(`${phase} failed`);
    const r = await runReal({fail: {[phase]: boom}, appendOn: {'infra-cloud': [{code: 0}]}});
    expect(r.propagated).toBe(boom);
    expect(r.seen[0]).toEqual({phase});
  }
});

test('a missing/null/failed-row code is UNKNOWN, never a fabricated fallback', async () => {
  const boom = new Error('local failed early');
  const r = await runReal({fail: {local: boom}, appendOn: {local: [{code: null}]}});
  expect(r.seen[0]).toEqual({phase: 'local', mode: 'local'});
  expect('commandExitCode' in r.seen[0]!).toBe(false);
  // and with no records at all
  const r2 = await runReal({fail: {local: boom}});
  expect('commandExitCode' in r2.seen[0]!).toBe(false);
});

test('an actual recorded 0 is PRESERVED while the parent still fails', async () => {
  // The real command() throws on eligibility grounds even when code is 0; the
  // executor must still report that observed 0 rather than treating it as success
  // or inventing a fallback.
  const boom = new Error('local start failed for ownership/truncation');
  const r = await runReal({fail: {local: boom}, appendOn: {local: [{code: 0}]}});
  expect(r.propagated).toBe(boom);
  expect(r.seen[0]).toEqual({phase: 'local', mode: 'local', commandExitCode: 0});
  expect(r.seen[0]!.commandExitCode).toBe(0);
});

test('out-of-range and non-integer codes are not reported as observed codes', async () => {
  const boom = new Error('local failed');
  for (const bad of [256, -1, 1.5, '1', undefined, null]) {
    const r = await runReal({fail: {local: boom}, appendOn: {local: [{code: bad}]}});
    expect('commandExitCode' in r.seen[0]!).toBe(false);
  }
});

test('a throwing diagnostics callback still rethrows the identical original error', async () => {
  const boom = new Error('the real local compose failure');
  const r = await runReal({fail: {local: boom}, appendOn: {local: [{code: 1}]}, hookThrows: true});
  expect(r.propagated).toBe(boom);
  expect((r.propagated as Error).message).toBe('the real local compose failure');
  // the callback really ran before it exploded
  expect(r.seen).toHaveLength(1);
});

test('calling without the diagnostics hook behaves exactly as before', async () => {
  const order: string[] = [];
  await runOrderedManagedLocalBootstrap({
    startInfrastructureAndCloud: async () => { order.push('infra-cloud'); },
    awaitCloudApiReady: async () => { order.push('cloud-api-readiness'); },
    startLocal: async () => { order.push('local'); },
    awaitLocalRegistration: async () => { order.push('local-registration'); },
  });
  expect(order).toEqual(['infra-cloud', 'cloud-api-readiness', 'local', 'local-registration']);

  const boom = new Error('no hook, same error');
  let propagated: unknown;
  try {
    await runOrderedManagedLocalBootstrap({
      startInfrastructureAndCloud: async () => { throw boom; },
      awaitCloudApiReady: async () => {},
      startLocal: async () => {},
      awaitLocalRegistration: async () => {},
    });
  } catch (error) { propagated = error; }
  expect(propagated).toBe(boom);
});

test('the executor stops at the failing phase and never runs a later one', async () => {
  const boom = new Error('cloud api');
  const r = await runReal({fail: {'cloud-api-readiness': boom}});
  expect(r.propagated).toBe(boom);
  expect(r.order).toEqual(['infra-cloud', 'cloud-api-readiness']);
});

test('a throwing reader while the workflow otherwise SUCCEEDS never blocks operations', async () => {
  // The reader throws during infra-cloud, but that phase succeeds. Every phase must
  // still run to completion and the bootstrap must resolve normally.
  const commands: any[] = [];
  const order: string[] = [];
  let calls = 0;
  await runOrderedManagedLocalBootstrap({
    startInfrastructureAndCloud: async () => { order.push('infra-cloud'); commands.push({code: 0}); },
    awaitCloudApiReady: async () => { order.push('cloud-api-readiness'); },
    startLocal: async () => { order.push('local'); },
    awaitLocalRegistration: async () => { order.push('local-registration'); },
  }, {
    readCommandRecords: () => { calls++; throw new Error('reader exploded'); },
    onFailure: () => { throw new Error('must not be called on success'); },
  });
  expect(order).toEqual(['infra-cloud', 'cloud-api-readiness', 'local', 'local-registration']);
  expect(calls).toBeGreaterThan(0); // the reader really was exercised
});

test('a reader that throws across the phase boundary and then recovers with stale rows yields UNKNOWN', async () => {
  // The reader is already failing when the executor tries to capture the boundary
  // for `local`, so the boundary is UNKNOWN. It then recovers while stale rows are
  // visible: those must never be mistaken for this phase's own records.
  const commands: any[] = [];
  const seen: any[] = [];
  const boom = new Error('local failed after a blind boundary');
  let fail = false;
  try {
    await runOrderedManagedLocalBootstrap({
      startInfrastructureAndCloud: async () => { commands.push({code: 0}); fail = true; },
      awaitCloudApiReady: async () => {},
      startLocal: async () => { commands.push({code: 2}); throw boom; },
      awaitLocalRegistration: async () => {},
    }, {
      readCommandRecords: () => { if (fail) throw new Error('reader exploded'); return commands; },
      onFailure: context => { seen.push(context); },
    });
  } catch (error) { expect(error).toBe(boom); }
  expect(seen[0]).toEqual({phase: 'local', mode: 'local'});
  expect('commandExitCode' in seen[0]!).toBe(false);
});

test('a reader that throws during the FAILURE still preserves the original error', async () => {
  const boom = new Error('the real local compose failure');
  const r = await runReal({fail: {local: boom}, readerThrowsIn: 'local', appendOn: {local: [{code: 1}]}});
  expect(r.propagated).toBe(boom);
  expect((r.propagated as Error).message).toBe('the real local compose failure');
});

test('multiple own rows select the LAST record: 0 then 1 -> 1, 0 then null -> unknown', async () => {
  const boom = new Error('local failed');
  const seq = await runReal({fail: {local: boom}, appendOn: {local: [{code: 0}, {code: 1}]}});
  expect(seq.seen[0]).toEqual({phase: 'local', mode: 'local', commandExitCode: 1});
  const tail = await runReal({fail: {local: boom}, appendOn: {local: [{code: 0}, {code: null}]}});
  expect('commandExitCode' in tail.seen[0]!).toBe(false);
  // and a genuine trailing 0 is still reported as 0
  const zero = await runReal({fail: {local: boom}, appendOn: {local: [{code: 1}, {code: 0}]}});
  expect(zero.seen[0]).toEqual({phase: 'local', mode: 'local', commandExitCode: 0});
});
