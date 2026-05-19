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
  const handler = serve({
    client: options.backend.getClient(),
    functions: [
      options.backend.agentRunFunction,
      ...(options.taskScheduler?.getFunctions() ?? []),
    ] as any[],
  });
  const routeHandler: RouteHandler = async (req, res) => {
    handler(req, res);
  };

  server.all('/api/inngest', routeHandler, { public: true });
  server.all('/api/inngest/*path', routeHandler, { public: true });
}
