import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  ExtensionBasedMapper,
  FileDataAccessor,
  RepresentationMetadata,
  SingleRootIdentifierStrategy,
  guardStream,
} from '@solid/community-server';
import type { FileIdentifierMapper, ResourceIdentifier } from '@solid/community-server';
import { DataFactory } from 'n3';
import { MixDataAccessor } from '../../../src/storage/accessors/MixDataAccessor';
import { SolidRdfDataAccessor } from '../../../src/storage/accessors/SolidRdfDataAccessor';
import { SolidRdfEngine } from '../../../src/storage/rdf';
import { LocalPhysicalOperationService } from '../../../src/storage/LocalPhysicalOperationService';
import { RootedSolidFsSyncJournal } from '../../../src/solidfs/SolidFsSyncJournal';
import { AuthorityETagHandler } from '../../../src/storage/AuthorityETagHandler';
import {
  DOCUMENT_VERSION_TERM,
  parseDocumentVersion,
  readDocumentVersion,
} from '../../../src/storage/rdf/DocumentVersion';
import { authoritySqlitePeerAdmission } from '../../helpers/AuthoritySqlitePeer';

/** Wraps the real mapper so an eligible sidecar-capture mapping can be faulted independently. */
class SidecarThrowingMapper implements FileIdentifierMapper {
  public constructor(
    private readonly inner: ExtensionBasedMapper,
    private readonly failPath: string,
  ) {}

  public async mapUrlToFilePath(identifier: ResourceIdentifier, isMetadata: boolean, contentType?: string):
  Promise<{ identifier: ResourceIdentifier; filePath: string; contentType?: string; isMetadata: boolean }> {
    if (isMetadata && identifier.path === this.failPath) {
      throw new Error('injected authority sidecar mapping failure');
    }
    return this.inner.mapUrlToFilePath(identifier, isMetadata, contentType);
  }

  public async mapFilePathToUrl(filePath: string, isContainer: boolean):
  Promise<{ identifier: ResourceIdentifier; filePath: string; contentType?: string; isMetadata: boolean }> {
    return this.inner.mapFilePathToUrl(filePath, isContainer);
  }
}

const OVER_CAP_BYTES = 16 * 1024 * 1024 + 4096;

