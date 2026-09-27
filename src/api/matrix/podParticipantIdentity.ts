/**
 * Supplying a participant's own signing identity from their own Pod.
 *
 * The custody decision says a participant is their own Matrix server, and their key is
 * sealed in their own Pod. This module is the piece that connects that to the store's
 * `participantIdentity` hook: it decides *which* Pod is theirs, mints or reads back the
 * key there, and registers the resulting identity so the next event of theirs is signed
 * and attributed to their own server name.
 *
 * The decision this module makes deliberately conservatively:
 *
 * - only a Pod **registered to that WebID** is used, never the Pod a request happens to
 *   target (a shared room Pod belongs to somebody else, and a private key does not go
 *   into somebody else's Pod);
 * - if several Pods are registered, it does **not** guess. Minting a second key set for
 *   the same server name would make signatures ambiguous, so an ambiguous participant
 *   stays on the deployment identity until "which Pod holds the key" is answered;
 * - an already-registered server name short-circuits everything, so this costs nothing
 *   after the first time.
 *
 * Provisioning itself is idempotent (an existing key set is read back, never replaced),
 * so a race between two requests for the same new participant converges.
 */
import { getLoggerFor } from 'global-logger-factory';
import { webIdServerName } from './protocol/serverName';
import type { MatrixSigningIdentityProvider } from './signingKeyStore';
import type { MatrixSigningIdentityRegistry } from './identityRegistry';
import type { MatrixParticipantIdentityProvider } from './PodMatrixStore';
import type { MatrixStoreContext } from './types';
import type { PodLookupRepository } from '../../identity/drizzle/PodLookupRepository';

export interface ProvisionParticipantIdentityInput {
  serverName: string;
  ownerWebId: string;
  /** The participant's own Pod root, which holds the sealed key set. */
  podUrl: string;
  context: MatrixStoreContext;
}

export interface PodParticipantIdentityOptions {
  /** Where a provisioned identity is attached so it can sign. */
  registry: Pick<MatrixSigningIdentityRegistry, 'serverNames' | 'register'>;
  /** Registered Pod roots by WebID; the participant's own Pod is chosen from these. */
  pods: Pick<PodLookupRepository, 'findAllByWebId'>;
  /**
   * Mints or reads back the identity in that Pod. Injectable so the selection policy is
   * testable without Pod I/O; production passes `matrixSigningIdentityForPod`.
   */
  provision(input: ProvisionParticipantIdentityInput): Promise<{ provider: MatrixSigningIdentityProvider }>;
}

export function createPodParticipantIdentityProvider(
  options: PodParticipantIdentityOptions,
): MatrixParticipantIdentityProvider {
  const logger = getLoggerFor('PodParticipantIdentity');
  return {
    async ensureParticipantIdentity({ webId, context }) {
      const serverName = webIdServerName(webId);
      if (!serverName) return;
      // Already able to sign as this participant: nothing to read, nothing to mint.
      if (options.registry.serverNames().includes(serverName)) return;

      const own = registeredPodRoots(await options.pods.findAllByWebId(webId));
      if (own.length === 0) {
        logger.debug(`No Pod is registered for ${webId}; serving them under the deployment identity`);
        return;
      }
      if (own.length > 1) {
        // Guessing here would mint a second key set for one server name, which makes
        // every signature by that name ambiguous. Stay on the deployment identity.
        logger.warn(`Refusing to provision ${serverName}: ${webId} has several registered Pods and none is known to hold the key`);
        return;
      }

      const provisioned = await options.provision({ serverName, ownerWebId: webId, podUrl: own[0], context });
      options.registry.register(serverName, provisioned.provider);
      logger.info(`Provisioned the Matrix signing identity of ${serverName} in ${own[0]}`);
    },
  };
}

/**
 * The distinct Pod roots registered for a WebID, normalized and stable-ordered so the
 * same input always produces the same answer.
 */
function registeredPodRoots(pods: readonly { baseUrl?: string | null }[]): string[] {
  const roots = new Set<string>();
  for (const pod of pods) {
    const root = normalizePodRoot(pod.baseUrl);
    if (root) roots.add(root);
  }
  return [ ...roots ].sort();
}

function normalizePodRoot(baseUrl: string | null | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    const url = new URL(baseUrl);
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/+$/u, '');
  } catch {
    return undefined;
  }
}
