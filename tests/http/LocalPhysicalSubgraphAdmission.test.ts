// Own real HTTP/SQLite/file boundary with a declared ASK/identity adapter, not production QLever or DPoP.
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, get } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { BasicRepresentation, GreedyReadWriteLocker, IdentifierMap, MemoryMapStorage, MemoryResourceLocker,
  PermissionBasedAuthorizer, SingleRootIdentifierStrategy, arrayifyStream, guardStream } from '@solid/community-server';
import type { AuxiliaryIdentifierStrategy, CredentialsExtractor, PermissionReader, PermissionReaderInput, ResourceStore } from '@solid/community-server';
import { PERMISSIONS } from '@solidlab/policy-engine';
import { DataFactory } from 'n3';
import { expect, it } from 'vitest';
import { SubgraphSparqlHttpHandler } from '../../src/http/SubgraphSparqlHttpHandler';
import { LocalPhysicalOperationService } from '../../src/storage/LocalPhysicalOperationService';
import { LockingResourceStore } from '../../src/storage/LockingResourceStore';
import { HierarchicalReadWriteLocker } from '../../src/storage/HierarchicalReadWriteLocker';
import { SolidRdfEngine } from '../../src/storage/rdf/SolidRdfEngine';
import { SubgraphQueryEngine, type SparqlEngine } from '../../src/storage/sparql/SubgraphQueryEngine';

function barrier() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function peer(database: string): boolean {
  const child = spawnSync('node', ['-e', `const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);let admitted=false;
  try{db.exec('PRAGMA busy_timeout=0');try{db.exec('BEGIN IMMEDIATE');admitted=true;db.exec('ROLLBACK')}catch(e){if(!/busy|locked/i.test(e.message))throw e}}finally{db.close()}process.stdout.write(JSON.stringify(admitted))`, database], { encoding: 'utf8', timeout: 5000 });
  expect(child.status, child.stderr).toBe(0); return JSON.parse(child.stdout);
}

it('public Subgraph admission precedes permission and excludes an actual direct Store file writer until authorization/query completes', async () => {
  await mkdir('.test-data/local-subgraph-admission', { recursive: true });
  const directory = await mkdtemp(path.resolve('.test-data/local-subgraph-admission/own-'));
  const operations = new LocalPhysicalOperationService(path.join(directory, 'data'));
  const engine = new SolidRdfEngine({ operationService: operations, index: { path: path.join(directory, 'facts.sqlite') } });
  const entered = barrier(); const allowed = barrier(); const base = 'http://own.invalid/';
  const graph = DataFactory.namedNode(`${base}alice/document.ttl`); const query = { patterns: [{ graph }] };
  const file = path.join(directory, 'authority.ttl'); await writeFile(file, 'before'); let writes = 0;
  const locker = new HierarchicalReadWriteLocker(new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage<number>()), new SingleRootIdentifierStrategy(base));
  const auxiliary = { isAuxiliaryIdentifier: () => false, getSubjectIdentifier: (id: { path: string }) => id } as unknown as AuxiliaryIdentifierStrategy;
  const store = new LockingResourceStore({ setRepresentation: async (_id: unknown, representation: BasicRepresentation) => {
    writes++; expect(peer(operations.databasePath)).toBe(false);
    const chunks = await arrayifyStream(representation.data); await writeFile(file, chunks.join('')); return new Map();
  } } as unknown as ResourceStore, locker, auxiliary, { operationService: operations });
  const impl = { queryBoolean: async () => engine.query(query).bindings.length > 0,
    listGraphs: async () => new Set<string>() } as unknown as SparqlEngine;
  const credentials = { handleSafe: async () => ({ agent: { webId: `${base}profile#me` } }) } as unknown as CredentialsExtractor;
  const permission = { handleSafe: async (input: PermissionReaderInput) => {
    expect(peer(operations.databasePath)).toBe(false); expect(engine.query(query).bindings).toHaveLength(1);
    entered.resolve(); await allowed.promise;
    return new IdentifierMap([...input.requestedModes.entrySets()].map(([id]) => [id, { [PERMISSIONS.Read]: true }] as const));
  } } as unknown as PermissionReader;
  const handler = new SubgraphSparqlHttpHandler(new SubgraphQueryEngine(impl), credentials, permission, new PermissionBasedAuthorizer(), {},
    undefined, undefined, locker, undefined, store, undefined, undefined, undefined, operations);
  const completions: Promise<void>[] = [];
  const server = createServer((request, response) => {
    completions.push(handler.handleSafe({ request: guardStream(request), response }).catch(error => { response.destroy(error); throw error; }));
  });
  let writing: Promise<unknown> | undefined;
  try {
    await engine.open(); engine.replaceSource([DataFactory.quad(DataFactory.namedNode(`${graph.value}#item`), DataFactory.namedNode('urn:own:name'), DataFactory.literal('seed'), graph)], { source: graph.value, workspace: base });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') { throw new Error('Own HTTP fixture has no port'); }
    const result = new Promise<string>((resolve, reject) => {
      get(`http://127.0.0.1:${address.port}/alice/-/sparql?query=${encodeURIComponent('ASK {}')}`, response => {
        let body = ''; response.on('data', chunk => { body += String(chunk); }); response.once('end', () => resolve(body)); response.once('error', reject);
      }).once('error', reject);
    });
    await entered.promise;
    writing = store.setRepresentation({ path: graph.value }, new BasicRepresentation(Readable.from(['after']), 'text/plain'));
    await new Promise(resolve => setTimeout(resolve, 20)); expect(writes).toBe(0); expect(await readFile(file, 'utf8')).toBe('before');
    expect(peer(operations.databasePath)).toBe(false); allowed.resolve();
    expect(JSON.parse(await result).boolean).toBe(true); await writing; await Promise.all(completions);
    expect(writes).toBe(1); expect(await readFile(file, 'utf8')).toBe('after'); expect(peer(operations.databasePath)).toBe(true);
  } finally { allowed.resolve(); await writing?.catch(() => undefined); await Promise.allSettled(completions);
    await new Promise<void>(resolve => server.close(() => resolve())); await engine.close(); await rm(directory, { recursive: true, force: true }); }
}, 15000);
