import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { authoritySqlitePeerAdmission } from '../helpers/AuthoritySqlitePeer';

interface OwnerState {
  pid: number;
  databasePath: string;
  started: boolean;
  settled: boolean;
  reads: number;
  rejected: boolean;
  newCallbacks: number;
  nativeRequests: number;
  closeSucceeded: boolean;
}

async function stateBarrier(file: string, predicate: (state: OwnerState) => boolean): Promise<OwnerState> {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    try {
      const state = JSON.parse(await readFile(file, 'utf8')) as OwnerState;
      if (predicate(state)) return state;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Owned producer did not reach its state barrier within 5s');
}

describe('Root unconfirmed producers retain their actual physical owner', () => {
  it.each([ 'sync-thenable', 'startup-double-failure', 'native-freshness-thenable' ] as const)(
    'keeps %s held despite caller rejection and promise settlement until actual owned process exit', async mode => {
      const parent = path.resolve('.test-data/authority-unconfirmed-owner');
      await mkdir(parent, { recursive: true });
      const directory = await mkdtemp(path.join(parent, 'root-'));
      const sourceRoot = path.join(directory, 'source');
      await mkdir(sourceRoot);
      const authority = path.join(sourceRoot, 'messages.ttl');
      await writeFile(authority, '<#msg-id> <urn:root:value> "retained" .\n');
      const stateFile = path.join(directory, 'state.json');
      const settleFile = path.join(directory, 'settle');
      const scriptFile = path.join(directory, 'owner.ts');
      const serviceSource = path.resolve('src/storage/LocalPhysicalOperationService.ts');
      const engineSource = path.resolve('src/storage/rdf/SolidRdfEngine.ts');
      await writeFile(scriptFile, `
        import fs from 'node:fs';
        import { LocalPhysicalOperationService } from ${JSON.stringify(serviceSource)};
        import { SolidRdfEngine } from ${JSON.stringify(engineSource)};
        const operations = new LocalPhysicalOperationService(${JSON.stringify(sourceRoot)});
        const state = { pid: process.pid, databasePath: operations.databasePath, started: false,
          settled: false, reads: 0, rejected: false, newCallbacks: 0, nativeRequests: 0, closeSucceeded: false };
        let resolveCaller;
        const caller = new Promise(resolve => { resolveCaller = resolve; });
        let rejectResult;
        const result = new Promise((_, reject) => { rejectResult = reject; });
        result.catch(() => undefined);
        // Unknown actual work outlives caller settlement. Only owner exit terminates this producer.
        const poll = setInterval(() => {
          if (state.started) { fs.readFileSync(${JSON.stringify(authority)}, 'utf8'); state.reads += 1; }
          if (fs.existsSync(${JSON.stringify(settleFile)}) && !state.settled) {
            state.settled = true; resolveCaller();
            try { operations.runSync(() => { state.newCallbacks += 1; }); } catch {}
            operations.run(() => { state.newCallbacks += 1; }).catch(() => undefined);
            operations.close().then(() => { state.closeSucceeded = true; }, () => undefined);
          }
          fs.writeFileSync(${JSON.stringify(stateFile + '.tmp')}, JSON.stringify(state));
          fs.renameSync(${JSON.stringify(stateFile + '.tmp')}, ${JSON.stringify(stateFile)});
        }, 5);
        if (${JSON.stringify(mode)} === 'sync-thenable') {
          try { operations.runSync(() => { state.started = true; return caller; }); }
          catch { state.rejected = true; }
        } else if (${JSON.stringify(mode)} === 'startup-double-failure') {
          const native = {
            start: () => { state.started = true; return Promise.reject(new Error('Root actual startup fault')); },
            close: () => Promise.reject(new Error('Root unconfirmed cleanup fault')),
            query: () => Promise.reject(new Error('Root unexpected legacy query')),
            createQueryExecution: () => ({
              result,
              drained: new Promise(() => undefined),
              start: () => { state.started = true; },
              cancel: () => { rejectResult(new Error('Root initialization caller cancelled')); },
            }),
          };
          const engine = new SolidRdfEngine({ index: { path: ${JSON.stringify(path.join(directory, 'rdf.sqlite'))} },
            operationService: operations, nativeSparqlClient: native });
          engine.open().then(() => undefined, () => { state.rejected = true; });
        } else {
          let initializing = true;
          const native = {
            start: () => Promise.resolve(),
            close: () => Promise.resolve(),
            query: () => { state.nativeRequests += 1; return Promise.reject(new Error('Root unexpected legacy query')); },
            createQueryExecution: () => ({
              result: Promise.resolve({ status: 'ok', mediaType: 'application/sparql-results+json', body: '{"boolean":true}' }),
              drained: Promise.resolve(),
              start: () => { if (!initializing) state.nativeRequests += 1; },
              cancel: () => undefined,
            }),
          };
          const engine = new SolidRdfEngine({ index: { path: ${JSON.stringify(path.join(directory, 'rdf.sqlite'))} },
            operationService: operations, nativeSparqlClient: native });
          await engine.open();
          initializing = false;
          const freshness = () => { state.started = true; return Promise.reject(new Error('Root freshness caller failed while actual file reader remains live')); };
          engine.setAuthorityFreshnessProvider({ assertFresh: freshness, assertFreshSync: freshness });
          engine.sparqlQuery('ASK {}', { basePath: ${JSON.stringify(sourceRoot)} })
            .then(() => undefined, () => { state.rejected = true; });
        }
      `);
      const owner = spawn('bun', [ scriptFile ], { stdio: [ 'ignore', 'ignore', 'pipe' ] });
      let stderr = '';
      owner.stderr.setEncoding('utf8').on('data', (value: string) => { stderr += value; });
      let exited = false;
      const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        owner.once('error', reject);
        owner.once('close', (code, signal) => { exited = true; resolve({ code, signal }); });
      });
      try {
        const first = await stateBarrier(stateFile, state => state.started && state.rejected && state.reads > 0);
        expect(first.pid).toBe(owner.pid);
        expect(first.nativeRequests, 'freshness refusal must precede actual query start').toBe(0);
        expect(() => process.kill(first.pid, 0), stderr).not.toThrow();
        expect(authoritySqlitePeerAdmission('node', first.databasePath), 'caller rejection cannot release live work').toBe(false);
        await writeFile(settleFile, 'settle caller only\n');
        const after = await stateBarrier(stateFile, state => state.settled && state.reads > first.reads + 2);
        expect(after.newCallbacks).toBe(0);
        expect(after.closeSucceeded).toBe(false);
        expect(authoritySqlitePeerAdmission('bun', after.databasePath), 'settled caller is not actual producer drain').toBe(false);
        expect(() => process.kill(first.pid, 0)).not.toThrow();
        owner.kill('SIGKILL'); // Only this directly owned process, which has no descendant producer.
        expect(await exit).toEqual({ code: null, signal: 'SIGKILL' });
        expect(() => process.kill(first.pid, 0), 'actual owner must be reaped').toThrow();
        expect(authoritySqlitePeerAdmission('node', after.databasePath)).toBe(true);
      } finally {
        if (!exited) owner.kill('SIGKILL');
        await exit;
        await rm(directory, { recursive: true, force: true });
      }
    }, 30000,
  );
});
