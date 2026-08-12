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
import { createRdfEntityTextChunksFromText } from '../storage/rdf/RdfTextProjection';
import { contentTypeForPath } from './SolidFsPathUtils';
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

export interface RdfIndexSolidFsRebuildOptions {
  dryRun?: boolean;
  resetDerivedIndexes?: boolean;
}

export interface RdfIndexSolidFsRebuildResult {
  scanned: number;
  indexedRdfDocuments: number;
  indexedTextSources: number;
  upToDateTextSources: number;
  indexedVectorSources: number;
  failed: number;
  errors: RdfIndexSolidFsRebuildError[];
  skipped: number;
  dryRun: boolean;
  resetDerivedIndexes: boolean;
}

export interface RdfIndexSolidFsRebuildError {
  path: string;
  source?: string;
  message: string;
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

  public async rebuildWorkspace(
    workspace: SolidFsManifest,
    options: RdfIndexSolidFsRebuildOptions = {},
  ): Promise<RdfIndexSolidFsRebuildResult> {
    const dryRun = options.dryRun === true;
    const resetDerivedIndexes = options.resetDerivedIndexes === true;
    const result: RdfIndexSolidFsRebuildResult = {
      scanned: 0,
      indexedRdfDocuments: 0,
      indexedTextSources: 0,
      upToDateTextSources: 0,
      indexedVectorSources: 0,
      failed: 0,
      errors: [],
      skipped: 0,
      dryRun,
      resetDerivedIndexes,
    };

    if (resetDerivedIndexes && !dryRun) {
      await this.textIndex?.clear();
      await this.vectorIndex?.clear();
    }

    for (const entry of workspace.entries) {
      result.scanned += 1;
      const change: SolidFsChange = {
        path: entry.path,
        resource: entry.resource,
        source: entry.source,
        sourcePath: entry.sourcePath,
        contentType: entry.contentType ?? contentTypeForPath(entry.path),
        projection: entry.projection,
        type: 'updated',
        sourceVersion: entry.sourceVersion,
      };
      if (!this.shouldTrackPath(change.path)) {
        result.skipped += 1;
        continue;
      }
      const hasRdfTarget = Boolean(this.resolveIdentifier(change, workspace) && isRdfChange(change));
      const hasTextTarget = Boolean(this.textIndex && isTextSearchIndexableChange(change));
      const hasVectorTarget = Boolean(this.vectorIndex && isTextIndexableChange(change));
      const textUpToDate = hasTextTarget && !resetDerivedIndexes
        ? await this.isTextSourceUpToDate(change, workspace)
        : false;
      const shouldIndexText = hasTextTarget && !textUpToDate;
      if (!hasRdfTarget && !hasTextTarget && !hasVectorTarget) {
        result.skipped += 1;
        continue;
      }

      if (textUpToDate) {
        result.upToDateTextSources += 1;
      }

      if (dryRun) {
        if (hasRdfTarget) {
          result.indexedRdfDocuments += 1;
        }
        if (shouldIndexText) {
          result.indexedTextSources += 1;
        }
        if (hasVectorTarget) {
          result.indexedVectorSources += 1;
        }
        continue;
      }

      try {
        if (textUpToDate) {
          await this.recordTextRebuildStatus(change, workspace, 'skipped', 'source-current');
        }
        await this.syncRebuildChange(change, workspace, {
          rdf: hasRdfTarget,
          text: shouldIndexText,
          vector: hasVectorTarget,
        });
        if (hasRdfTarget) {
          result.indexedRdfDocuments += 1;
        }
        if (shouldIndexText) {
          result.indexedTextSources += 1;
          await this.recordTextRebuildStatus(change, workspace, 'indexed', 'rebuild');
        }
        if (hasVectorTarget) {
          result.indexedVectorSources += 1;
        }
      } catch (error) {
        result.failed += 1;
        result.errors.push({
          path: change.path,
          source: this.sourceInput(change, workspace).source,
          message: errorMessage(error),
        });
        if (hasTextTarget) {
          await this.recordTextRebuildStatus(change, workspace, 'error', 'rebuild', errorMessage(error));
        }
      }
    }

    return result;
  }

  private async isTextSourceUpToDate(change: SolidFsChange, workspace: SolidFsManifest): Promise<boolean> {
    if (!this.textIndex) {
      return false;
    }
    const source = this.sourceInput(change, workspace);
    if (!source.sourceVersion && !source.sourceHash) {
      return false;
    }
    const current = await this.textIndex.sourceMetadata(source.source);
    if (!current) {
      return false;
    }
    return (source.sourceVersion === undefined || current.sourceVersion === source.sourceVersion)
      && (source.sourceHash === undefined || current.sourceHash === source.sourceHash);
  }

  private async syncRebuildChange(
    change: SolidFsChange,
    workspace: SolidFsManifest,
    options: {
      rdf: boolean;
      text: boolean;
      vector: boolean;
    },
  ): Promise<void> {
    const source = this.sourceInput(change, workspace);
    const identifier = this.resolveIdentifier(change, workspace);
    if (options.rdf && identifier && isRdfChange(change)) {
      await this.index.syncLocalRdfDocument(
        identifier,
        guardStream(createReadStream(change.sourcePath)),
        change.contentType,
        source,
      );
    }

    let text: string | undefined;
    if (options.text || options.vector) {
      text = await readFile(change.sourcePath, 'utf8');
    }
    if (options.text && this.textIndex && text !== undefined) {
      await this.textIndex.indexText(
        source,
        text,
        isRdfChange(change) ? await createRdfEntityTextChunksFromText(source, text) : undefined,
      );
    }
    if (options.vector && this.vectorIndex && this.vectorizeText && text !== undefined) {
      const chunks = await this.vectorizeText({ ...source, text });
      await this.vectorIndex.indexVector(source, chunks);
    }
  }

