// B-owned native execution-descriptor lifecycle tests. Controlled OWN IPC producers only; this is
// not production QLever, current Gateway or Cloud acceptance.
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalQleverNativeSparqlClient } from '../../../src/storage/rdf/LocalQleverNativeSparqlClient';
import { SqliteAuthorityExclusionGate } from '../../../src/storage/AuthorityExclusionGate';

const ROOT = path.resolve('.test-data/native-query-execution');
const PRODUCER = path.join(ROOT, 'controlled-native-producer.cjs');

const producerSource = `
const fs = require('node:fs');
const readline = require('node:readline');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const first = !fs.existsSync(config.generationFile);
fs.writeFileSync(config.generationFile, 'started');
fs.writeFileSync(config.pidFile, String(process.pid));
const ready = () => process.stdout.write(JSON.stringify({ type: 'ready', backend: 'sqlite', abiVersion: 1, physicalBackendAbiVersion: 7 }) + '\\n');
if (config.mode === 'abi' && first) {
  // Fail the startup readiness contract, then remain alive until released so cleanup must be proven.
  process.on('SIGTERM', () => {});
  process.stdout.write(JSON.stringify({ type: 'ready', backend: 'sqlite', abiVersion: 2, physicalBackendAbiVersion: 7 }) + '\\n');
  setInterval(() => { if (fs.existsSync(config.releaseFile)) process.exit(0); }, 5);
} else if (config.readyBarrier) {
  const wait = setInterval(() => {
    if (fs.existsSync(config.readyFile)) { clearInterval(wait); ready(); }
  }, 5);
} else {
  ready();
}
const held = new Set();
let shuttingDown = false;
function sendResult(id) {
  process.stdout.write(JSON.stringify({ id, type: 'result', result: { status: 'ok',
    mediaType: 'application/sparql-results+json', body: JSON.stringify({ boolean: true }),
    profile: { pid: process.pid } } }) + '\\n');
}
function tryRelease() {
  if (config.releaseFile && fs.existsSync(config.releaseFile)) {
    for (const id of held) sendResult(id);
    held.clear();
    if (shuttingDown) process.exit(0);
    return true;
  }
  if (shuttingDown && held.size === 0) process.exit(0);
  return false;
}
setInterval(tryRelease, 5);
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.type === 'cancel') { return; } // cancel only sets a flag; never a terminal
  if (message.type === 'shutdown') { shuttingDown = true; tryRelease(); return; }
  if (message.type !== 'query') return;
  const prior = config.queriesFile && fs.existsSync(config.queriesFile)
    ? fs.readFileSync(config.queriesFile, 'utf8') : '';
  const priorCount = prior.trim() ? prior.trim().split('\\n').length : 0;
  if (config.queriesFile) fs.appendFileSync(config.queriesFile, message.id + '\\n');
  const mode = config.mode || 'respond';
  if (mode === 'malformed') { process.stdout.write('{not-json\\n'); return; }
  if (mode === 'exit') { process.stderr.write('controlled producer exit\\n'); process.exit(23); }
  if (mode === 'exit-once' && priorCount === 0) { process.exit(23); }
  if (mode === 'abi' && first) {
    process.stdout.write(JSON.stringify({ type: 'ready', backend: 'sqlite', abiVersion: 2, physicalBackendAbiVersion: 7 }) + '\\n');
    return;
  }
  if (mode === 'error') {
    process.stdout.write(JSON.stringify({ id: message.id, type: 'error',
      code: 'controlled_error', message: 'controlled failure' }) + '\\n');
    return;
  }
  if (mode === 'hold-until-release') { held.add(message.id); return; }
  if (mode === 'delay') { setTimeout(() => sendResult(message.id), config.delayMs || 50); return; }
  sendResult(message.id);
});
`;

interface ControlledClient {
  dir: string;
  client: LocalQleverNativeSparqlClient;
  pidFile: string;
  releaseFile: string;
  queriesFile: string;
  readyFile: string;
  configFile: string;
}

async function startControlledClient(
  mode: string,
  extra: { delayMs?: number; readyBarrier?: boolean; generationFile?: string } = {},
): Promise<ControlledClient> {
  await mkdir(ROOT, { recursive: true });
  const dir = await mkdtemp(path.join(ROOT, 'run-'));
  const pidFile = path.join(dir, 'owned.pid');
  const releaseFile = path.join(dir, 'release');
  const queriesFile = path.join(dir, 'queries.log');
  const readyFile = path.join(dir, 'ready-release');
  const generationFile = extra.generationFile ?? path.join(dir, 'generation');
  const configFile = path.join(dir, 'config.json');
  await writeFile(configFile, JSON.stringify({
    mode, pidFile, releaseFile, queriesFile, readyFile, generationFile, ...extra,
  }));
  const client = new LocalQleverNativeSparqlClient({
    command: process.execPath,
    args: [ PRODUCER, configFile ],
    expectedNativeSparqlAbiVersion: 1,
    expectedPhysicalBackendAbiVersion: 7,
  });
  return { dir, client, pidFile, releaseFile, queriesFile, readyFile, configFile };
}

