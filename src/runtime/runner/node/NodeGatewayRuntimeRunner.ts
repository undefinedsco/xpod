import { GatewayProxy } from '../../Proxy';
import type {
  GatewayRuntimeHandle,
  GatewayRuntimeRunner,
  GatewayRuntimeRunnerStartOptions,
} from '../types';

export class NodeGatewayRuntimeRunner implements GatewayRuntimeRunner {
  public readonly name = 'node-gateway-runtime';

  public async start(options: GatewayRuntimeRunnerStartOptions): Promise<GatewayRuntimeHandle> {
    const gateway = new GatewayProxy(options.port, options.supervisor, options.bindHost, {
      socketPath: options.socketPath,
      exitOnStop: false,
      shutdownHandler: options.shutdownHandler,
      baseUrl: options.baseUrl,
      runtimeHost: options.runtimeHost,
    });

    gateway.setTargets(options.targets);
    await gateway.start();
    return gateway;
  }
}

export const nodeGatewayRuntimeRunner = new NodeGatewayRuntimeRunner();
