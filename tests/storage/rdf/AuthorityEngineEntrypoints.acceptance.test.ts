// Root-owned public Engine qualification. Worker must not edit this oracle.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { DataFactory } from 'n3';
import { describe, expect, it, vi } from 'vitest';
import { LocalPhysicalOperationService } from '../../../src/storage/LocalPhysicalOperationService';
import { RdfQueryExecutor } from '../../../src/storage/rdf/RdfQueryExecutor';
import { SolidRdfEngine } from '../../../src/storage/rdf/SolidRdfEngine';
import { authoritySqlitePeerAdmission } from '../../helpers/AuthoritySqlitePeer';

const { namedNode, literal, quad } = DataFactory;
const source = { source: 'https://root.invalid/alice/messages.ttl', workspace: 'https://root.invalid/alice/' };
const graph = namedNode(source.source);
const statement = quad(namedNode(`${source.source}#msg-id`), namedNode('urn:root:entrypoint'), literal('retained'), graph);
const next = { ...source, source: `${source.workspace}moved.ttl` };
const vectorChunk = { chunkKey: 'chunk', ordinal: 0, level: 0, embedding: [ 1, 0 ], content: 'retained', startOffset: 0, endOffset: 8 };

async function startOwner(runtime: 'bun' | 'node', databasePath: string): Promise<{ release: () => Promise<void> }> {
  const open = runtime === 'bun'
    ? "new (require('bun:sqlite').Database)(process.argv[1])"
    : "new (require('node:sqlite').DatabaseSync)(process.argv[1])";
  const child: ChildProcess = spawn(runtime, [ '-e', `
    const db = ${open};
    db.exec('PRAGMA busy_timeout = 0');
    db.exec('BEGIN IMMEDIATE');
    process.on('message', message => {
      if (message !== 'release') return;
      db.exec('ROLLBACK'); db.close(); process.disconnect();
    });
    process.send('held');
  `, databasePath ], { stdio: [ 'ignore', 'ignore', 'pipe', 'ipc' ] });
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr = `${stderr}${String(chunk)}`.slice(-4000); });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  const isLive = (): boolean => child.exitCode === null && child.signalCode === null;
  const reap = async (): Promise<void> => {
    if (isLive() && child.connected) { child.send('release'); }
    const timer = setTimeout(() => { if (isLive()) { child.kill('SIGKILL'); } }, 5000);
    try { await closed; } finally { clearTimeout(timer); }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Own SQLite owner readiness timed out')), 5000);
      const onMessage = (message: unknown): void => { if (message === 'held') { finish(); } };
      const onError = (error: Error): void => finish(error);
      const onClose = (): void => finish(new Error(`Own SQLite owner exited before readiness: ${stderr}`));
      function finish(error?: Error): void {
        clearTimeout(timer);
        child.removeListener('message', onMessage);
        child.removeListener('error', onError);
        child.removeListener('close', onClose);
        if (error) { reject(error); } else { resolve(); }
      }
      child.on('message', onMessage);
      child.once('error', onError);
      child.once('close', onClose);
    });
  } catch (error) { await reap(); throw error; }
  return { release: async () => {
    await reap();
    expect(child.signalCode, stderr).toBeNull();
    expect(child.exitCode, stderr).toBe(0);
  } };
}

