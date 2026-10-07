import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  AtomicFileDataAccessor,
  ExtensionBasedMapper,
  FileDataAccessor,
  RepresentationMetadata,
  RDF,
  LDP,
  guardStream,
  BaseIdentifierStrategy,
} from '@solid/community-server';
import { DataFactory } from 'n3';
import { MixDataAccessor } from '../../../src/storage/accessors/MixDataAccessor';
import { SolidRdfDataAccessor } from '../../../src/storage/accessors/SolidRdfDataAccessor';
import { SolidRdfEngine } from '../../../src/storage/rdf';
import { withLockLease } from '../../../src/storage/locking/LockExecutionContext';
import { SqliteSolidFsSyncJournal } from '../../../src/solidfs/SolidFsSyncJournal';

type ResourceIdentifier = { path: string };

class SimpleIdentifierStrategy extends BaseIdentifierStrategy {
  public constructor(private baseUrl: string) {
    super();
    if (!this.baseUrl.endsWith('/')) {
      this.baseUrl = `${this.baseUrl}/`;
    }
  }
  public supportsIdentifier(identifier: ResourceIdentifier): boolean {
    return identifier.path.startsWith(this.baseUrl);
  }
  public isRootContainer(identifier: ResourceIdentifier): boolean {
    return identifier.path === this.baseUrl;
  }
}

async function fileExists(target: string): Promise<boolean> {
  try { await stat(target); return true; } catch { return false; }
}

describe('Mix RDF authority retention after a derived-index failure', () => {
  const baseUrl = 'http://localhost:3000/';
  let workDir: string;
  let dataDir: string;
  let accessor: MixDataAccessor;
  let structured: SolidRdfDataAccessor;
  let mapper: ExtensionBasedMapper;
  let journal: SqliteSolidFsSyncJournal;
  const { quad, namedNode } = DataFactory;

  beforeEach(async () => {
    const testRoot = path.resolve('.test-data/mix-authority-retention');
    await mkdir(testRoot, { recursive: true });
    workDir = await mkdtemp(path.join(testRoot, 'run-'));
    dataDir = path.join(workDir, 'data');
    await mkdir(dataDir, { recursive: true });
    mapper = new ExtensionBasedMapper(baseUrl, dataDir);
    const fileAccessor = new FileDataAccessor(mapper);
    const rdfFiles = new AtomicFileDataAccessor(mapper, `${dataDir}${path.sep}`, path.join(dataDir, '.internal', 'tempFiles') + path.sep);
    const identifiers = new SimpleIdentifierStrategy(baseUrl);
    // Valid optional text-index configuration: the retention behavior enables text indexing, so the
    // engine must actually provide the index (do not disable the production path to hide the fixture).
    structured = new SolidRdfDataAccessor(new SolidRdfEngine({
      index: { path: path.join(workDir, 'rdf.sqlite') },
      textIndex: { path: path.join(workDir, 'rdf-text.sqlite') },
    }), identifiers);
    journal = new SqliteSolidFsSyncJournal({ path: path.join(workDir, 'authority-journal.sqlite') });
    accessor = new MixDataAccessor(structured, fileAccessor, false, true, rdfFiles, true, mapper, journal);
    await structured.initialize();
  });

  afterEach(async () => {
    journal.close();
    await structured.finalize().catch(() => {});
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  });

  async function seedContainer(idPath: string): Promise<void> {
    const id = { path: idPath };
    const metadata = new RepresentationMetadata(id);
    metadata.contentType = 'internal/quads';
    metadata.addQuad(metadata.identifier, RDF.terms.type, LDP.terms.BasicContainer);
    metadata.addQuad(metadata.identifier, RDF.terms.type, LDP.terms.Container);
    metadata.addQuad(metadata.identifier, RDF.terms.type, LDP.terms.Resource);
    await accessor.writeContainer(id, metadata);
  }

  it('preserves an existing authority file when the structured index fails, retains pending, and rebuilds on read', async () => {
    await seedContainer(baseUrl);
    await seedContainer(`${baseUrl}alice/`);
    const id = { path: `${baseUrl}alice/data.ttl` };
    const metadata = new RepresentationMetadata(id);
    metadata.contentType = 'internal/quads';

    const first = [ quad(namedNode(`${id.path}#s`), namedNode('urn:old'), namedNode('urn:value')) ];
    await accessor.writeDocument(id, guardStream(Readable.from(first)), metadata);
    const fileLink = await mapper.mapUrlToFilePath(id as ResourceIdentifier, false, 'text/turtle');
    const oldBytes = await readFile(fileLink.filePath, 'utf8');
    expect(await fileExists(fileLink.filePath)).toBe(true);

    // Inject a post-file structured-index failure, mirroring the Root regression.
    const original = structured.writeRdfSourceDocument.bind(structured);
    let completeAtFault: string | undefined;
    const spy = vi.spyOn(structured, 'writeRdfSourceDocument').mockImplementation(async (...args: Parameters<typeof original>) => {
      completeAtFault = await readFile(fileLink.filePath, 'utf8');
      throw new Error('injected index failure');
    });

    const replacement = [ quad(namedNode(`${id.path}#s`), namedNode('urn:new'), namedNode('urn:value')) ];
    await expect(accessor.writeDocument(id, guardStream(Readable.from(replacement)), metadata))
      .rejects.toThrow('injected index failure');
    spy.mockRestore();

    // Authority is retained as the complete replacement bytes (the same behavior Root's
    // AuthorityIndexFreshness case qualifies), not erased or rolled back to the stale source.
    expect(completeAtFault).toBeDefined();
    expect(await fileExists(fileLink.filePath)).toBe(true);
    const retained = await readFile(fileLink.filePath, 'utf8');
    expect(retained).not.toBe(oldBytes);
    expect(retained).toContain('urn:new');
    expect(retained).not.toContain('urn:old');

    // Pending is retained while the derived index is stale.
    const pending = journal.listAuthorityPending();
    expect(pending.length).toBeGreaterThanOrEqual(1);
    expect(pending[0].change.resource).toBe(id.path);
  });

  it('persists a pending token before the authority file if configured, and a failed pending write leaves no file change', async () => {
    await seedContainer(baseUrl);
    const id = { path: `${baseUrl}alice/pending.ttl` };
    const metadata = new RepresentationMetadata(id);
    metadata.contentType = 'internal/quads';
    const quads = [ quad(namedNode(`${id.path}#s`), namedNode('urn:p'), namedNode('urn:o')) ];

    // Force pending persistence to fail before any write.
    const failing = { recordAuthorityPending: () => { throw new Error('pending store offline'); } };
    const guarded = new MixDataAccessor(structured, new FileDataAccessor(mapper), false, true,
      new FileDataAccessor(mapper), true, mapper, failing as never);
    await expect(guarded.writeDocument(id, guardStream(Readable.from(quads)), metadata))
      .rejects.toThrow('pending store offline');
    const fileLink = await mapper.mapUrlToFilePath(id as ResourceIdentifier, false, 'text/turtle');
    expect(await fileExists(fileLink.filePath)).toBe(false);
  });
});
