import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  SolidFsChange,
  SolidFsManifest,
  SolidFsPrepareInput,
  SolidFsSyncer,
} from '../../solidfs';
import { resolvePodResourceUrl } from '../../solidfs';
import {
  isLineAddressableRdf,
  isLineAddressableRdfPath,
  normalizeContentType,
} from '../../storage/rdf/RdfContentTypes';
import type { StoreContext } from '../chatkit/store';
import type {
  RdfSearchIndexingService,
  RdfVectorDeleteResult,
  RdfVectorIndexingResult,
} from './RdfSearchIndexingService';

export interface RdfSearchIndexingSolidFsSyncerOptions {
  service: RdfSearchIndexingService;
  /**
   * Derived vector indexing must not make an already-committed authority write
   * fail by default. Tests and operations can observe failures through onError.
   */
  failOnError?: boolean;
  onError?: (error: unknown, input: RdfSearchIndexingSolidFsSyncerErrorInput) => void;
  onResult?: (result: RdfVectorIndexingResult | RdfVectorDeleteResult) => void;
}

export interface RdfSearchIndexingSolidFsSyncerErrorInput {
  change: SolidFsChange;
  workspace: SolidFsManifest;
  source?: string;
}

export class RdfSearchIndexingSolidFsSyncer implements SolidFsSyncer {
  private readonly service: RdfSearchIndexingService;
  private readonly failOnError: boolean;
  private readonly onError?: RdfSearchIndexingSolidFsSyncerOptions['onError'];
  private readonly onResult?: RdfSearchIndexingSolidFsSyncerOptions['onResult'];

  public constructor(options: RdfSearchIndexingSolidFsSyncerOptions) {
    this.service = options.service;
    this.failOnError = options.failOnError === true;
    this.onError = options.onError;
    this.onResult = options.onResult;
  }

  public shouldTrack(input: SolidFsPrepareInput): boolean {
    try {
      const url = new URL(input.workspace);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  public shouldTrackPath(relativePath: string): boolean {
    return isSearchIndexablePath(relativePath);
  }

  public async sync(change: SolidFsChange, workspace: SolidFsManifest, context?: unknown): Promise<void> {
    if (!isSearchIndexableChange(change) || !isStoreContext(context)) {
      return;
    }

    const source = resolvePodResourceUrl(change, workspace);
    if (!source) {
      return;
    }

    try {
      if (change.type === 'deleted') {
        const result = await this.service.deleteVectorSource({ source });
        this.onResult?.(result);
        return;
      }

      const text = await readFile(change.sourcePath, 'utf8');
      const result = await this.service.indexVectorSource({
        context,
        source: {
          source,
          workspace: workspace.workspace,
          localPath: change.path.split(path.sep).join('/'),
          contentType: change.contentType,
          sourceVersion: change.sourceVersion,
        },
        text,
      });
      this.onResult?.(result);
    } catch (error) {
      this.onError?.(error, { change, workspace, source });
      if (this.failOnError) {
        throw error;
      }
    }
  }
}

function isSearchIndexableChange(change: SolidFsChange): boolean {
  return isLineAddressableRdf(change.contentType, change.path)
    || isTextContentType(change.contentType)
    || isSearchIndexablePath(change.path);
}

function isSearchIndexablePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return isLineAddressableRdfPath(filePath)
    || lower.endsWith('.md')
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

function isStoreContext(context: unknown): context is StoreContext {
  return typeof context === 'object' && context !== null;
}
