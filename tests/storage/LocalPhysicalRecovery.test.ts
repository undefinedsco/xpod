import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AtomicFileDataAccessor, ExtensionBasedMapper, FileDataAccessor, SingleRootIdentifierStrategy } from '@solid/community-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalPhysicalOperationService } from '../../src/storage/LocalPhysicalOperationService';
import { SolidRdfEngine } from '../../src/storage/rdf/SolidRdfEngine';
import { SolidRdfDataAccessor } from '../../src/storage/accessors/SolidRdfDataAccessor';
import { MixDataAccessor } from '../../src/storage/accessors/MixDataAccessor';
import { RootedSolidFsSyncJournal } from '../../src/solidfs/SolidFsSyncJournal';
import { LocalRdfAuthorityRecoveryInitializer } from '../../src/solidfs/LocalRdfAuthorityRecoveryInitializer';

function peer(database: string): boolean {
  const child = spawnSync('bun', ['-e', `const{Database}=require('bun:sqlite');const db=new Database(process.argv[1]);let admitted=false;
    try{db.exec('PRAGMA busy_timeout=0');try{db.exec('BEGIN IMMEDIATE');admitted=true;db.exec('ROLLBACK')}catch(e){if(!/busy|locked/i.test(e.message))throw e}}finally{db.close()}process.stdout.write(JSON.stringify(admitted))`, database], { encoding: 'utf8', timeout: 5000 });
  expect(child.error).toBeUndefined(); expect(child.status, child.stderr).toBe(0); return JSON.parse(child.stdout);
}

describe('Local retained-file recovery with actual SQLite facts and file authority', () => {
  let directory: string; let root: string; let engine: SolidRdfEngine; let service: LocalPhysicalOperationService;
  let journal: RootedSolidFsSyncJournal; let initializer: LocalRdfAuthorityRecoveryInitializer;
  let rdfFile: string; let files: AtomicFileDataAccessor;
  const base = 'https://own.invalid/';
  const resource = `${base}alice/notes.ttl`;
  beforeEach(async () => {
    await mkdir('.test-data/local-physical-recovery', { recursive: true });
    directory = await mkdtemp(path.resolve('.test-data/local-physical-recovery/own-')); root = path.join(directory, 'data');
    rdfFile = path.join(root, 'alice', 'notes.ttl'); await mkdir(path.dirname(rdfFile), { recursive: true });
    await writeFile(rdfFile, '<#note> <https://schema.org/name> "retained" .\n');
    service = new LocalPhysicalOperationService(root);
    engine = new SolidRdfEngine({ index: { path: path.join(directory, 'facts.sqlite') }, operationService: service });
    const mapper = new ExtensionBasedMapper(base, root);
    files = new AtomicFileDataAccessor(mapper, root + path.sep, path.join(root, '.internal', 'tempFiles') + path.sep);
    journal = new RootedSolidFsSyncJournal(root, directory, service);
    const structured = new SolidRdfDataAccessor(engine, new SingleRootIdentifierStrategy(base), service);
    const mix = new MixDataAccessor(structured, new FileDataAccessor(mapper), false, true, files, false, mapper, journal, undefined, service);
    initializer = new LocalRdfAuthorityRecoveryInitializer(journal, mix, mapper, base, root, service, engine);
  });
  afterEach(async () => { vi.restoreAllMocks(); await initializer.finalize(); await rm(directory, { recursive: true, force: true }); });

  function pending() {
    return journal.recordAuthorityPending({ path: 'alice/notes.ttl', resource, sourcePath: rdfFile,
      contentType: 'text/turtle', source: 'filesystem', projection: 'direct', type: 'updated', sourceVersion: 'same-content' },
    { workspace: base, cwd: root, projection: 'direct', entries: [] }, 'same-content');
  }

  it('rebuilds real facts under the existing admission without replacing the retained file', async () => {
    const token = pending(); const before = await stat(rdfFile); const bytes = await readFile(rdfFile);
    const write = vi.spyOn(files, 'writeDocument');
    const original = engine.replaceSource.bind(engine);
    const replace = vi.spyOn(engine, 'replaceSource').mockImplementation((quads, source) => {
      expect(peer(service.databasePath)).toBe(false);
      expect(service.runSync(() => true)).toBe(true);
      original(quads, source);
    });
    await initializer.handle();
    expect(replace).toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
    expect(journal.listAuthorityPending().some(op => op.id === token.id)).toBe(false);
    expect(engine.query({ patterns: [] }).bindings.length).toBeGreaterThan(0);
    const after = await stat(rdfFile); expect(after.ino).toBe(before.ino); expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(rdfFile)).toEqual(bytes); expect(peer(service.databasePath)).toBe(true);
  });

  it('clears only the exact rebuilt token and refuses startup when a newer attempt remains', async () => {
    const old = pending(); let newer: string | undefined;
    const original = engine.replaceSource.bind(engine);
    vi.spyOn(engine, 'replaceSource').mockImplementation((quads, source) => {
      if (!newer) { newer = pending().id; }
      original(quads, source);
    });
    await expect(initializer.handle()).rejects.toThrow('pending operations');
    const tokens = journal.listAuthorityPending().map(op => op.id);
    expect(tokens).not.toContain(old.id); expect(tokens).toContain(newer);
    expect(peer(service.databasePath)).toBe(true);
  });
});
