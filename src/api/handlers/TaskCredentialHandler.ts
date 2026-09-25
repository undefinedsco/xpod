import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiServer } from '../ApiServer';
import type { AuthResult } from '../auth/Authenticator';
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
  /** Reuses the configured CSS authenticator; never trusts the claimed owner. */
  validateClientCredential?: (apiKey: string) => Promise<AuthResult>;
  /** Issuer the granted credential belongs to; part of the grant identity. */
  clientCredentialIssuer?: string;
  jsonBodyLimitBytes?: number;
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

  /**
   * The user's explicit grant: a credential the task layer may use while nobody is present.
   *
   * It takes the same `sk-` wrapper registration does, because that wrapper is the user's own
   * credential; the difference is what is stored - a task-layer grant, not an API-side copy.
   */
  server.post('/api/ai/task-credentials', async (request, response) => {
    const owner = requireOwner(request, response);
    if (!owner) return;
    if (!options.taskCredentials) {
      sendJson(response, 503, { error: 'task_credential_storage_unconfigured' });
      return;
    }
    if (!options.validateClientCredential || !options.clientCredentialIssuer) {
      sendJson(response, 503, { error: 'task_credential_grant_unavailable' });
      return;
    }
    const body = await readJsonObject(request, response, options.jsonBodyLimitBytes ?? 64 * 1024);
    if (!body) return;
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey : '';
    if (!validClientCredentialWrapper(apiKey)) {
      sendJson(response, 400, { error: 'A CSS client credential wrapper is required' });
      return;
    }
    const verified = await options.validateClientCredential(apiKey);
    if (!verified.success || verified.context?.type !== 'solid') {
      sendJson(response, verified.category === 'service_unavailable' ? 503 : 401, {
        error: 'CSS client credential verification failed',
      });
      return;
    }
    if (verified.context.webId !== owner) {
      sendJson(response, 403, { error: 'CSS client credential belongs to another WebID' });
      return;
    }
    if (!verified.context.clientId || !verified.context.clientSecret) {
      sendJson(response, 400, { error: 'CSS client credential is incomplete' });
      return;
    }
    try {
      // The user granted it just now, so it is active immediately; a program that needs the user
      // to confirm later creates a pending grant instead.
      const credential = await options.taskCredentials.grant({
        ownerWebId: owner,
        issuer: options.clientCredentialIssuer,
        clientId: verified.context.clientId,
        clientSecret: verified.context.clientSecret,
        status: 'active',
      });
      sendJson(response, 201, { credential });
    } catch (error) {
      sendTaskCredentialError(response, error);
    }
  });

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

function validClientCredentialWrapper(value: string): boolean {
  if (!value.startsWith('sk-')) return false;
  const encoded = value.slice(3);
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  return Buffer.from(decoded, 'utf8').toString('base64') === encoded
    && /^[^\s\x00-\x1f\x7f:]+:[^\s\x00-\x1f\x7f]+$/u.test(decoded);
}

async function readJsonObject(
  request: IncomingMessage,
  response: ServerResponse,
  limitBytes: number,
): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.byteLength;
    if (size > limitBytes) {
      sendJson(response, 413, { error: 'Request body is too large' });
      return undefined;
    }
    chunks.push(buffer);
  }
  if (size === 0) {
    sendJson(response, 400, { error: 'Request body is required' });
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      sendJson(response, 400, { error: 'Request body must be a JSON object' });
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    sendJson(response, 400, { error: 'Request body must be valid JSON' });
    return undefined;
  }
}
