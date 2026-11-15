import type { AgentDirectoryRequest } from '../directory/client';
import type { SolidFsManifest } from './types';

export type SolidFsPodRequest = (url: Parameters<AgentDirectoryRequest>[0], init: Parameters<AgentDirectoryRequest>[1], context?: unknown) => ReturnType<AgentDirectoryRequest>;
export interface PodSolidFsHttpClientOptions { request: SolidFsPodRequest }
export class PodSolidFsHttpClient {
  public constructor(private readonly options: PodSolidFsHttpClientOptions) {}
  public request(input: string, init: RequestInit, context?: unknown): Promise<Response> {
    return this.options.request(input, init, context);
  }
}

export function resolvePodWorkspaceResourceUrl(relativePath: string, workspace: SolidFsManifest): string | undefined {
  try {
    const base = new URL(workspace.workspace.endsWith('/') ? workspace.workspace : `${workspace.workspace}/`);
    if (base.protocol !== 'http:' && base.protocol !== 'https:') {
      return undefined;
    }
    return new URL(normalizePodRelativePath(relativePath), base).href;
  } catch {
    return undefined;
  }
}

function normalizePodRelativePath(input: string): string {
  const parts = input.split(/[\\/]+/u).filter((part) => part.length > 0);
  if (input.startsWith('/') || parts.length === 0 || parts.includes('..')) {
    throw new Error(`Invalid Pod resource relative path: ${input}`);
  }
  return parts.join('/');
}
