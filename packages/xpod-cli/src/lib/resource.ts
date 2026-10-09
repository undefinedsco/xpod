import { readFileSync } from 'fs';
import { extname } from 'path';
import type { CliAuthContext } from './auth-context';
import { authFetch } from './auth-context';
import { CliCommandError } from './output';

export interface ResourceTarget {
  input: string;
  resourceUrl: string;
  webId: string;
  podRoot: string;
  baseIri: string;
}

export interface ResourceResponseData {
  webId: string;
  podRoot: string;
  baseIri: string;
  resourceUrl: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

export function resolveResourceTarget(context: CliAuthContext, input: string): ResourceTarget {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new CliCommandError('invalid_path', 'Resource path is required.');
  }

  const resourceUrl = /^https?:\/\//i.test(trimmed)
    ? new URL(trimmed).toString()
    : new URL(trimmed.replace(/^\/+/, ''), context.podRoot).toString();

  return {
    input,
    resourceUrl,
    webId: context.webId,
    podRoot: context.podRoot,
    baseIri: context.baseIri,
  };
}

export function responseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === 'authorization' || lower === 'cookie' || lower === 'set-cookie') {
      headers[key] = '[redacted]';
    } else {
      headers[key] = value;
    }
  });
  return headers;
}

export function responseData(target: ResourceTarget, response: Response): ResourceResponseData {
  return {
    webId: target.webId,
    podRoot: target.podRoot,
    baseIri: target.baseIri,
    resourceUrl: target.resourceUrl,
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders(response),
  };
}

export function ensureOk(response: Response, code: string, message: string): void {
  if (!response.ok) {
    throw new CliCommandError(code, `${message}: HTTP ${response.status} ${response.statusText}`, 1, {
      status: response.status,
      statusText: response.statusText,
    });
  }
}

export function contentTypeForPath(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.ttl':
      return 'text/turtle';
    case '.json':
    case '.jsonld':
      return 'application/ld+json';
    case '.txt':
    case '.md':
      return 'text/plain';
    case '.html':
      return 'text/html';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    default:
      return 'application/octet-stream';
  }
}

export function readBodyFile(filePath: string): { body: Buffer; contentType: string } {
  return {
    body: readFileSync(filePath),
    contentType: contentTypeForPath(filePath),
  };
}

export async function fetchResource(
  context: CliAuthContext,
  target: ResourceTarget,
  init: RequestInit,
): Promise<Response> {
  return authFetch(context, target.resourceUrl, init);
}

export function parseContainedResources(turtle: string, containerUrl: string): string[] {
  const resources = new Set<string>();
  const containsPattern = /(?:ldp:contains|<http:\/\/www\.w3\.org\/ns\/ldp#contains>)\s+((?:<[^>]+>\s*,?\s*)+)/g;
  let match: RegExpExecArray | null;
  while ((match = containsPattern.exec(turtle)) !== null) {
    const block = match[1] ?? '';
    const iriPattern = /<([^>]+)>/g;
    let iriMatch: RegExpExecArray | null;
    while ((iriMatch = iriPattern.exec(block)) !== null) {
      const iri = iriMatch[1];
      if (iri && iri !== containerUrl) {
        resources.add(new URL(iri, containerUrl).toString());
      }
    }
  }
  return Array.from(resources).sort();
}

export function relativeToPodRoot(resourceUrl: string, podRoot: string): string {
  return resourceUrl.startsWith(podRoot) ? resourceUrl.slice(podRoot.length) : resourceUrl;
}
