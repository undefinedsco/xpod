import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  readdir,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type {
  SolidFsEntrySource,
  SolidFsProjection,
} from './types';
import { rdfContentTypeForPath } from '../storage/rdf/RdfContentTypes';

export interface SolidFsFileSnapshot {
  relativePath: string;
  absolutePath: string;
  version: string;
}

export function contentTypeForPath(filePath: string): string | undefined {
  const lower = filePath.toLowerCase();
  const rdfContentType = rdfContentTypeForPath(lower);
  if (rdfContentType) {
    return rdfContentType;
  }
  if (lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.mdown')) {
    return 'text/markdown';
  }
  if (lower.endsWith('.txt') || lower.endsWith('.log')) {
    return 'text/plain';
  }
  return undefined;
}

export function sourceForProjection(projection: SolidFsProjection, workspace: string): SolidFsEntrySource {
  if (projection === 'hydrated-object') {
    return 'object';
  }
  if (/^https?:/u.test(workspace)) {
    return 'pod-http';
  }
  return 'filesystem';
}

export function resolveWorkspaceResource(workspace: string, relativePath: string): string | undefined {
  if (path.isAbsolute(workspace)) {
    return pathToFileURL(path.join(workspace, relativePath)).href;
  }

  try {
    const base = new URL(workspace.endsWith('/') ? workspace : `${workspace}/`);
    const normalized = relativePath.split(path.sep).join('/');
    return new URL(normalized, base).href;
  } catch {
    return undefined;
  }
}

export function safeRelativePath(input: string): string {
  const normalized = input.split(/[\\/]+/u).filter((part) => part.length > 0).join(path.sep);
  if (!normalized || path.isAbsolute(input) || normalized.split(path.sep).includes('..')) {
    throw new Error(`Invalid SolidFS relative path: ${input}`);
  }
  return normalized;
}

export async function maybeFileVersion(filePath: string): Promise<string | undefined> {
  try {
    return await fileVersion(filePath);
  } catch {
    return undefined;
  }
}

export async function fileVersion(filePath: string): Promise<string> {
  const fileStat = await stat(filePath);
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return `${fileStat.size}:${fileStat.mtimeMs}:${hash.digest('hex')}`;
}

export async function snapshotDirectory(
  root: string,
  filter?: (relativePath: string) => boolean,
): Promise<SolidFsFileSnapshot[]> {
  const snapshots: SolidFsFileSnapshot[] = [];

  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (filter && !filter(relative)) {
        continue;
      }
      snapshots.push({
        relativePath: relative,
        absolutePath: absolute,
        version: await fileVersion(absolute),
      });
    }
  }

  await walk(root);
  return snapshots.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
