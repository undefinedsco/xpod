import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { guardStream, type ResourceIdentifier } from '@solid/community-server';

import type { LocalRdfIndexAccessor } from '../storage/accessors/MixDataAccessor';
import type { RdfTextIndex } from '../storage/rdf';
import {
  isLineAddressableRdf,
  isRdfDocument,
  isRdfDocumentPath,
  normalizeContentType,
} from '../storage/rdf/RdfContentTypes';
import type { SolidFsChange, SolidFsManifest, SolidFsSyncer } from './types';

export interface RdfIndexSolidFsSyncerOptions {
  index: LocalRdfIndexAccessor;
  textIndex?: RdfTextIndex;
  resolveIdentifier?: (change: SolidFsChange, workspace: SolidFsManifest) => ResourceIdentifier | undefined;
}

/**
 * Refreshes the structured RDF index for standard RDF documents changed
 * through a SolidFS materialized workspace.
 */
export class RdfIndexSolidFsSyncer implements SolidFsSyncer {
  private readonly index: LocalRdfIndexAccessor;
  private readonly textIndex?: RdfTextIndex;
  private readonly resolveIdentifier: NonNullable<RdfIndexSolidFsSyncerOptions['resolveIdentifier']>;

  public constructor(options: RdfIndexSolidFsSyncerOptions) {
    this.index = options.index;
    this.textIndex = options.textIndex;
    this.resolveIdentifier = options.resolveIdentifier ?? defaultResolveIdentifier;
  }

  public shouldTrackPath(relativePath: string): boolean {
    return isRdfPath(relativePath) || (this.textIndex ? isTextPath(relativePath) : false);
  }

  public async sync(change: SolidFsChange, workspace: SolidFsManifest): Promise<void> {
    if (!isTrackedChange(change)) {
      return;
    }

    const identifier = this.resolveIdentifier(change, workspace);
    if (!identifier && isRdfChange(change) && !this.textIndex) {
      return;
    }

    if (change.type === 'deleted') {
      if (identifier && isRdfChange(change)) {
        await this.index.deleteLocalRdfIndex(identifier);
      }
      if (this.textIndex && isTextIndexableChange(change)) {
        this.textIndex.deleteSource(change.resource ?? sourceFromWorkspace(change, workspace));
      }
      return;
    }

    if (identifier && isRdfChange(change)) {
      const localPath = change.path.split(path.sep).join('/');
      await this.index.syncLocalRdfDocument(
        identifier,
        guardStream(createReadStream(change.sourcePath)),
        change.contentType,
        {
          source: change.resource ?? sourceFromWorkspace(change, workspace),
          workspace: workspace.workspace,
          localPath,
          sourceVersion: change.sourceVersion,
        },
      );
    }

    if (this.textIndex && isTextIndexableChange(change)) {
      const text = await readFile(change.sourcePath, 'utf8');
      this.textIndex.indexText({
        source: change.resource ?? sourceFromWorkspace(change, workspace),
        workspace: workspace.workspace,
        localPath: change.path.split(path.sep).join('/'),
        contentType: change.contentType,
        sourceVersion: change.sourceVersion,
      }, text);
    }
  }
}

export function defaultResolveIdentifier(
  change: SolidFsChange,
  workspace: SolidFsManifest,
): ResourceIdentifier | undefined {
  if (change.resource) {
    try {
      const resource = new URL(change.resource);
      if (resource.protocol === 'http:' || resource.protocol === 'https:') {
        return { path: resource.href };
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  try {
    const base = new URL(workspace.workspace.endsWith('/') ? workspace.workspace : `${workspace.workspace}/`);
    if (base.protocol !== 'http:' && base.protocol !== 'https:') {
      return undefined;
    }
    const normalized = change.path.split(path.sep).join('/');
    return { path: new URL(normalized, base).href };
  } catch {
    return undefined;
  }
}

function isRdfChange(change: SolidFsChange): boolean {
  return isRdfDocument(change.contentType, change.path);
}

function isLineAddressableRdfChange(change: SolidFsChange): boolean {
  return isLineAddressableRdf(change.contentType, change.path);
}

function isTextChange(change: SolidFsChange): boolean {
  return isTextContentType(change.contentType) || isTextPath(change.path);
}

function isTextIndexableChange(change: SolidFsChange): boolean {
  return isLineAddressableRdfChange(change) || isTextChange(change);
}

function isTrackedChange(change: SolidFsChange): boolean {
  return isRdfChange(change) || isTextChange(change);
}

function isRdfPath(filePath: string): boolean {
  return isRdfDocumentPath(filePath);
}

function isTextPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.md')
    || lower.endsWith('.markdown')
    || lower.endsWith('.mdown')
    || lower.endsWith('.txt')
    || lower.endsWith('.log');
}

function isTextContentType(contentType: string | undefined): boolean {
  const normalized = normalizeContentType(contentType);
  return normalized === 'text/plain'
    || normalized === 'text/markdown'
    || normalized === 'text/x-markdown';
}

function sourceFromWorkspace(change: SolidFsChange, workspace: SolidFsManifest): string {
  try {
    const base = new URL(workspace.workspace.endsWith('/') ? workspace.workspace : `${workspace.workspace}/`);
    return new URL(change.path.split(path.sep).join('/'), base).href;
  } catch {
    return change.sourcePath;
  }
}
