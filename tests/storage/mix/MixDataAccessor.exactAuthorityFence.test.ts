// Narrow regression for the prepared-delta authority fence. B59 removed the pre-existing
// `baseIri` directory fence; B60 restores it and keeps the exact-resource fence added inside
// `writeLocalRdfAuthorityPatches`. So both are active: the outer `baseIri` mutation covers
// prepare/persist/rollback (and still runs for an empty delta), while the exact written resource is
// additionally invalidated across file/index/journal/rollback. Actual Mix/FileDataAccessor/
// SolidRdfDataAccessor real files + SQLite index; only the native prepared delta is substituted.
// This does not prove native WHERE evaluation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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

describe('prepared delta authority fence (outer baseIri + exact resource)', () => {
  let directory: string;
  let base: string;
  let first: { path: string };
  let second: { path: string };
  let unrelated: { path: string };
  let files: FileDataAccessor;
  let structured: SolidRdfDataAccessor;
  let accessor: MixDataAccessor;

  beforeEach(async () => {
    const root = path.resolve('.test-data/mix-exact-fence');
    await mkdir(root, { recursive: true });
    directory = await mkdtemp(path.join(root, 'run-'));
    const origin = 'https://generation.invalid/';
    base = `${origin}${randomUUID()}/`;
    first = { path: `${base}first.ttl.acl` };
    second = { path: `${base}second.ttl.acl` };
    unrelated = { path: `${base}private.ttl.acl` };
    const mapper = new ExtensionBasedMapper(origin, path.join(directory, 'data'));
    files = new FileDataAccessor(mapper);
    structured = new SolidRdfDataAccessor(new SolidRdfEngine({ index: { path: path.join(directory, 'rdf.sqlite') } }), new Identifiers(origin));
    accessor = new MixDataAccessor(structured, files);

    for (const identifier of [ first, second, unrelated ]) {
      const metadata = new RepresentationMetadata(identifier);
      metadata.contentType = 'internal/quads';
      const quad = DataFactory.quad(
        DataFactory.namedNode(`${identifier.path}#owner`),
        DataFactory.namedNode('http://www.w3.org/ns/auth/acl#mode'),
        DataFactory.namedNode('http://www.w3.org/ns/auth/acl#Control'),
      );
      await accessor.writeDocument(identifier, guardStream(Readable.from([ quad ])), metadata);
    }
  });

  afterEach(async() => {
    vi.restoreAllMocks();
    await structured?.finalize();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  function deltaFor(identifier: { path: string }) {
    const graph = DataFactory.namedNode(identifier.path);
    return {
      graphIri: identifier.path,
      sourceUri: identifier.path,
      deletes: [ DataFactory.quad(
        DataFactory.namedNode(`${identifier.path}#owner`),
        DataFactory.namedNode('http://www.w3.org/ns/auth/acl#mode'),
        DataFactory.namedNode('http://www.w3.org/ns/auth/acl#Control'),
        graph,
      ) ],
      inserts: [ DataFactory.quad(
        DataFactory.namedNode(`${identifier.path}#owner`),
        DataFactory.namedNode('http://www.w3.org/ns/auth/acl#mode'),
        DataFactory.namedNode('http://www.w3.org/ns/auth/acl#Read'),
        graph,
      ) ],
    };
  }

  function executeFor(identifiers: { path: string }[]) {
    vi.spyOn(structured, 'prepareSparqlUpdate').mockResolvedValue({
      version: 1,
      graphs: identifiers.map(deltaFor),
    });
    return accessor.executeSparqlUpdate('PREPARED DELTA SUBSTITUTE', base, {
      basePath: base,
      mode: 'read',
      allowedGraphUrls: identifiers.map(identifier => identifier.path),
    });
  }

  it('keeps the outer baseIri fence active across file/index while also invalidating the exact ACL', async() => {
    const baseSnapshot = authorityResourceTracker.snapshot(base);
    const firstSnapshot = authorityResourceTracker.snapshot(first.path);
    const unrelatedSnapshot = authorityResourceTracker.snapshot(unrelated.path);

    const observations: { phase: string; baseActive: boolean; baseFresh: boolean; exactActive: boolean; exactFresh: boolean }[] = [];
    const observe = (phase: string) => {
      observations.push({
        phase,
        baseActive: authorityResourceTracker.snapshot(base).active,
        baseFresh: authorityResourceTracker.isFresh(base, baseSnapshot),
        exactActive: authorityResourceTracker.snapshot(first.path).active,
        exactFresh: authorityResourceTracker.isFresh(first.path, firstSnapshot),
      });
    };
    const originalFileWrite = files.writeDocument.bind(files);
    vi.spyOn(files, 'writeDocument').mockImplementation(async (...args) => {
      if (args[0].path === first.path) observe('file');
      return originalFileWrite(...args);
    });
    const originalIndexWrite = structured.writeRdfSourceDocument.bind(structured);
    vi.spyOn(structured, 'writeRdfSourceDocument').mockImplementation(async (...args) => {
      if (args[0].path === first.path) observe('index');
      return originalIndexWrite(...args);
    });

    await executeFor([ first ]);

    // Both fences are active through the file and index writes.
    expect(observations.map(item => item.phase)).toEqual([ 'file', 'index' ]);
    expect(observations.every(item => item.baseActive && !item.baseFresh)).toBe(true);
    expect(observations.every(item => item.exactActive && !item.exactFresh)).toBe(true);

    // After settling both are stale and quiescent; the unrelated sibling is untouched.
    expect(authorityResourceTracker.snapshot(base).active).toBe(false);
    expect(authorityResourceTracker.snapshot(base).generation).toBe(baseSnapshot.generation + 1);
    expect(authorityResourceTracker.isFresh(base, baseSnapshot)).toBe(false);
    expect(authorityResourceTracker.snapshot(first.path).active).toBe(false);
    expect(authorityResourceTracker.snapshot(first.path).generation).toBe(firstSnapshot.generation + 1);
    expect(authorityResourceTracker.isFresh(first.path, firstSnapshot)).toBe(false);
    expect(authorityResourceTracker.isFresh(unrelated.path, unrelatedSnapshot)).toBe(true);
  });

  it('tracks every distinct written resource and leaves a third untouched', async() => {
    const baseSnapshot = authorityResourceTracker.snapshot(base);
    const firstSnapshot = authorityResourceTracker.snapshot(first.path);
    const secondSnapshot = authorityResourceTracker.snapshot(second.path);
    const unrelatedSnapshot = authorityResourceTracker.snapshot(unrelated.path);
    await executeFor([ first, second ]);
    expect(authorityResourceTracker.snapshot(base).generation).toBe(baseSnapshot.generation + 1);
    expect(authorityResourceTracker.snapshot(first.path).generation).toBe(firstSnapshot.generation + 1);
    expect(authorityResourceTracker.snapshot(second.path).generation).toBe(secondSnapshot.generation + 1);
    expect(authorityResourceTracker.isFresh(unrelated.path, unrelatedSnapshot)).toBe(true);
  });

  it('registers a duplicate patch URI exactly once', async() => {
    const begin = vi.spyOn(authorityResourceTracker, 'beginMutation');
    const end = vi.spyOn(authorityResourceTracker, 'endMutation');
    // Two graph deltas referring to the same source resource must be one exact authority mutation.
    await executeFor([ first, first ]);
    const beginsForFirst = begin.mock.calls.filter(([ uri ]) => uri === first.path);
    const endsForFirst = end.mock.calls.filter(([ uri ]) => uri === first.path);
    expect(beginsForFirst).toHaveLength(1);
    expect(endsForFirst).toHaveLength(1);
    // The legacy outer fence still runs exactly once for the scope directory.
    expect(begin.mock.calls.filter(([ uri ]) => uri === base)).toHaveLength(1);
    expect(authorityResourceTracker.snapshot(first.path).active).toBe(false);
  });

  it('retains the legacy outer fence for an empty delta with no exact mutation or file write', async() => {
    const baseSnapshot = authorityResourceTracker.snapshot(base);
    const firstSnapshot = authorityResourceTracker.snapshot(first.path);
    const write = vi.spyOn(files, 'writeDocument');
    const indexWrite = vi.spyOn(structured, 'writeRdfSourceDocument');

    await executeFor([]);

    // The outer baseIri fence still ran and is now stale.
    expect(authorityResourceTracker.snapshot(base).generation).toBe(baseSnapshot.generation + 1);
    expect(authorityResourceTracker.snapshot(base).active).toBe(false);
    expect(authorityResourceTracker.isFresh(base, baseSnapshot)).toBe(false);
    // No exact resource was invalidated and nothing was written.
    expect(authorityResourceTracker.isFresh(first.path, firstSnapshot)).toBe(true);
    expect(write).not.toHaveBeenCalled();
    expect(indexWrite).not.toHaveBeenCalled();
  });
});
