import type { PodLookupRepository } from '../../identity/drizzle/PodLookupRepository';
import type { EdgeNodeRepository } from '../../identity/drizzle/EdgeNodeRepository';
import type { ApiServer } from '../ApiServer';
import type { NodeTokenAuthenticator } from '../auth/NodeTokenAuthenticator';
import type { PodDeletionOperationRepository } from '../../identity/drizzle/PodDeletionOperationRepository';

export function registerPodDeletionGrantRoutes(server: ApiServer, operations: PodDeletionOperationRepository, authenticator: NodeTokenAuthenticator, authorization?: { pods: PodLookupRepository; nodes: EdgeNodeRepository }): void {
  for (const action of ['claim', 'complete'] as const) {
    server.post(`/api/pod-deletions/:operationId/${action}`, async (request, response, params) => {
      const send = (status: number, body: unknown): void => {
        response.statusCode = status; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(body));
      };
      if (!authenticator.canAuthenticate(request)) { send(401, { error: 'POD_DELETE_NODE_AUTH_REQUIRED' }); return; }
      const auth = await authenticator.authenticate(request);
      if (!auth.success || auth.context?.type !== 'node' || !auth.context.nodeId) { send(401, { error: 'POD_DELETE_NODE_AUTH_REQUIRED' }); return; }
      let body: { grant?: unknown; storageUrl?: unknown };
      try {
        let data = '';
        for await (const chunk of request) {
          data += chunk.toString();
          if (data.length > 4096) { throw new Error('Request too large'); }
        }
        body = JSON.parse(data);
      } catch { send(400, { error: 'POD_DELETE_INVALID_COMMAND' }); return; }
      if (typeof body.grant !== 'string' || typeof body.storageUrl !== 'string') { send(400, { error: 'POD_DELETE_INVALID_COMMAND' }); return; }
      const original = await operations.get(params.operationId);
      if (!original || original.storageUrl !== body.storageUrl || original.nodeId !== auth.context.nodeId) {
        send(403, { error: 'POD_DELETE_INVALID_GRANT' }); return;
      }
      if (action === 'claim') {
        const operation = await operations.claim(params.operationId, auth.context.nodeId, body.grant);
        if (!operation) { send(403, { error: 'POD_DELETE_INVALID_GRANT' }); return; }
        send(200, { operation });
      } else {
        const accepted = await operations.acknowledge(params.operationId, auth.context.nodeId, body.grant, body.storageUrl);
        send(accepted ? 200 : 403, accepted ? { success: true } : { error: 'POD_DELETE_INVALID_GRANT' });
      }
    }, { public: true });
  }
  if (authorization) {
    for (const action of ['authorize-details', 'authorize'] as const) {
      const register = action === 'authorize-details' ? server.get.bind(server) : server.post.bind(server);
      register(`/api/pod-deletions/:operationId/${action}`, async (request, response, params) => {
        const send = (status: number, body: unknown): void => {
          response.statusCode = status; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(body));
        };
        if (!authenticator.canAuthenticate(request)) { send(401, { error: 'POD_DELETE_NODE_AUTH_REQUIRED' }); return; }
        const auth = await authenticator.authenticate(request);
        const nodeId = auth.success && auth.context?.type === 'node' ? auth.context.nodeId : undefined;
        if (!nodeId) { send(401, { error: 'POD_DELETE_NODE_AUTH_REQUIRED' }); return; }
        const challenge = request.headers['x-xpod-pod-authorization'];
        if (typeof challenge !== 'string' || challenge.split('.')[0] !== params.operationId) { send(403, { error: 'POD_DELETE_AUTHORIZATION_INVALID' }); return; }
        const details = await operations.authorizationDetails(challenge, nodeId);
        if (!details) { send(403, { error: 'POD_DELETE_AUTHORIZATION_INVALID' }); return; }
        const pod = await authorization.pods.findById(details.podId);
        const node = await authorization.nodes.findSpNodeByStorageUrl(details.storageUrl);
        if (!pod || pod.accountId !== details.accountId || pod.baseUrl !== details.storageUrl || node?.nodeId !== nodeId) {
          send(403, { error: 'POD_DELETE_AUTHORIZATION_INVALID' }); return;
        }
        if (await operations.find(details.accountId, details.podId) || await operations.remoteGeneration(details.podId, nodeId, details.storageUrl)) {
          send(409, { error: 'POD_DELETE_AUTHORIZATION_CONFLICT' }); return;
        }
        if (action === 'authorize-details') { send(200, { authorization: details }); return; }
        let body: { storageUrl?: unknown; remotePodId?: unknown; ownerWebIds?: unknown };
        try {
          let data = '';
          for await (const chunk of request) { data += chunk.toString(); if (data.length > 8192) { throw new Error('Body too large'); } }
          body = JSON.parse(data);
        } catch { send(400, { error: 'POD_DELETE_AUTHORIZATION_INVALID' }); return; }
        const owners = [pod.webId, ...(pod.webIds ?? [])].filter(Boolean);
        if (body.storageUrl !== details.storageUrl || typeof body.remotePodId !== 'string' || !body.remotePodId ||
          !Array.isArray(body.ownerWebIds) || !body.ownerWebIds.some((owner) => typeof owner === 'string' && owners.includes(owner))) {
          send(403, { error: 'POD_DELETE_AUTHORIZATION_INVALID' }); return;
        }
        const accepted = await operations.authorizeGeneration(challenge, nodeId, body.remotePodId);
        send(accepted ? 200 : 409, accepted ? { success: true, returnUrl: details.returnUrl } : { error: 'POD_DELETE_AUTHORIZATION_CONFLICT' });
      }, { public: true });
    }
  }

}
