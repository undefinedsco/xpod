import type { PodLookupRepository } from '../../identity/drizzle/PodLookupRepository';
import { getWebId } from '../auth/AuthContext';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import { MatrixError } from './MatrixError';
import type { MatrixStoreContext } from './types';

export type MatrixPodResolver = (webId: string, requestedPodUrl?: string) => Promise<string>;

/**
 * Select only registered Pod roots, without dereferencing user-supplied URLs.
 * Selection is not access authorization: shared Pod requests retain the caller's
 * credentials, and membership plus Solid ACL checks enforce their access.
 */
export function createMatrixPodResolver(
  repository: Pick<PodLookupRepository, 'findAllByWebId' | 'findByResourceIdentifier'>,
): MatrixPodResolver {
  return async (webId, requestedPodUrl) => {
    if (requestedPodUrl === undefined) {
      const pods = await repository.findAllByWebId(webId);
      if (pods.length === 0) {
        throw new MatrixError(404, 'M_NOT_FOUND', 'No Pod is registered for this WebID');
      }
      if (pods.length !== 1) {
        throw new MatrixError(400, 'M_INVALID_PARAM', 'Multiple Pods are registered; select one with X-Xpod-Pod-Url');
      }
      return normalizeRoot(pods[0].baseUrl);
    }

    const requested = normalizeRoot(requestedPodUrl);
    const pod = await repository.findByResourceIdentifier(requested);
    if (!pod || ![pod.baseUrl, pod.storageUrl].some(root => root !== undefined && normalizeRoot(root) === requested)) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'Selected URL is not a registered Pod root');
    }
    return normalizeRoot(pod.baseUrl);
  };
}

/** Preserve the authenticated caller; never borrow the selected Pod owner's credentials. */
export async function resolveMatrixContext(
  request: AuthenticatedRequest,
  resolver: MatrixPodResolver,
): Promise<MatrixStoreContext> {
  const auth = request.auth;
  const webId = auth ? getWebId(auth) : undefined;
  if (!webId) {
    throw new MatrixError(401, 'M_UNAUTHORIZED', 'Matrix API requires Solid WebID authentication');
  }
  const selection = request.headers['x-xpod-pod-url'];
  if (Array.isArray(selection)) {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'Provide exactly one X-Xpod-Pod-Url');
  }
  return { webId, auth, podUrl: await resolver(webId, selection) };
}

function normalizeRoot(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'Pod URL must be an absolute HTTP(S) URL');
  }
  if (!/^https?:\/\//i.test(value) || value !== value.trim() || /[\s\\?#]/u.test(value) ||
      !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'Pod URL must be HTTP(S) without credentials, query, or fragment');
  }
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
  return parsed.toString();
}
