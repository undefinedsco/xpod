import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import arrayifyStream from 'arrayify-stream';
import {
  ExtensionBasedMapper,
  FileDataAccessor,
  RepresentationMetadata,
  guardStream,
  LDP,
  RDF,
  NotFoundHttpError,
  BaseIdentifierStrategy,
} from '@solid/community-server';
import { DataFactory } from 'n3';
import { MixDataAccessor } from '../../../src/storage/accessors/MixDataAccessor';

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
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

describe('MixDataAccessor (local profile integration)', () => {
  const baseUrl = 'http://localhost:3000/';
  let workDir: string;
  let dataDir: string;
  let accessor: MixDataAccessor;
  let mapper: ExtensionBasedMapper;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'mix-accessor-'));
    dataDir = path.join(workDir, 'data');
    await mkdir(dataDir, { recursive: true });

    mapper = new ExtensionBasedMapper(baseUrl, dataDir);
    const fileAccessor = new FileDataAccessor(mapper);
    const identifierStrategy = new SimpleIdentifierStrategy(baseUrl);
    const sqlitePath = path.join(workDir, 'quadstore.sqlite');
    accessor = new MixDataAccessor(`sqlite:${sqlitePath}`, identifierStrategy, fileAccessor);
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('crud operations use quadstore for containers and filesystem for unstructured files', async () => {
    const rootId = { path: baseUrl };
    const rootMetadata = new RepresentationMetadata(rootId);
    rootMetadata.contentType = 'internal/quads';
    rootMetadata.addQuad(rootMetadata.identifier, RDF.terms.type, LDP.terms.BasicContainer);
    rootMetadata.addQuad(rootMetadata.identifier, RDF.terms.type, LDP.terms.Container);
    rootMetadata.addQuad(rootMetadata.identifier, RDF.terms.type, LDP.terms.Resource);
    await accessor.writeContainer(rootId, rootMetadata);

    const containerPaths = [ `${baseUrl}alice/` ];
    for (const pathValue of containerPaths) {
      const containerId = { path: pathValue };
      const containerMetadata = new RepresentationMetadata(containerId);
      containerMetadata.contentType = 'internal/quads';
      containerMetadata.addQuad(containerMetadata.identifier, RDF.terms.type, LDP.terms.BasicContainer);
      containerMetadata.addQuad(containerMetadata.identifier, RDF.terms.type, LDP.terms.Container);
      containerMetadata.addQuad(containerMetadata.identifier, RDF.terms.type, LDP.terms.Resource);
      await accessor.writeContainer(containerId, containerMetadata);
      const storedMetadata = await accessor.getMetadata(containerId);
      expect(storedMetadata.contentType).toBe('internal/quads');
    }

    const jsonId = { path: `${baseUrl}alice/settings.json` };
    const jsonMetadata = new RepresentationMetadata(jsonId);
    jsonMetadata.contentType = 'application/json';
    const jsonPayload = Buffer.from(JSON.stringify({ theme: 'dark', lang: 'zh-CN' }));
    const jsonStream = guardStream(Readable.from([ jsonPayload ]));
    const jsonLink = await mapper.mapUrlToFilePath(jsonId as ResourceIdentifier, false, jsonMetadata.contentType);
    await mkdir(path.dirname(jsonLink.filePath), { recursive: true });
    await accessor.writeDocument(jsonId, jsonStream, jsonMetadata);

    const jsonStoredMetadata = await accessor.getMetadata(jsonId);
    expect(jsonStoredMetadata.contentType).toBe('application/json');
    expect(await fileExists(jsonLink.filePath)).toBe(true);

    const jsonData = await accessor.getData(jsonId);
    const jsonChunks = await arrayifyStream(jsonData as any);
    const jsonBuffer = Buffer.concat(jsonChunks.map((chunk: Buffer | Uint8Array) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    expect(jsonBuffer.toString('utf8')).toContain('"theme":"dark"');

    await accessor.deleteResource(jsonId);
    expect(await fileExists(jsonLink.filePath)).toBe(false);
    await expect(accessor.getMetadata(jsonId)).rejects.toBeInstanceOf(NotFoundHttpError);

    for (const pathValue of containerPaths.slice().reverse()) {
      const containerId = { path: pathValue };
      await accessor.deleteResource(containerId);
      await expect(accessor.getMetadata(containerId)).rejects.toBeInstanceOf(NotFoundHttpError);
    }
  });
});
