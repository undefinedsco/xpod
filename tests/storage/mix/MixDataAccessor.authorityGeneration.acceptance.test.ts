// Actual Mix persistence, file and RDF-index paths with a prepared-delta substitute.
// This proves authority invalidation; it does not prove native WHERE evaluation or multi-CSS safety.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { BaseIdentifierStrategy, ExtensionBasedMapper, FileDataAccessor, RepresentationMetadata, guardStream } from '@solid/community-server';
import { DataFactory } from 'n3';
import { MixDataAccessor } from '../../../src/storage/accessors/MixDataAccessor';
import { SolidRdfDataAccessor } from '../../../src/storage/accessors/SolidRdfDataAccessor';
import { SolidRdfEngine } from '../../../src/storage/rdf';
import { authorityResourceTracker } from '../../../src/storage/AuthorityResourceTracker';

class Identifiers extends BaseIdentifierStrategy {
  public constructor(private readonly root: string) { super(); }
  public supportsIdentifier(identifier: { path: string }): boolean { return identifier.path.startsWith(this.root); }
  public isRootContainer(identifier: { path: string }): boolean { return identifier.path === this.root; }
}

describe('independent prepared authority-resource invalidation', () => {
  let directory: string;
  let base: string;
  let acl: { path: string };
  let files: FileDataAccessor;
  let structured: SolidRdfDataAccessor;
  let accessor: MixDataAccessor;
  let aclFile: string;
  let beforeText: string;
  let oldSnapshot: ReturnType<typeof authorityResourceTracker.snapshot>;
  let observations: { phase: string; active: boolean; fresh: boolean }[];

  beforeEach(async () => {
    const root = path.resolve('.test-data/mix-authority-generation');
    await mkdir(root, { recursive: true });
    directory = await mkdtemp(path.join(root, 'run-'));
    base = `https://generation.invalid/${randomUUID()}/`;
    acl = { path: `${base}.acl` };
    const origin = 'https://generation.invalid/';
    const mapper = new ExtensionBasedMapper(origin, path.join(directory, 'data'));
    files = new FileDataAccessor(mapper);
    structured = new SolidRdfDataAccessor(new SolidRdfEngine({ index: { path: path.join(directory, 'rdf.sqlite') } }), new Identifiers(origin));
    accessor = new MixDataAccessor(structured, files);
    const { quad, namedNode } = DataFactory;
    const subject = namedNode(`${acl.path}#owner`);
    const predicate = namedNode('http://www.w3.org/ns/auth/acl#mode');
    const oldQuad = quad(subject, predicate, namedNode('http://www.w3.org/ns/auth/acl#Control'));
    const newQuad = quad(subject, predicate, namedNode('http://www.w3.org/ns/auth/acl#Read'));
    const metadata = new RepresentationMetadata(acl);
    metadata.contentType = 'internal/quads';
    await accessor.writeDocument(acl, guardStream(Readable.from([ oldQuad ])), metadata);
    aclFile = (await mapper.mapUrlToFilePath(acl, false, 'text/turtle')).filePath;
    beforeText = await readFile(aclFile, 'utf8');
    oldSnapshot = authorityResourceTracker.snapshot(acl.path);
    const graph = namedNode(acl.path);
    vi.spyOn(structured, 'prepareSparqlUpdate').mockResolvedValue({
      version: 1, graphs: [{ graphIri: acl.path, sourceUri: acl.path,
        deletes: [ quad(oldQuad.subject, oldQuad.predicate, oldQuad.object, graph) ],
        inserts: [ quad(newQuad.subject, newQuad.predicate, newQuad.object, graph) ],
      }],
    });
    observations = [];
    const originalFileWrite = files.writeDocument.bind(files);
    vi.spyOn(files, 'writeDocument').mockImplementation(async (...args) => {
      if (args[0].path === acl.path) observe('file');
      return originalFileWrite(...args);
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await structured?.finalize();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  function observe(phase: string) {
    observations.push({ phase, active: authorityResourceTracker.snapshot(acl.path).active,
      fresh: authorityResourceTracker.isFresh(acl.path, oldSnapshot) });
  }
  const execute = () => accessor.executeSparqlUpdate('PREPARED DELTA SUBSTITUTE', base, {
    basePath: base, mode: 'read', allowedGraphUrls: [ acl.path ],
  });

  it('invalidates the exact ACL before file/index changes and leaves unrelated authority fresh', async () => {
    const unrelated = `${base}private.ttl.acl`;
    const unrelatedSnapshot = authorityResourceTracker.snapshot(unrelated);
    const originalIndexWrite = structured.writeRdfSourceDocument.bind(structured);
    vi.spyOn(structured, 'writeRdfSourceDocument').mockImplementation(async (...args) => {
      if (args[0].path === acl.path) observe('index');
      return originalIndexWrite(...args);
    });
    await execute();
    expect(observations.map(item => item.phase)).toEqual([ 'file', 'index' ]);
    expect(observations.every(item => item.active && !item.fresh)).toBe(true);
    expect(authorityResourceTracker.snapshot(acl.path).active).toBe(false);
    expect(authorityResourceTracker.isFresh(acl.path, oldSnapshot)).toBe(false);
    expect(authorityResourceTracker.isFresh(unrelated, unrelatedSnapshot)).toBe(true);
    const text = await readFile(aclFile, 'utf8');
    expect(text).toContain('http://www.w3.org/ns/auth/acl#Read');
    expect(text).not.toContain('http://www.w3.org/ns/auth/acl#Control');
  });

  it('keeps exact authority active through rollback and settles invalid after failure', async () => {
    let first = true;
    const originalIndexWrite = structured.writeRdfSourceDocument.bind(structured);
    vi.spyOn(structured, 'writeRdfSourceDocument').mockImplementation(async (...args) => {
      if (args[0].path === acl.path) {
        observe(first ? 'failed-index' : 'rollback-index');
        if (first) { first = false; throw new Error('injected index failure'); }
      }
      return originalIndexWrite(...args);
    });
    await expect(execute()).rejects.toThrow('injected index failure');
    expect(observations.map(item => item.phase)).toEqual([ 'file', 'failed-index', 'file', 'rollback-index' ]);
    expect(observations.every(item => item.active && !item.fresh)).toBe(true);
    expect(authorityResourceTracker.snapshot(acl.path).active).toBe(false);
    expect(authorityResourceTracker.isFresh(acl.path, oldSnapshot)).toBe(false);
    expect(await readFile(aclFile, 'utf8')).toBe(beforeText);
  });

  it('does not invalidate an ACL when a prepared condition produces no changed graph', async () => {
    vi.mocked(structured.prepareSparqlUpdate).mockResolvedValue({ version: 1, graphs: [] });
    await execute();
    expect(observations).toEqual([]);
    expect(authorityResourceTracker.isFresh(acl.path, oldSnapshot)).toBe(true);
    expect(await readFile(aclFile, 'utf8')).toBe(beforeText);
  });
});