type Entry = { name: string; index: 'facts' | 'text' | 'vector' | 'executor'; method: string; invoke: (engine: SolidRdfEngine) => unknown };
const entries: Entry[] = [
  { name: 'put', index: 'facts', method: 'multiPut', invoke: engine => engine.put(statement) },
  { name: 'replaceSource', index: 'facts', method: 'replaceSource', invoke: engine => engine.replaceSource([ statement ], source) },
  { name: 'deleteSource', index: 'facts', method: 'deleteSource', invoke: engine => engine.deleteSource(source.source) },
  { name: 'moveSource', index: 'facts', method: 'moveSource', invoke: engine => engine.moveSource(source.source, next) },
  { name: 'delete', index: 'facts', method: 'delete', invoke: engine => engine.delete({ graph }) },
  { name: 'applyDelta', index: 'facts', method: 'applyDelta', invoke: engine => engine.applyDelta([ { graph } ], [ statement ]) },
  { name: 'rewriteTerms', index: 'facts', method: 'rewriteTerms', invoke: engine => engine.rewriteTerms({ oldPrefix: source.source, newPrefix: next.source, scope: 'source' }) },
  { name: 'scan', index: 'facts', method: 'scan', invoke: engine => engine.scan({ pattern: { graph } }) },
  { name: 'query', index: 'executor', method: 'query', invoke: engine => engine.query({ patterns: [ { graph } ] }) },
  { name: 'refreshDerivedIndexes', index: 'facts', method: 'dataVersion', invoke: engine => engine.refreshDerivedIndexes() },
  { name: 'indexTextSource', index: 'text', method: 'indexText', invoke: engine => engine.indexTextSource(source, 'retained') },
  { name: 'deleteTextSource', index: 'text', method: 'deleteSource', invoke: engine => engine.deleteTextSource(source.source) },
  { name: 'moveTextSource', index: 'text', method: 'moveSource', invoke: engine => engine.moveTextSource(source.source, next) },
  { name: 'listTextSources', index: 'text', method: 'listSources', invoke: engine => engine.listTextSources() },
  { name: 'searchText', index: 'text', method: 'search', invoke: engine => engine.searchText('retained') },
  { name: 'listTextSourceChunks', index: 'text', method: 'listSourceChunks', invoke: engine => engine.listTextSourceChunks(source.source) },
  { name: 'indexVectorSource', index: 'vector', method: 'indexVector', invoke: engine => engine.indexVectorSource(source, [ vectorChunk ]) },
  { name: 'deleteVectorSource', index: 'vector', method: 'deleteSource', invoke: engine => engine.deleteVectorSource(source.source) },
  { name: 'moveVectorSource', index: 'vector', method: 'moveSource', invoke: engine => engine.moveVectorSource(source.source, next) },
  { name: 'searchVector', index: 'vector', method: 'search', invoke: engine => engine.searchVector({ embedding: [ 1, 0 ] }) },
  { name: 'supportsPrimary', index: 'facts', method: 'scan', invoke: engine => engine.supportsPrimary({ pattern: { graph } }) },
  { name: 'storageStats', index: 'facts', method: 'stats', invoke: engine => engine.storageStats() },
];

describe.each([ 'bun', 'node' ] as const)('public Engine admission with actual %s owner', runtime => {
  it.each(entries)('$name refuses before execution, then succeeds after actual owner release', async entry => {
    const parent = path.resolve('.test-data/authority-engine-entrypoints');
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(path.join(parent, 'root-'));
    const operations = new LocalPhysicalOperationService(directory);
    const engine = new SolidRdfEngine({
      operationService: operations,
      index: { path: path.join(directory, 'facts.sqlite') },
      textIndex: { path: path.join(directory, 'text.sqlite') },
      vectorIndex: { path: path.join(directory, 'vector.sqlite') },
    });
    let owner: Awaited<ReturnType<typeof startOwner>> | undefined;
    let restore: (() => void) | undefined;
    try {
      await engine.open();
      engine.replaceSource([ statement ], source);
      engine.indexTextSource(source, 'retained');
      engine.indexVectorSource(source, [ vectorChunk ]);
      const target = entry.index === 'facts' ? engine.index : entry.index === 'text' ? engine.textIndex
        : entry.index === 'vector' ? engine.vectorIndex : RdfQueryExecutor.prototype;
      const observed = vi.spyOn(target as unknown as Record<string, (...args: unknown[]) => unknown>, entry.method);
      restore = () => observed.mockRestore();
      owner = await startOwner(runtime, operations.databasePath);
      expect(authoritySqlitePeerAdmission(runtime, operations.databasePath)).toBe(false);
      let error: unknown;
      try { entry.invoke(engine); } catch (caught) { error = caught; }
      expect(error, 'a peer-held physical domain must refuse, including capability introspection').toMatchObject({ statusCode: 503 });
      expect(observed, 'refusal must precede actual index/executor work').not.toHaveBeenCalled();
      await owner.release();
      owner = undefined;
      expect(authoritySqlitePeerAdmission(runtime, operations.databasePath)).toBe(true);
      expect(() => entry.invoke(engine), 'healthy idle synchronous entrypoint must remain usable').not.toThrow();
      expect(observed).toHaveBeenCalled();
      if (entry.name === 'supportsPrimary') { expect(entry.invoke(engine)).toBe(true); }
    } finally {
      try { await owner?.release(); } finally {
        restore?.();
        await engine.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  }, 30_000);
});
