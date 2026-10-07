// Root-owned actual IPC lifecycle regressions; production QLever qualification remains separate.
import { ChildProcess } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { LocalQleverNativeSparqlClient } from '../../../src/storage/rdf/LocalQleverNativeSparqlClient';

const source = `
const fs = require('node:fs');
const readline = require('node:readline');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.on('SIGTERM', () => {});
fs.writeFileSync(config.pidFile, String(process.pid));
let ready = false;
setInterval(() => {
  if (fs.existsSync(config.releaseFile)) process.exit(0);
  if (!ready && (config.mode === 'healthy' || fs.existsSync(config.readyFile))) {
    ready = true;
    process.stdout.write(JSON.stringify({type:'ready', backend:'sqlite',
      abiVersion:config.mode === 'healthy' ? 1 : 2, physicalBackendAbiVersion:7}) + '\\n');
  }
}, 5);
readline.createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'shutdown' && config.mode === 'healthy') process.exit(0);
  if (message.type === 'query') process.stdout.write(JSON.stringify({id:message.id, type:'result',
    result:{status:'ok', mediaType:'application/sparql-results+json', body:'{"boolean":true}'}}) + '\\n');
});
`;

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

async function fixture(mode: 'healthy' | 'bad-abi') {
  const parent = path.resolve('.test-data/native-cleanup-failure');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'root-'));
  const pidFile = path.join(directory, 'owned.pid');
  const readyFile = path.join(directory, 'ready');
  const releaseFile = path.join(directory, 'release');
  const producer = path.join(directory, 'producer.cjs');
  const config = path.join(directory, 'config.json');
  await writeFile(producer, source);
  await writeFile(config, JSON.stringify({ mode, pidFile, readyFile, releaseFile }));
  const client = new LocalQleverNativeSparqlClient({ command: process.execPath,
    args: [producer, config], expectedNativeSparqlAbiVersion: 1, expectedPhysicalBackendAbiVersion: 7 });
  const pid = async () => {
    const until = performance.now() + 5000;
    while (performance.now() < until) {
      try {
        const value = Number(await readFile(pidFile, 'utf8'));
        if (Number.isSafeInteger(value) && value > 0) return value;
      } catch { /* actual startup file barrier */ }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('owned producer did not write its PID');
  };
  const cleanup = async () => {
    await writeFile(releaseFile, 'release\n');
    await client.close().catch(() => undefined);
    const ownedPid = await pid();
    const until = performance.now() + 5000;
    while (alive(ownedPid) && performance.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(alive(ownedPid), 'only this fixture child must be reaped').toBe(false);
    await rm(directory, { recursive: true, force: true });
  };
  return { client, pid, readyFile, cleanup };
}

it('does not report drain or successful close when terminating its live owned producer throws', async () => {
  const f = await fixture('bad-abi');
  const execution = f.client.createQueryExecution('ASK {}', { basePath: 'https://root.invalid/' });
  let restoreKill: (() => void) | undefined;
  try {
    let drained = false;
    void execution.drained.then(() => { drained = true; });
    execution.start();
    const pid = await f.pid();
    let attempted!: () => void;
    const killAttempt = new Promise<void>(resolve => { attempted = resolve; });
    const original = ChildProcess.prototype.kill;
    const kill = vi.spyOn(ChildProcess.prototype, 'kill').mockImplementation(function(this: ChildProcess, signal) {
      if (this.pid === pid) {
        attempted();
        throw new Error('Root controlled owned termination failure');
      }
      return original.call(this, signal);
    });
    restoreKill = () => kill.mockRestore();
    await writeFile(f.readyFile, 'ready\n');
    await expect(execution.result).rejects.toMatchObject({ code: 'qlever_runtime_protocol_error' });
    await killAttempt;
    await nextTurn();
    let closeSucceeded = false;
    const close = f.client.close().then(() => { closeSucceeded = true; }, () => undefined);
    await nextTurn();
    await nextTurn();
    expect(alive(pid), 'injected kill failure leaves actual producer alive').toBe(true);
    expect.soft(drained, 'a termination exception is not actual producer drain').toBe(false);
    expect.soft(closeSucceeded, 'close cannot succeed with an unconfirmed live owned producer').toBe(false);
    // The finally release is actual fixture exit; no public outcome is used as the proof.
    void close;
  } finally {
    restoreKill?.();
    await f.cleanup();
    await execution.drained;
  }
}, 30_000);

it('removes all per-request abort listeners after successful queries on a reused signal', async () => {
  const f = await fixture('healthy');
  const controller = new AbortController();
  const baseline = getEventListeners(controller.signal, 'abort').length;
  try {
    for (let count = 0; count < 3; count += 1) {
      const execution = f.client.createQueryExecution('ASK {}', {
        basePath: 'https://root.invalid/', signal: controller.signal,
      });
      execution.start();
      await expect(execution.result).resolves.toMatchObject({ status: 'ok' });
      await execution.drained;
    }
    expect(getEventListeners(controller.signal, 'abort').length,
      'completed requests must not retain their startup listeners').toBe(baseline);
  } finally { await f.cleanup(); }
}, 30_000);
