import { getLoggerFor } from 'global-logger-factory';
import type { PodLookupRepository } from '../../identity/drizzle/PodLookupRepository';

/**
 * Whether a Solid principal may act on an edge node.
 *
 * Reachability sessions expose a node's private candidates, so "is authenticated" is not
 * enough: the caller has to be related to that node (Pod ownership, or an explicit grant
 * once one exists).
 */
export type NodeAccessResolver = (nodeId: string, webId: string) => Promise<boolean>;

/**
 * Authorizes a WebID for a node when one of the node's Pods is owned by that WebID.
 *
 * A missing repository resolves to "no access" rather than "no restriction": the caller
 * decides what to do with an unprovable relationship, and the reachability handler denies.
 */
export function createPodOwnershipNodeAccessResolver(
  podLookupRepository: Pick<PodLookupRepository, 'listAllPods'> | undefined,
): NodeAccessResolver {
  const logger = getLoggerFor('NodeAccessResolver');
  return async (nodeId: string, webId: string): Promise<boolean> => {
    if (!podLookupRepository) {
      return false;
    }
    try {
      const pods = await podLookupRepository.listAllPods();
      return pods.some((pod) => {
        const hosted = pod.nodeId === nodeId || pod.edgeNodeId === nodeId;
        return hosted && (pod.webId === webId || (pod.webIds ?? []).includes(webId));
      });
    } catch (error) {
      logger.warn(`Failed to resolve node access for ${nodeId}/${webId}: ${(error as Error).message}`);
      return false;
    }
  };
}
