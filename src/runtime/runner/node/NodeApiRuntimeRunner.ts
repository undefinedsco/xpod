import { startApiService, type ApiServiceHandle } from '../../../api/runtime';
import type { ApiRuntimeRunner, ApiRuntimeRunnerStartOptions } from '../types';

export class NodeApiRuntimeRunner implements ApiRuntimeRunner {
  public readonly name = 'node-api-runtime';

  public async start(options: ApiRuntimeRunnerStartOptions): Promise<ApiServiceHandle> {
    return startApiService({
      open: options.open,
      authContext: options.authContext,
      initializeLogger: false,
      runtimeHost: options.runtimeHost,
    });
  }
}

export const nodeApiRuntimeRunner = new NodeApiRuntimeRunner();