async function waitForFile(file: string, label: string): Promise<string> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try { return await readFile(file, 'utf8'); } catch { /* not yet */ }
    await tick(5);
  }
  throw new Error(`controlled fixture did not reach ${label}`);
}

async function cleanup(fixture: ControlledClient): Promise<void> {
  await fixture.client.close().catch(() => undefined);
  await rm(fixture.dir, { recursive: true, force: true }).catch(() => undefined);
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function ownedPid(fixture: ControlledClient): Promise<number> {
  const pid = Number(await waitForFile(fixture.pidFile, 'owned pid'));
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
  return pid;
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDispatchedQuery(fixture: ControlledClient): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      if ((await readFile(fixture.queriesFile, 'utf8')).trim().length > 0) {
        return;
      }
    } catch {
      // producer has not written the query log yet
    }
    await tick(5);
  }
  throw new Error('controlled producer never received the dispatched query');
}

describe('LocalQleverNativeSparqlClient generic query execution descriptor', () => {
  beforeAll(async () => {
    await mkdir(ROOT, { recursive: true });
    await writeFile(PRODUCER, producerSource);
  });

  afterAll(async () => {
    await rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
  });

  it('creates a descriptor without spawning, and pre-start cancel settles it with no side effect', async () => {
    const fixture = await startControlledClient('respond');
    try {
      const execution = fixture.client.createQueryExecution('ASK {}', { basePath: 'https://pod.example/' });
      await tick(20);
      await expect(stat(fixture.pidFile)).rejects.toBeDefined();

      let drained = false;
      void execution.drained.then(() => { drained = true; });
      execution.cancel();
      await expect(execution.result).rejects.toMatchObject({ code: 'qlever_request_aborted' });
      execution.start();
      await expect(execution.drained).resolves.toBeUndefined();
      expect(drained).toBe(true);
      await expect(stat(fixture.pidFile)).rejects.toBeDefined();
    } finally {
      await cleanup(fixture);
    }
  });

  it('starts idempotently and resolves both result and drain for a healthy query', async () => {
    const fixture = await startControlledClient('respond');
    try {
      const execution = fixture.client.createQueryExecution('ASK {}', { basePath: 'https://pod.example/' });
      execution.start();
      execution.start();
      const result = await execution.result;
      await execution.drained;
      expect(result).toMatchObject({ status: 'ok' });
      expect(processAlive(await ownedPid(fixture))).toBe(true);
      const queries = (await readFile(fixture.queriesFile, 'utf8')).trim().split('\n');
      expect(queries, 'idempotent start must dispatch exactly one request').toHaveLength(1);
    } finally {
      await cleanup(fixture);
    }
  });

  it('keeps drain pending after a caller timeout until the live producer reaches a controlled terminal', async () => {
    const fixture = await startControlledClient('hold-until-release');
    try {
      const execution = fixture.client.createQueryExecution('ASK {}', {
        basePath: 'https://pod.example/', timeoutMs: 30,
      });
      let drained = false;
      void execution.drained.then(() => { drained = true; });
      execution.start();
      await expect(execution.result).rejects.toMatchObject({ code: 'qlever_request_timeout' });
      await tick(60);
      const pid = await ownedPid(fixture);
      expect(processAlive(pid), 'timeout must not kill the shared producer').toBe(true);
      expect(drained, 'a cancel message/timer is not producer drain').toBe(false);

      await writeFile(fixture.releaseFile, 'release\n');
      await expect(execution.drained).resolves.toBeUndefined();
      expect(drained).toBe(true);
      expect(processAlive(pid)).toBe(true);
    } finally {
      await cleanup(fixture);
    }
  });

  it('keeps drain pending after abort and leaves a concurrent request unaffected', async () => {
    const fixture = await startControlledClient('hold-until-release');
    try {
      const controller = new AbortController();
      const aborted = fixture.client.createQueryExecution('ASK {}', {
        basePath: 'https://pod.example/', signal: controller.signal,
      });
      let abortedDrained = false;
      void aborted.drained.then(() => { abortedDrained = true; });
      aborted.start();
      await waitForDispatchedQuery(fixture);
      controller.abort(new Error('controlled abort'));
      await expect(aborted.result).rejects.toBeDefined();
      await tick(30);
      expect(abortedDrained).toBe(false);

      const concurrent = fixture.client.createQueryExecution('ASK {}', { basePath: 'https://pod.example/' });
      concurrent.start();
      await writeFile(fixture.releaseFile, 'release\n');
      await expect(concurrent.result).resolves.toMatchObject({ status: 'ok' });
      await concurrent.drained;
      await aborted.drained;
      expect(processAlive(await ownedPid(fixture))).toBe(true);
    } finally {
      await cleanup(fixture);
    }
  });

  it('shares one close completion and reaps the owned child before resolving', async () => {
    const fixture = await startControlledClient('hold-until-release');
    try {
      await fixture.client.start();
      const pid = await ownedPid(fixture);
      const execution = fixture.client.createQueryExecution('ASK {}', { basePath: 'https://pod.example/' });
      execution.start();
      void execution.result.catch(() => undefined);
      await waitForDispatchedQuery(fixture);

      const first = fixture.client.close();
      const second = fixture.client.close();
      expect(second, 'all close calls must share one completion promise').toBe(first);
      let firstDone = false;
      let secondDone = false;
      void first.then(() => { firstDone = true; });
      void second.then(() => { secondDone = true; });
      await tick(20);
      expect(processAlive(pid)).toBe(true);
      expect(firstDone).toBe(false);
      expect(secondDone).toBe(false);

      // A dispatched request may complete with its real correlated result before close terminates the
      // shared producer; either a real result or the close error is a valid caller outcome. Drain must
      // never resolve while the owned child is still alive.
      await writeFile(fixture.releaseFile, 'release\n');
      await Promise.all([ first, second ]);
      expect(processAlive(pid), 'completed close must have reaped its owned child').toBe(false);
      await execution.drained;
      await execution.result.then(
        () => undefined,
        (error: { code?: string }) => expect(error.code).toBe('qlever_runtime_closed'),
      );
    } finally {
      await rm(fixture.dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('drains after confirmed termination on malformed output and unexpected exit', async () => {
    const malformed = await startControlledClient('malformed');
    try {
      const execution = malformed.client.createQueryExecution('SELECT * WHERE { }', { basePath: 'https://pod.example/' });
      execution.start();
      await expect(execution.result).rejects.toMatchObject({ code: 'qlever_runtime_protocol_error' });
      await execution.drained;
      await malformed.client.close();
    } finally {
      await cleanup(malformed);
    }

    const exited = await startControlledClient('exit');
    try {
      const execution = exited.client.createQueryExecution('SELECT * WHERE { }', { basePath: 'https://pod.example/' });
      execution.start();
      await expect(execution.result).rejects.toMatchObject({ code: 'qlever_runtime_unavailable' });
      await execution.drained;
      await exited.client.close();
    } finally {
      await cleanup(exited);
    }
  });

  it('settles the old incarnation and serves a later request from a fresh child', async () => {
    const fixture = await startControlledClient('exit-once');
    try {
      const first = fixture.client.createQueryExecution('ASK {}', { basePath: 'https://pod.example/' });
      first.start();
      await expect(first.result).rejects.toMatchObject({ code: 'qlever_runtime_unavailable' });
      await first.drained;

      const second = fixture.client.createQueryExecution('ASK {}', { basePath: 'https://pod.example/' });
      second.start();
      await expect(second.result).resolves.toMatchObject({ status: 'ok' });
      await second.drained;
      expect(processAlive(await ownedPid(fixture))).toBe(true);
      const queries = (await readFile(fixture.queriesFile, 'utf8')).trim().split('\n');
      expect(queries).toHaveLength(2);
    } finally {
      await cleanup(fixture);
    }
  });

  it('holds the public physical gate until descriptor.drained after the caller timed out', async () => {
    const fixture = await startControlledClient('hold-until-release');
    const gate = new SqliteAuthorityExclusionGate(path.join(fixture.dir, 'coordination.sqlite'), {
      retryDelayMs: 1, defaultTimeoutMs: 100,
    });
    try {
      await fixture.client.start();
      const pid = await ownedPid(fixture);
      const execution = fixture.client.createQueryExecution('ASK {}', {
        basePath: 'https://pod.example/', timeoutMs: 25,
      });
      let drained = false;
      void execution.drained.then(() => { drained = true; });

      let holderDone = false;
      const holder = gate.runExclusive(async () => {
        execution.start();
        await expect(execution.result).rejects.toMatchObject({ code: 'qlever_request_timeout' });
        await execution.drained; // retained internal gate callback waits for the real terminal
        holderDone = true;
      });

      let peerCallbacks = 0;
      const peer = gate.runExclusive(() => { peerCallbacks += 1; }, { timeoutMs: 60 })
        .then(() => 'admitted', (error: { name?: string }) => error.name ?? 'rejected');

      await tick(150);
      expect(holderDone, 'the gate must still be held by the awaited drain').toBe(false);
      expect(drained).toBe(false);
      expect(peerCallbacks, 'a peer callback must not run while drain is pending').toBe(0);

      await writeFile(fixture.releaseFile, 'release\n');
      await holder;
      await expect(peer).resolves.toBe('AuthorityExclusionTimeoutError');

      let admitted = 0;
      await gate.runExclusive(() => { admitted += 1; });
      expect(admitted).toBe(1);
      expect(processAlive(pid)).toBe(true);
    } finally {
      await rm(fixture.releaseFile, { force: true }).catch(() => undefined);
      await fixture.client.close().catch(() => undefined);
      await gate.close().catch(() => undefined);
      await rm(fixture.dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it.each([ 'signal', 'descriptor' ] as const)(
    'keeps %s-cancelled startup tracked until real initialization completes',
    async cancelMode => {
      const fixture = await startControlledClient('respond', { readyBarrier: true });
      try {
        const controller = new AbortController();
        const execution = fixture.client.createQueryExecution('ASK {}', {
          basePath: 'https://pod.example/', signal: controller.signal,
        });
        let drained = false;
        void execution.drained.then(() => { drained = true; });
        execution.start();
        await waitForFile(fixture.pidFile, 'owned pid');
        if (cancelMode === 'signal') controller.abort(new Error('controlled startup abort'));
        else execution.cancel();
        await expect(execution.result).rejects.toBeDefined();
        await tick(20);
        expect(drained, 'startup abort/cancel is not producer completion').toBe(false);
        await expect(stat(fixture.queriesFile)).rejects.toBeDefined();

        await writeFile(fixture.readyFile, 'ready\n');
        await fixture.client.start(); // actual owned producer ready, not an elapsed-time guess
        await execution.drained;
        expect(drained).toBe(true);
        await expect(stat(fixture.queriesFile), 'no query may be dispatched after cancellation').rejects.toBeDefined();
      } finally {
        await writeFile(fixture.readyFile, 'ready\n').catch(() => undefined);
        await cleanup(fixture);
      }
    },
  );

  it.each([ 'abi' ] as const)(
    'drains failed %s startup only after its owned producer actually terminates',
    async mode => {
      const fixture = await startControlledClient(mode, { readyBarrier: false });
      try {
        const execution = fixture.client.createQueryExecution('ASK {}', { basePath: 'https://pod.example/' });
        let drained = false;
        void execution.drained.then(() => { drained = true; });
        execution.start();
        const pid = await ownedPid(fixture);
        await expect(execution.result).rejects.toBeDefined();
        expect(processAlive(pid), 'failed startup producer awaits actual cleanup').toBe(true);
        expect(drained, 'startup failure outcome does not prove producer termination').toBe(false);
        await writeFile(fixture.releaseFile, 'release\n');
        await waitForProcessExit(pid);
        await execution.drained;
        expect(drained).toBe(true);
      } finally {
        await writeFile(fixture.releaseFile, 'release\n').catch(() => undefined);
        await cleanup(fixture);
      }
    },
  );

  it('awaits every old producer incarnation when closing a restarted client', async () => {
    const fixture = await startControlledClient('abi', { readyBarrier: false });
    let oldPid: number | undefined;
    try {
      // The first child fails ABI and waits for the release file before exiting (SIGTERM ignored by
      // the controlled producer), so its cleanup outlives a restart attempt.
      await expect(fixture.client.start()).rejects.toMatchObject({ code: 'qlever_runtime_protocol_error' });
      oldPid = await ownedPid(fixture);
      expect(processAlive(oldPid), 'old cleanup is still outstanding').toBe(true);

      // The second generation is healthy; readiness must retain the old outstanding cleanup.
      await fixture.client.start();
      const newPid = await ownedPid(fixture);
      expect(newPid).not.toBe(oldPid);
      expect(processAlive(newPid)).toBe(true);
      expect(processAlive(oldPid), 'restart must not discard the old producer').toBe(true);

      let closeDone = false;
      const close = fixture.client.close().then(() => { closeDone = true; });
      await tick(30);
      expect(closeDone, 'close must await the older producer cleanup').toBe(false);
      expect(processAlive(oldPid), 'close cannot complete while an owned producer is alive').toBe(true);
      await writeFile(fixture.releaseFile, 'release\n');
      await close;
      expect(processAlive(oldPid), 'close completion includes the older producer').toBe(false);
      expect(processAlive(newPid), 'close completion includes the new producer').toBe(false);
    } finally {
      await writeFile(fixture.releaseFile, 'release\n').catch(() => undefined);
      await fixture.client.close().catch(() => undefined);
      if (oldPid !== undefined) await waitForProcessExit(oldPid);
      await rm(fixture.dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (!processAlive(pid)) {
      return;
    }
    await tick(5);
  }
  throw new Error(`owned producer ${pid} did not exit`);
}
