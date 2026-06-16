import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { guardStream, type ResourceIdentifier } from '@solid/community-server';

import type { LocalRdfIndexAccessor } from '../storage/accessors/MixDataAccessor';
import type {
  RdfTermRewriteInput,
  RdfTermRewriteResult,
  RdfTextIndexLike,
  RdfTextSourceInput,
  RdfVectorChunkInput,
  RdfVectorIndexLike,
  RdfVectorSourceInput,
} from '../storage/rdf';
import {
  isLineAddressableRdf,
  isRdfDocument,
  isRdfDocumentPath,
  normalizeContentType,
} from '../storage/rdf/RdfContentTypes';
import type { SolidFsChange, SolidFsManifest, SolidFsSyncer } from './types';

type MaybePromise<T> = T | Promise<T>;

export interface RdfIndexSolidFsSyncerOptions {
  index: LocalRdfIndexAccessor;
  textIndex?: RdfTextIndexLike;
  vectorIndex?: RdfVectorIndexLike;
  vectorizeText?: (input: RdfIndexSolidFsVectorizeInput) => MaybePromise<RdfVectorChunkInput[]>;
  resolveIdentifier?: (change: SolidFsChange, workspace: SolidFsManifest) => ResourceIdentifier | undefined;
}

export interface RdfIndexSolidFsVectorizeInput extends RdfVectorSourceInput {
  text: string;
}

/**
 * Refreshes the structured RDF index for standard RDF documents changed
 * through a SolidFS materialized workspace.
 */
export class RdfIndexSolidFsSyncer implements SolidFsSyncer {
  private readonly index: LocalRdfIndexAccessor;
  private readonly textIndex?: RdfTextIndexLike;
  private readonly vectorIndex?: RdfVectorIndexLike;
  private readonly vectorizeText?: NonNullable<RdfIndexSolidFsSyncerOptions['vectorizeText']>;
  private readonly resolveIdentifier: NonNullable<RdfIndexSolidFsSyncerOptions['resolveIdentifier']>;

  public constructor(options: RdfIndexSolidFsSyncerOptions) {
    if (options.vectorIndex && !options.vectorizeText) {
      throw new Error('RdfIndexSolidFsSyncer vectorIndex requires vectorizeText');
    }
    this.index = options.index;
    this.textIndex = options.textIndex;
    this.vectorIndex = options.vectorIndex;
    this.vectorizeText = options.vectorizeText;
    this.resolveIdentifier = options.resolveIdentifier ?? defaultResolveIdentifier;
  }

  public shouldTrackPath(relativePath: string): boolean {
    const needsTextSource = Boolean(this.textIndex || this.vectorIndex);
    return isRdfPath(relativePath) || (needsTextSource ? isTextPath(relativePath) : false);
  }

  public async sync(change: SolidFsChange, workspace: SolidFsManifest): Promise<void> {
    if (change.type === 'moved') {
      await this.syncMoved(change, workspace);
      return;
    }

    if (!isTrackedChange(change)) {
      return;
    }

    await this.syncTrackedChange(change, workspace);
  }

  private async syncTrackedChange(change: SolidFsChange, workspace: SolidFsManifest): Promise<void> {
    const identifier = this.resolveIdentifier(change, workspace);
    if (!identifier && isRdfChange(change) && !this.textIndex && !this.vectorIndex) {
      return;
    }

    if (change.type === 'deleted') {
      const source = this.sourceInput(change, workspace).source;
      if (identifier && isRdfChange(change)) {
        await this.index.deleteLocalRdfIndex(identifier);
      }
      if (this.textIndex && isTextIndexableChange(change)) {
        await this.textIndex.deleteSource(source);
      }
      if (this.vectorIndex && isTextIndexableChange(change)) {
        await this.vectorIndex.deleteSource(source);
      }
      return;
    }

    const source = this.sourceInput(change, workspace);
    if (identifier && isRdfChange(change)) {
      await this.index.syncLocalRdfDocument(
        identifier,
        guardStream(createReadStream(change.sourcePath)),
        change.contentType,
        source,
      );
    }

    if ((this.textIndex || this.vectorIndex) && isTextIndexableChange(change)) {
      const text = await readFile(change.sourcePath, 'utf8');
      if (this.textIndex) {
        await this.textIndex.indexText(source, text);
      }
      if (this.vectorIndex && this.vectorizeText) {
        const chunks = await this.vectorizeText({ ...source, text });
        await this.vectorIndex.indexVector(source, chunks);
      }
    }
  }

  private async syncMoved(change: SolidFsChange, workspace: SolidFsManifest): Promise<void> {
    const nextSource = this.sourceInput(change, workspace);
    const previousSource = previousSourceFromChange(change, workspace);
    const previousRdf = isPreviousRdfChange(change);
    const nextRdf = isRdfChange(change);
    const previousTextIndexable = isPreviousTextIndexableChange(change);
    const nextTextIndexable = isTextIndexableChange(change);

    if (!previousRdf && !nextRdf && !previousTextIndexable && !nextTextIndexable) {
      return;
    }

    if (previousRdf && nextRdf) {
      await this.syncMovedRdf(change, workspace, previousSource, nextSource);
    } else if (previousRdf && !nextRdf) {
      if (previousSource) {
        await this.index.deleteLocalRdfIndex({ path: previousSource });
      }
    } else if (!previousRdf && nextRdf) {
      await this.syncMovedSearchIndexes(change, previousSource, nextSource, previousTextIndexable, false);
      await this.syncTrackedChange({ ...change, type: 'updated' }, workspace);
      return;
    }

    await this.syncMovedSearchIndexes(change, previousSource, nextSource, previousTextIndexable, nextTextIndexable);
  }

