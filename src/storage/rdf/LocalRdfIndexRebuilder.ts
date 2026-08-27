import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import arrayifyStream from 'arrayify-stream';
import type { Quad } from '@rdfjs/types';
import {
  BaseIdentifierStrategy,
  ExtensionBasedMapper,
  RepresentationMetadata,
  addResourceMetadata,
  updateModifiedDate,
} from '@solid/community-server';
import { rdfParser } from 'rdf-parse';

import { SolidRdfDataAccessor } from '../accessors/SolidRdfDataAccessor';
import { SolidRdfEngine } from './SolidRdfEngine';
import { isRdfDocumentContentType } from './RdfContentTypes';

interface ResourceIdentifier {
  path: string;
}

class LocalBaseIdentifierStrategy extends BaseIdentifierStrategy {
  public constructor(private readonly baseUrl: string) {
    super();
  }

  public supportsIdentifier(identifier: ResourceIdentifier): boolean {
    return identifier.path.startsWith(this.baseUrl);
  }

  public isRootContainer(identifier: ResourceIdentifier): boolean {
    return identifier.path === this.baseUrl;
  }
}

export interface LocalRdfIndexRebuildInput {
  baseUrl: string;
  rootDir: string;
  indexPath: string;
  dryRun?: boolean;
}

export interface LocalRdfIndexRebuildError {
  path: string;
  message: string;
}

export interface LocalRdfIndexRebuildResult {
  scanned: number;
  indexed: number;
  skipped: number;
  failed: number;
  dryRun: boolean;
  errors: LocalRdfIndexRebuildError[];
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

async function* walkFiles(rootDir: string): AsyncGenerator<string> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(absolutePath);
    } else if (entry.isFile()) {
      yield absolutePath;
    }
  }
}

async function* walkDirectories(rootDir: string): AsyncGenerator<string> {
  yield rootDir;
  const entries = await readdir(rootDir, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isDirectory()) {
      yield* walkDirectories(path.join(rootDir, entry.name));
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Rebuild the local structured RDF index from the Pod files that remain the
 * content authority. Sources are replaced incrementally so a malformed file is
 * reported without preventing later files from being restored; unrelated index
 * rows are left untouched.
 */
export async function rebuildLocalRdfIndex(
  input: LocalRdfIndexRebuildInput,
): Promise<LocalRdfIndexRebuildResult> {
  const baseUrl = ensureTrailingSlash(input.baseUrl);
  const rootDir = path.resolve(input.rootDir);
  const dryRun = input.dryRun === true;
  const result: LocalRdfIndexRebuildResult = {
    scanned: 0,
    indexed: 0,
    skipped: 0,
    failed: 0,
    dryRun,
    errors: [],
  };
  const mapper = new ExtensionBasedMapper(baseUrl, rootDir);
  const engine = dryRun ? undefined : new SolidRdfEngine({ index: { path: input.indexPath } });
  const accessor = engine
    ? new SolidRdfDataAccessor(engine, new LocalBaseIdentifierStrategy(baseUrl))
    : undefined;

  try {
    if (accessor) {
      // CSS permission extraction walks up through every parent container when
      // a PATCH creates a document. Rebuilding only document graphs leaves
      // those containers (including the server root) looking absent and makes
      // the walk continue past the root. Restore container metadata first.
      for await (const directoryPath of walkDirectories(rootDir)) {
        const link = await mapper.mapFilePathToUrl(directoryPath, true);
        await accessor.writeContainer(link.identifier, new RepresentationMetadata(link.identifier));
      }
    }

    for await (const filePath of walkFiles(rootDir)) {
      result.scanned += 1;
      try {
        const link = await mapper.mapFilePathToUrl(filePath, false);
        if (!isRdfDocumentContentType(link.contentType)) {
          if (accessor) {
            // MixDataAccessor routes reads from metadata stored in the
            // structured accessor. Rebuild that metadata for binary/text
            // files as well; otherwise the bytes remain on disk but HTTP
            // reads return 404 after an index rebuild.
            const metadata = new RepresentationMetadata(link.identifier);
            metadata.contentType = link.contentType;
            addResourceMetadata(metadata, false);
            updateModifiedDate(metadata);
            await accessor.writeMetadata(link.identifier, metadata);
          }
          result.skipped += 1;
          continue;
        }
        if (dryRun) {
          result.indexed += 1;
          continue;
        }

        const quads = await arrayifyStream<Quad>(rdfParser.parse(createReadStream(filePath), {
          baseIRI: link.identifier.path,
          contentType: link.contentType!,
        }) as any);
        const metadata = new RepresentationMetadata(link.identifier);
        addResourceMetadata(metadata, false);
        updateModifiedDate(metadata);
        await accessor!.writeRdfSourceDocument(link.identifier, quads, metadata, {
          source: link.identifier.path,
          workspace: baseUrl,
          localPath: path.relative(rootDir, filePath).split(path.sep).join('/'),
          contentType: link.contentType,
        });
        result.indexed += 1;
      } catch (error) {
        result.failed += 1;
        result.errors.push({ path: filePath, message: errorMessage(error) });
      }
    }
  } finally {
    await accessor?.finalize();
  }

  return result;
}
