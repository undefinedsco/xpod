import type { ServerResponse } from 'node:http';
import type { ApiServer } from '../ApiServer';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import {
  TASK_CREDENTIAL_NOT_ACTIVE,
  TASK_CREDENTIAL_NOT_FOUND,
  TASK_CREDENTIAL_OWNER_MISMATCH,
  TASK_CREDENTIAL_VERSION_CONFLICT,
  type TaskCredentialStore,
} from '../tasks/TaskCredentialStore';

export interface TaskCredentialHandlerOptions {
  /** The task layer's own credential store; absent when the deployment has no root key. */
  taskCredentials?: TaskCredentialStore;
}

/**
 * Grants the task layer may use while nobody is present.
 *
 * The store is the task layer's, so this surface only ever exposes metadata: no endpoint returns a
 * secret, and every route resolves the grant from the caller's own WebID.
 */
export function registerTaskCredentialRoutes(
  server: ApiServer,
  options: TaskCredentialHandlerOptions,
): void {
  const requireOwner = (request: AuthenticatedRequest, response: ServerResponse): string | undefined => {
    const auth = request.auth;
    if (!auth || auth.type !== 'solid' || !auth.webId) {
      sendJson(response, 401, { error: 'Authentication required' });
      return undefined;
    }
    return auth.webId;
  };

  server.get('/api/ai/task-credentials', async (request, response) => {
    const owner = requireOwner(request, response);
    if (!owner) return;
    if (!options.taskCredentials) {
      sendJson(response, 503, { error: 'task_credential_storage_unconfigured' });
      return;
    }
    const data = await options.taskCredentials.listForOwner(owner);
    sendJson(response, 200, { data });
  });

  server.post('/api/ai/task-credentials/:credentialRef/activate', async (request, response, params) => {
    const owner = requireOwner(request, response);
    if (!owner) return;
    if (!options.taskCredentials) {
      sendJson(response, 503, { error: 'task_credential_storage_unconfigured' });
      return;
    }
    const credentialRef = params.credentialRef;
    if (!await isOwnedBy(options.taskCredentials, credentialRef, owner)) {
      sendJson(response, 404, { error: TASK_CREDENTIAL_NOT_FOUND });
      return;
    }
    try {
      const activated = await options.taskCredentials.activate(credentialRef);
      sendJson(response, 200, { credential: activated });
    } catch (error) {
      sendTaskCredentialError(response, error);
    }
  });

  server.delete('/api/ai/task-credentials/:credentialRef', async (request, response, params) => {
    const owner = requireOwner(request, response);
    if (!owner) return;
    if (!options.taskCredentials) {
      sendJson(response, 503, { error: 'task_credential_storage_unconfigured' });
      return;
    }
    const credentialRef = params.credentialRef;
    if (!await isOwnedBy(options.taskCredentials, credentialRef, owner)) {
      sendJson(response, 404, { error: TASK_CREDENTIAL_NOT_FOUND });
      return;
    }
    try {
      await options.taskCredentials.revoke(credentialRef);
      sendJson(response, 200, { revoked: credentialRef });
    } catch (error) {
      sendTaskCredentialError(response, error);
    }
  });
}

/** Resolve a grant only when it belongs to the caller; another owner's reference looks absent. */
async function isOwnedBy(
  store: TaskCredentialStore,
  credentialRef: string,
  ownerWebId: string,
): Promise<boolean> {
  const grants = await store.listForOwner(ownerWebId);
  return grants.some((grant) => grant.credentialRef === credentialRef);
}

function sendTaskCredentialError(response: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith(TASK_CREDENTIAL_NOT_FOUND)) {
    sendJson(response, 404, { error: TASK_CREDENTIAL_NOT_FOUND });
    return;
  }
  if (message.startsWith(TASK_CREDENTIAL_NOT_ACTIVE)) {
    sendJson(response, 409, { error: TASK_CREDENTIAL_NOT_ACTIVE });
    return;
  }
  if (message.startsWith(TASK_CREDENTIAL_VERSION_CONFLICT)) {
    sendJson(response, 409, { error: TASK_CREDENTIAL_VERSION_CONFLICT });
    return;
  }
  if (message.startsWith(TASK_CREDENTIAL_OWNER_MISMATCH)) {
    sendJson(response, 403, { error: TASK_CREDENTIAL_OWNER_MISMATCH });
    return;
  }
  sendJson(response, 500, { error: 'task_credential_operation_failed' });
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(data));
}
