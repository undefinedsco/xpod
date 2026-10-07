import type { TaskCredentialSource } from '../ai-gateway/pod/OwnerPodAccess';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import type { TaskAuthBindingSnapshot } from './TaskAuthBinding';

/** Program-owned execution identity. No artificial Agent row is written to a user's Pod. */
export const DEFAULT_TASK_AGENT = { iri: 'urn:xpod:agent:pi', runner: 'pi:pi' } as const;
export interface TaskAgentBinding { assignedTo: string; authBinding: TaskAuthBindingSnapshot }

/** Resolve only the task layer's prior explicit grant, never the current request's bearer key. */
export function createGrantedTaskAgentResolver(source: Pick<TaskCredentialSource, 'activeFor'>) {
  return async (request: AuthenticatedRequest): Promise<TaskAgentBinding | undefined> => {
    if (request.auth?.type !== 'solid') return undefined;
    const owner = request.auth.webId;
    const credential = await source.activeFor(owner);
    if (!credential) return undefined;
    return {
      assignedTo: DEFAULT_TASK_AGENT.iri,
      authBinding: {
        id: credential.credentialRef, kind: 'solid-client-credentials', webId: owner,
        clientId: credential.clientId, status: 'active', createdAt: Math.floor(Date.now() / 1000),
      },
    };
  };
}
