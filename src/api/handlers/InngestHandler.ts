import { serve } from 'inngest/node';
import type { ApiServer, RouteHandler } from '../ApiServer';
import type { InngestRunExecutionBackend } from '../runs/InngestRunExecutionBackend';
import type { EmbeddedInngestRuntimeConfig } from '../runs/EmbeddedInngestService';
import type { InngestTaskScheduler } from '../tasks/InngestTaskScheduler';
import type { StoreContext } from '../chatkit/store';

export interface InngestHandlerOptions {
  backend: InngestRunExecutionBackend;
  taskScheduler?: InngestTaskScheduler<StoreContext>;
  runtimeConfig?: EmbeddedInngestRuntimeConfig;
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
  const routeHandler: RouteHandler = async (req, res) => {
    handler(req, res);
  };

  server.all('/api/inngest', routeHandler, { public: true });
  server.all('/api/inngest/*path', routeHandler, { public: true });
}
