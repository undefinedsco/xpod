import type { AuthContext, SolidAuthContext } from '../api/auth/AuthContext';
import { isSolidAuth } from '../api/auth/AuthContext';
import type { StoreContext } from '../api/chatkit/store';
import { createCallerAuthenticatedPodFetch } from '../api/ai-gateway/auth/CallerPodAccess';
import type { PodAccessFetchProvider, PodAccessRequestContext } from '../api/ai-gateway/pod/OwnerPodAccess';
import type { SolidFsManifest } from './types';

export interface PodSolidFsHttpClientOptions {
  fetch?: typeof fetch;
  /** The host's shared, owner-bound authenticated Pod transport. */
  podAccess?: PodAccessFetchProvider;
}

export class PodSolidFsHttpClient {
  private readonly fetchImpl: typeof fetch;

  public constructor(private readonly options: PodSolidFsHttpClientOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  public async request(input: string, init: RequestInit, context: unknown): Promise<Response> {
    const auth = solidAuthFromContext(context);
    if (!auth) throw new Error('SolidFS Pod access requires an authenticated owner');
    const taskCredential = (context as PodAccessRequestContext).taskCredential;
    const authenticated = this.options.podAccess
      ? await this.options.podAccess.getPodFetch(auth.webId, { auth, ...(taskCredential ? { taskCredential } : {}) })
      : !taskCredential ? createCallerAuthenticatedPodFetch(auth.webId, auth, this.fetchImpl) : undefined;
    if (!authenticated) throw new Error('SolidFS Pod access is unavailable');
    // The shared provider signs DPoP and checks grant validity per request. A rejected write
    // is returned once; copying a token header or replaying with a refreshed token is unsafe.
    return authenticated(input, init);
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

export function solidAuthFromContext(context: unknown): SolidAuthContext | undefined {
  const auth = (context as StoreContext | undefined)?.auth as AuthContext | undefined;
  return auth && isSolidAuth(auth) ? auth : undefined;
}

function normalizePodRelativePath(input: string): string {
  const parts = input.split(/[\\/]+/u).filter((part) => part.length > 0);
  if (input.startsWith('/') || parts.length === 0 || parts.includes('..')) {
    throw new Error(`Invalid Pod resource relative path: ${input}`);
  }
  return parts.join('/');
}