  private async recordTextRebuildStatus(
    change: SolidFsChange,
    workspace: SolidFsManifest,
    status: 'indexed' | 'skipped' | 'error',
    reason: string,
    message?: string,
  ): Promise<void> {
    if (!this.textIndex) {
      return;
    }
    await this.textIndex.recordRebuildStatus({
      ...this.sourceInput(change, workspace),
      status,
      reason,
      ...(message ? { message } : {}),
    });
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
      if (this.textIndex && isTextSearchIndexableChange(change)) {
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

    const textSearchIndexable = isTextSearchIndexableChange(change);
    const vectorIndexable = isTextIndexableChange(change);
    if ((this.textIndex && textSearchIndexable) || (this.vectorIndex && vectorIndexable)) {
      const text = await readFile(change.sourcePath, 'utf8');
      if (this.textIndex && textSearchIndexable) {
        await this.textIndex.indexText(
          source,
          text,
          isRdfChange(change) ? await createRdfEntityTextChunksFromText(source, text) : undefined,
        );
      }
      if (this.vectorIndex && this.vectorizeText && vectorIndexable) {
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
    const previousTextSearchIndexable = isPreviousTextSearchIndexableChange(change);
    const nextTextSearchIndexable = isTextSearchIndexableChange(change);
    const previousVectorIndexable = isPreviousTextIndexableChange(change);
    const nextVectorIndexable = isTextIndexableChange(change);

    if (!previousRdf && !nextRdf && !previousTextSearchIndexable && !nextTextSearchIndexable && !previousVectorIndexable && !nextVectorIndexable) {
      return;
    }

    if (previousRdf && nextRdf) {
      await this.syncMovedRdf(change, workspace, previousSource, nextSource);
    } else if (previousRdf && !nextRdf) {
      if (previousSource) {
        await this.index.deleteLocalRdfIndex({ path: previousSource });
      }
    } else if (!previousRdf && nextRdf) {
      await this.syncMovedSearchIndexes(change, previousSource, nextSource, {
        previousTextSearchIndexable,
        nextTextSearchIndexable: false,
        previousVectorIndexable,
        nextVectorIndexable: false,
      });
      await this.syncTrackedChange({ ...change, type: 'updated' }, workspace);
      return;
    }

    await this.syncMovedSearchIndexes(change, previousSource, nextSource, {
      previousTextSearchIndexable,
      nextTextSearchIndexable,
      previousVectorIndexable,
      nextVectorIndexable,
    });
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
      const moved = await this.index.moveLocalRdfIndex(
        { path: previousSource },
        nextIdentifier,
        {
          previousSource,
          ...nextSource,
        },
      );
      if (moved > 0) {
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
    options: {
      previousTextSearchIndexable: boolean;
      nextTextSearchIndexable: boolean;
      previousVectorIndexable: boolean;
      nextVectorIndexable: boolean;
    },
  ): Promise<void> {
    if (!this.textIndex && !this.vectorIndex) {
      return;
    }

    let shouldIndexText = options.nextTextSearchIndexable;
    let shouldIndexVector = options.nextVectorIndexable;
    let text: string | undefined;
    if (previousSource) {
      if (this.textIndex) {
        if (options.previousTextSearchIndexable && options.nextTextSearchIndexable) {
          const moved = await this.textIndex.moveSource(previousSource, nextSource);
          shouldIndexText = moved === 0;
          if (shouldIndexText) {
            await this.textIndex.deleteSource(previousSource);
          }
        }
        if (options.previousTextSearchIndexable && !options.nextTextSearchIndexable) {
          await this.textIndex.deleteSource(previousSource);
        }
      }
      if (this.vectorIndex && options.previousVectorIndexable) {
        if (options.nextVectorIndexable) {
          const moved = await this.vectorIndex.moveSource(previousSource, nextSource);
          shouldIndexVector = moved === 0;
          if (shouldIndexVector) {
            await this.vectorIndex.deleteSource(previousSource);
          }
        } else {
          await this.vectorIndex.deleteSource(previousSource);
        }
      }
    }
    if (!options.nextTextSearchIndexable && !options.nextVectorIndexable) {
      return;
    }

    if (this.textIndex && shouldIndexText) {
      text ??= await readFile(change.sourcePath, 'utf8');
      await this.textIndex.indexText(
        nextSource,
        text,
        isRdfChange(change) ? await createRdfEntityTextChunksFromText(nextSource, text) : undefined,
      );
    }
    if (this.vectorIndex && this.vectorizeText && shouldIndexVector) {
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
      sourceHash: change.contentHash,
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function isTextSearchIndexableChange(change: SolidFsChange): boolean {
  return isRdfChange(change) || isTextChange(change);
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

function isPreviousTextSearchIndexableChange(change: SolidFsChange): boolean {
  return isPreviousRdfChange(change) || isPreviousTextChange(change);
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