describe('MixDataAccessor document-version refinement (read path)', () => {
  const baseUrl = 'https://root.invalid/';
  let directory: string;
  let root: string;
  let operations: LocalPhysicalOperationService;
  let engine: SolidRdfEngine;
  let mapper: ExtensionBasedMapper;
  let files: FileDataAccessor;
  let structured: SolidRdfDataAccessor;
  let journal: RootedSolidFsSyncJournal;
  let accessor: MixDataAccessor;
  const { quad, namedNode } = DataFactory;
  const resourcePath = `${baseUrl}alice/notes.ttl`;

  beforeEach(async () => {
    const parent = path.resolve('.test-data/mix-document-version-refinement');
    await mkdir(parent, { recursive: true });
    directory = await mkdtemp(path.join(parent, 'run-'));
    root = path.join(directory, 'authority');
    await mkdir(root);
    operations = new LocalPhysicalOperationService(root);
    engine = new SolidRdfEngine({ operationService: operations, index: { path: path.join(directory, 'facts.sqlite') } });
    mapper = new ExtensionBasedMapper(baseUrl, root);
    files = new FileDataAccessor(mapper);
    structured = new SolidRdfDataAccessor(engine, new SingleRootIdentifierStrategy(baseUrl), operations);
    journal = new RootedSolidFsSyncJournal(root, directory, operations);
    accessor = new MixDataAccessor(structured, files, false, true, files, false, mapper, journal, undefined, operations);
    await structured.initialize();
    await accessor.writeContainer({ path: baseUrl }, new RepresentationMetadata({ path: baseUrl }));
    await accessor.writeContainer({ path: `${baseUrl}alice/` }, new RepresentationMetadata({ path: `${baseUrl}alice/` }));
    const quads = [ quad(namedNode(`${resourcePath}#s`), namedNode('urn:refinement:p'), namedNode('urn:refinement:o')) ];
    const metadata = new RepresentationMetadata({ path: resourcePath });
    metadata.contentType = 'internal/quads';
    await accessor.writeDocument({ path: resourcePath }, guardStream(Readable.from(quads)), metadata);
  });

  afterEach(async () => {
    journal.close();
    await structured.finalize().catch(() => undefined);
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  });

  async function authorityFilePath(): Promise<string> {
    return (await mapper.mapUrlToFilePath({ path: resourcePath }, false, 'text/turtle')).filePath;
  }

  async function sidecarFilePath(): Promise<string> {
    return (await mapper.mapUrlToFilePath({ path: resourcePath }, true, 'text/turtle')).filePath;
  }

  async function currentToken(): Promise<string | undefined> {
    const metadata = await accessor.getMetadata({ path: resourcePath });
    return readDocumentVersion(metadata);
  }

  it('produces a sealed authority token for an eligible local Turtle document', async () => {
    const token = await currentToken();
    expect(token, 'eligible local Turtle document must be qualified').toBeDefined();
    expect(parseDocumentVersion(token!)).toBeDefined();
  });

  it('binds a relevant sidecar change into the state hash and restores on revert', async () => {
    const token0 = (await currentToken())!;
    expect(token0).toBeDefined();
    const sidecarPath = await sidecarFilePath();
    const hadSidecar = await stat(sidecarPath).then(() => true, () => false);
    const original = hadSidecar ? await readFile(sidecarPath) : undefined;

    await writeFile(sidecarPath, Buffer.concat([ original ?? Buffer.alloc(0), Buffer.from('\n# relevant sidecar change\n') ]));
    const token1 = (await currentToken())!;
    expect(token1).toBeDefined();
    expect(token1, 'a relevant sidecar byte change must yield a new token').not.toBe(token0);
    expect(parseDocumentVersion(token0)!.byteDigest, 'the body bytes did not change').toBe(
      parseDocumentVersion(token1)!.byteDigest,
    );
    expect(parseDocumentVersion(token0)!.stateHash).not.toBe(parseDocumentVersion(token1)!.stateHash);

    if (original) {
      await writeFile(sidecarPath, original);
    } else {
      await rm(sidecarPath, { force: true });
    }
    expect(await currentToken(), 'reverting the sidecar restores the exact state token').toBe(token0);
  });

  it('treats an absent authority file as creation semantics (unqualified, not a failure)', async () => {
    await rm(await authorityFilePath(), { force: true });
    expect(await currentToken()).toBeUndefined();
  });

  it('propagates an eligible capture failure instead of falling back to a seconds validator', async () => {
    const failing = new MixDataAccessor(
      structured,
      files,
      false,
      true,
      files,
      false,
      new SidecarThrowingMapper(mapper, resourcePath),
      journal,
      undefined,
      operations,
    );
    await expect(failing.getMetadata({ path: resourcePath })).rejects.toThrow('injected authority sidecar mapping failure');
  });

  it('never persists the internal sealed version marker through a read-modify-write', async () => {
    // A PATCH-style flow reads the current representation (which attaches the sealed token) and
    // reuses that metadata for the write. The internal marker must never reach persisted RDF.
    const readMetadata = await accessor.getMetadata({ path: resourcePath });
    expect(readDocumentVersion(readMetadata), 'the read metadata carries a genuine token').toBeDefined();

    const rewritten = [ quad(namedNode(`${resourcePath}#s`), namedNode('urn:refinement:p'), namedNode('urn:refinement:o3')) ];
    await accessor.writeDocument({ path: resourcePath }, guardStream(Readable.from(rewritten)), readMetadata);

    // A stripped metadata clone may leave no sidecar at all; that is an acceptable "no leak".
    const sidecarPath = await sidecarFilePath();
    const sidecar = await readFile(sidecarPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return '';
      }
      throw error;
    });
    expect(sidecar, 'the internal predicate must not be persisted').not.toContain('urn:undefineds:xpod:documentVersion');
    expect(sidecar, 'the sealed token must not be persisted').not.toContain('dv1.');
  });

  it('does not adopt a forged well-formed client literal, even next to the genuine token', async () => {
    const metadata = await accessor.getMetadata({ path: resourcePath });
    const genuine = readDocumentVersion(metadata);
    expect(genuine).toBeDefined();

    const forged = `dv1.${'a'.repeat(64)}.text_turtle.${'b'.repeat(64)}`;
    metadata.add(DOCUMENT_VERSION_TERM, forged);
    expect(readDocumentVersion(metadata), 'a client literal without a genuine seal is never adopted').toBe(genuine);

    const onlyForged = new RepresentationMetadata({ path: resourcePath });
    onlyForged.add(DOCUMENT_VERSION_TERM, forged);
    expect(readDocumentVersion(onlyForged)).toBeUndefined();
    expect(new AuthorityETagHandler().matchesETag(onlyForged, `"${forged}"`, false)).toBe(false);
  });

  it('keeps an over-cap Turtle document qualified with bounded complete digest and byte-exact replay', async () => {
    const filePath = await authorityFilePath();
    const oversized = Buffer.alloc(OVER_CAP_BYTES, 0x61);
    oversized.write('<urn:big> <urn:p> <urn:o> .\n', 0, 'utf8');
    await writeFile(filePath, oversized);
    const expectedDigest = createHash('sha256').update(oversized).digest('hex');

    const metadata = await accessor.getMetadata({ path: resourcePath });
    const token = readDocumentVersion(metadata);
    expect(token, 'over-cap documents must not silently regain seconds validators').toBeDefined();
    expect(parseDocumentVersion(token!)!.byteDigest).toBe(expectedDigest);

    const document = await accessor.getLocalRdfDocument({ path: resourcePath });
    expect(readDocumentVersion(document.metadata)).toBe(token);
    const chunks: Buffer[] = [];
    for await (const chunk of document.data) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    const delivered = Buffer.concat(chunks);
    expect(delivered.length).toBe(OVER_CAP_BYTES);
    expect(createHash('sha256').update(delivered).digest('hex')).toBe(expectedDigest);
  });

  it('retains physical admission across the replay handoff until the consumer drains (and releases after)', async () => {
    const filePath = await authorityFilePath();
    await writeFile(filePath, Buffer.alloc(OVER_CAP_BYTES, 0x62));

    const document = await accessor.getLocalRdfDocument({ path: resourcePath });
    expect(authoritySqlitePeerAdmission('node', operations.databasePath),
      'an unconsumed replay must still hold the exclusive physical admission').toBe(false);
    // A peer write must not slip in between materialization and replay consumption.
    for await (const _chunk of document.data) { /* drain the exact replay bytes */ }
    // The admission is released by the outer physical operation once the replay's actual close
    // commits; yield real event-loop turns until that completion lands (no fixed sleep).
    let released = false;
    for (let attempt = 0; attempt < 100 && !released; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      released = authoritySqlitePeerAdmission('node', operations.databasePath);
    }
    expect(released, 'admission is released only after the replay handoff completes').toBe(true);
  });

  it('releases the physical admission when a replay consumer cancels the stream', async () => {
    const filePath = await authorityFilePath();
    await writeFile(filePath, Buffer.alloc(OVER_CAP_BYTES, 0x63));

    const document = await accessor.getLocalRdfDocument({ path: resourcePath });
    expect(authoritySqlitePeerAdmission('node', operations.databasePath),
      'the replay holds admission before consumption').toBe(false);

    // A cancelled consumer must not leak the exclusive physical admission: destroy after the
    // first slice so the original producer's real close still drives the release.
    await new Promise<void>((resolve) => {
      const onData = (): void => {
        document.data.off('data', onData);
        resolve();
      };
      document.data.on('data', onData);
    });
    document.data.on('error', () => undefined);
    document.data.destroy();

    let released = false;
    for (let attempt = 0; attempt < 100 && !released; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      released = authoritySqlitePeerAdmission('node', operations.databasePath);
    }
    expect(released, 'cancelling the replay must not leak the exclusive physical admission').toBe(true);
  });
});
