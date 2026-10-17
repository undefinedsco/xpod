import type { AuthContext, SolidAuthContext } from '../api/auth/AuthContext';
import { isSolidAuth } from '../api/auth/AuthContext';
import type { StoreContext } from '../api/chatkit/store';
import { createCallerAuthenticatedPodFetch } from '../api/ai-gateway/auth/CallerPodAccess';
import type { PodAccessFetchProvider, PodAccessRequestContext } from '../api/ai-gateway/pod/OwnerPodAccess';
import { PodSolidFsHttpClient as Client, type SolidFsPodRequest } from '@undefineds.co/xpod-afs/workcopy/PodSolidFsHttpClient';
export { resolvePodWorkspaceResourceUrl } from '@undefineds.co/xpod-afs/workcopy/PodSolidFsHttpClient';

export interface PodSolidFsHttpClientOptions {
  fetch?: typeof fetch;
  /** The host's shared, owner-bound authenticated Pod transport. */
  podAccess?: PodAccessFetchProvider;
}

export function createServerSolidFsPodRequest(options: PodSolidFsHttpClientOptions = {}): SolidFsPodRequest {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  return async (input, init, context) => {
    const auth = solidAuthFromContext(context);
    if (!auth) throw new Error('SolidFS Pod access requires an authenticated owner');
    const taskCredential = (context as PodAccessRequestContext).taskCredential;
    const authenticated = options.podAccess
      ? await options.podAccess.getPodFetch(auth.webId, { auth, ...(taskCredential ? { taskCredential } : {}) })
      : !taskCredential ? createCallerAuthenticatedPodFetch(auth.webId, auth, fetchImpl) : undefined;
    if (!authenticated) throw new Error('SolidFS Pod access is unavailable');
    // The shared provider signs DPoP and checks grant validity per request. A rejected write
    // is returned once; copying a token header or replaying with a refreshed token is unsafe.
    return authenticated(input, init);
  };
}

export class PodSolidFsHttpClient extends Client {
  public constructor(options: PodSolidFsHttpClientOptions = {}) { super({ request: createServerSolidFsPodRequest(options) }); }
}

export function solidAuthFromContext(context: unknown): SolidAuthContext | undefined {
  const auth = (context as StoreContext | undefined)?.auth as AuthContext | undefined;
  return auth && isSolidAuth(auth) ? auth : undefined;
}
