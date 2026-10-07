import { serve } from 'inngest/node';
import type { ServerResponse } from 'node:http';
import type { ApiServer, RouteHandler } from '../ApiServer';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import type { InngestRunExecutionBackend } from '../runs/InngestRunExecutionBackend';
import type { EmbeddedInngestRuntimeConfig } from '../runs/EmbeddedInngestService';
import type { InngestTaskScheduler } from '../tasks/InngestTaskScheduler';
import type { StoreContext } from '../chatkit/store';
import { isLoopbackRemoteAddress, verifyGatewayAdminProxyHeaders } from '../../runtime/GatewayAdminProxyAuth';

export interface InngestHandlerOptions {
  backend: InngestRunExecutionBackend;
  taskScheduler?: InngestTaskScheduler<StoreContext>;
  runtimeConfig?: EmbeddedInngestRuntimeConfig;
  /**
   * Shared secret the Gateway uses to sign its internal proxy marker. Required
   * to keep the spawned dev executor's unsigned callback local: the dev Inngest
   * SDK skips signature validation, so this route must reject a callback that
   * the Gateway reports came from a non-loopback (tunnelled/P2P) client.
   */
  gatewayAdminProxyAuthSecret?: string;
}

export function registerInngestRoutes(server: ApiServer, options: InngestHandlerOptions): void {
  if (options.runtimeConfig?.enabled !== true) {
    return;
  }

  const functionEndpoint = options.runtimeConfig.functionEndpoint
    ? new URL(options.runtimeConfig.functionEndpoint)
    : undefined;
  const handler = serve({
    client: options.backend.getClient(),
    functions: [
      options.backend.agentRunFunction,
      ...(options.taskScheduler?.getFunctions() ?? []),
    ] as any[],
    serveOrigin: functionEndpoint?.origin,
    servePath: functionEndpoint?.pathname,
  });
  // A managed executor signs its callbacks, so the SDK itself rejects anything
  // unsigned or forged. The spawned `inngest dev` executor cannot sign, so the
  // dev route must prove the caller is local instead; otherwise the public
  // callback route would let any client that reaches the Gateway execute Runs.
  const authorizeDevCallback = options.runtimeConfig.mode === 'spawn'
    ? createDevCallbackAuthorizer(options.gatewayAdminProxyAuthSecret)
    : undefined;
  const routeHandler: RouteHandler = async (req, res) => {
    if (authorizeDevCallback && !authorizeDevCallback(req as AuthenticatedRequest, res)) {
      return;
    }
    handler(req, res);
  };

  server.all('/api/inngest', routeHandler, { public: true });
  server.all('/api/inngest/*path', routeHandler, { public: true });
}

function createDevCallbackAuthorizer(
  secret: string | undefined,
): (req: AuthenticatedRequest, res: ServerResponse) => boolean {
  return (req, res) => {
    // Trust model mirrors ConfiguredLoopbackDPoPWebIdExtractor.trustedLocalRouteTransport.
    // A present marker is authoritative: accept it only when the Gateway's HMAC
    // verifies AND it reports the original client as loopback. The default
    // non-Windows transport is a Unix domain socket where req.socket.remoteAddress
    // is undefined, so a legitimate signed local Gateway callback has a marker
    // but no peer address - requiring both would reject it.
    const marker = verifyGatewayAdminProxyHeaders({
      headers: req.headers,
      secret,
      method: req.method,
      url: req.url,
    });
    if (marker.present) {
      if (marker.valid && marker.originalClientLoopback) {
        return true;
      }
      return denyDevCallback(res);
    }
    // No marker: only a direct TCP loopback caller may be the dev executor.
    // A non-loopback peer (or a socket with no peer address) is not local.
    if (isLoopbackRemoteAddress(req.socket?.remoteAddress)) {
      return true;
    }
    return denyDevCallback(res);
  };
}

function denyDevCallback(res: ServerResponse): false {
  res.statusCode = 403;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'Inngest dev callback is restricted to the local executor' }));
  return false;
}