  private async syncMovedRdf(
    change: SolidFsChange,
    workspace: SolidFsManifest,
    previousSource: string | undefined,
    nextSource: RdfTextSourceInput & RdfVectorSourceInput,
  ): Promise<void> {
    const nextIdentifier = this.resolveIdentifier(change, workspace);
    if (!nextIdentifier) {
      return;
    }

    if (this.index.moveLocalRdfIndex && previousSource) {
      await this.index.moveLocalRdfIndex(
        { path: previousSource },
        nextIdentifier,
        {
          previousSource,
          ...nextSource,
        },
      );
      const rewriteCapable: RdfTermRewriteCapable = this.index;
      if (rewriteCapable.rewriteTerms && previousSource !== nextSource.source) {
        await rewriteCapable.rewriteTerms({
          oldPrefix: previousSource,
          newPrefix: nextSource.source,
          scope: 'safe_projection',
          mode: 'safe',
        });
      }
      return;
    }

    await this.index.syncLocalRdfDocument(
      nextIdentifier,
      guardStream(createReadStream(change.sourcePath)),
      change.contentType,
      nextSource,
    );
    if (previousSource) {
      await this.index.deleteLocalRdfIndex({ path: previousSource });
    }
  }

  private async syncMovedSearchIndexes(
    change: SolidFsChange,
    previousSource: string | undefined,
    nextSource: RdfTextSourceInput & RdfVectorSourceInput,
    previousTextIndexable: boolean,
    nextTextIndexable: boolean,
  ): Promise<void> {
    if (!this.textIndex && !this.vectorIndex) {
      return;
    }

    let text: string | undefined;
    if (previousTextIndexable && previousSource) {
      if (this.textIndex) {
        await this.textIndex.deleteSource(previousSource);
      }
      if (this.vectorIndex) {
        await this.vectorIndex.deleteSource(previousSource);
      }
    }
    if (!nextTextIndexable) {
      return;
    }

    if (this.textIndex) {
      text ??= await readFile(change.sourcePath, 'utf8');
      await this.textIndex.indexText(nextSource, text);
    }
    if (this.vectorIndex && this.vectorizeText) {
      text ??= await readFile(change.sourcePath, 'utf8');
      const chunks = await this.vectorizeText({ ...nextSource, text });
      await this.vectorIndex.indexVector(nextSource, chunks);
    }
  }

  private sourceInput(change: SolidFsChange, workspace: SolidFsManifest): RdfTextSourceInput & RdfVectorSourceInput {
    return {
      source: change.resource ?? sourceFromWorkspace(change, workspace) ?? change.sourcePath,
      workspace: workspace.workspace,
      localPath: change.path.split(path.sep).join('/'),
      contentType: change.contentType,
      sourceVersion: change.sourceVersion,
    };
  }
}

type RdfTermRewriteCapable = {
  rewriteTerms?(input: RdfTermRewriteInput): MaybePromise<RdfTermRewriteResult>;
};

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

function isPreviousRdfChange(change: SolidFsChange): boolean {
  const previousPath = change.previousPath ?? change.previousResource;
  if (previousPath) {
    return isRdfDocument(undefined, previousPath);
  }
  return isRdfChange(change);
}

function isPreviousLineAddressableRdfChange(change: SolidFsChange): boolean {
  const previousPath = change.previousPath ?? change.previousResource;
  if (previousPath) {
    return isLineAddressableRdf(undefined, previousPath);
  }
  return isLineAddressableRdfChange(change);
}

function isPreviousTextChange(change: SolidFsChange): boolean {
  const previousPath = change.previousPath ?? change.previousResource;
  if (previousPath) {
    return isTextPath(previousPath);
  }
  return isTextChange(change);
}

function isPreviousTextIndexableChange(change: SolidFsChange): boolean {
  return isPreviousLineAddressableRdfChange(change) || isPreviousTextChange(change);
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

function previousSourceFromChange(change: SolidFsChange, workspace: SolidFsManifest): string | undefined {
  if (change.previousResource) {
    return change.previousResource;
  }
  if (!change.previousPath) {
    return undefined;
  }
  return sourceFromWorkspace({ ...change, path: change.previousPath }, workspace, false)
    ?? sourceFromWorkspaceCwd(change.previousPath, workspace);
}

function sourceFromWorkspace(
  change: SolidFsChange,
  workspace: SolidFsManifest,
  fallbackToSourcePath = true,
): string | undefined {
  try {
    const base = new URL(workspace.workspace.endsWith('/') ? workspace.workspace : `${workspace.workspace}/`);
    return new URL(change.path.split(path.sep).join('/'), base).href;
  } catch {
    return fallbackToSourcePath ? change.sourcePath : undefined;
  }
}

function sourceFromWorkspaceCwd(relativePath: string, workspace: SolidFsManifest): string | undefined {
  if (!relativePath) {
    return undefined;
  }
  if (path.isAbsolute(relativePath)) {
    return relativePath;
  }
  return path.join(workspace.cwd, relativePath);
}
