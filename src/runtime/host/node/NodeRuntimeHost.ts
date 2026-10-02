import net from 'node:net';
import { findGatewayIngressPort, getFreePort } from '../../port-finder';
import { registerSocketFetchOrigin } from '../../socket-fetch';
import { registerSocketHttpOrigin } from '../../socket-http';
import { prepareSocketPath, removeSocketPath } from '../../socket-utils';
import type {
  RuntimeConnectionTarget,
  RuntimeHost,
  RuntimeListenEndpoint,
  RuntimeListenableServer,
  RuntimePortAllocationOptions,
  RuntimePorts,
  RuntimeTransport,
  RuntimeTransportPreference,
} from '../types';

export class NodeRuntimeHost implements RuntimeHost {
  public readonly name = 'node';

  public resolveTransport(preference?: RuntimeTransportPreference): RuntimeTransport {
    if (preference === 'socket' || preference === 'port') {
      return preference;
    }

    return process.platform === 'win32' ? 'port' : 'socket';
  }

  public async allocatePorts(options: RuntimePortAllocationOptions = {}): Promise<RuntimePorts> {
    const explicitPorts = [options.gatewayPort, options.cssPort, options.apiPort, options.ingressPort]
      .filter((port): port is number => port !== undefined);
    const selected = new Set(explicitPorts);
    if (selected.size !== explicitPorts.length) {
      throw new Error('Runtime service ports must be distinct');
    }
    // Probes release their sockets, so the OS cannot see ports planned for this runtime.
    // Reserve both explicit and newly selected ports locally until allocation finishes.
    const allocate = async (explicit: number | undefined, base: number): Promise<number> => {
      const port = explicit ?? await getFreePort(base, '127.0.0.1', undefined, selected);
      selected.add(port);
      return port;
    };
    const gateway = await allocate(options.gatewayPort, options.basePort ?? 5600);
    const css = await allocate(options.cssPort, gateway + 1);
    const api = await allocate(options.apiPort, css + 1);
    // Tunnels (and the P2P data plane) terminate here, and this listener never treats a
    // caller as local whatever headers it carries - that is the gate. Its port is the one
    // number the user copies into a provider console, so it is predictable rather than
    // random, and it is what the runtime reports as the tunnel origin.
    const ingress = options.ingressPort ?? await findGatewayIngressPort(gateway, selected);

    return { gateway, css, api, ingress };
  }

  public createListenEndpoint(options: { port?: number; host?: string; socketPath?: string }): RuntimeListenEndpoint {
    if (options.socketPath) {
      return {
        type: 'socket',
        socketPath: options.socketPath,
      };
    }

    return {
      type: 'port',
      host: options.host ?? '0.0.0.0',
      port: options.port ?? 0,
    };
  }

  public formatListenEndpoint(endpoint: RuntimeListenEndpoint): string {
    if (endpoint.type === 'socket') {
      return `unix://${endpoint.socketPath}`;
    }

    return `http://${endpoint.host}:${endpoint.port}`;
  }

  public async listen(server: RuntimeListenableServer, endpoint: RuntimeListenEndpoint): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);

      if (endpoint.type === 'socket') {
        prepareSocketPath(endpoint.socketPath);
        server.listen(endpoint.socketPath, () => resolve());
        return;
      }

      server.listen(endpoint.port, endpoint.host, () => resolve());
    });
  }

  public async close(server: RuntimeListenableServer, endpoint?: RuntimeListenEndpoint): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    if (endpoint?.type === 'socket') {
      removeSocketPath(endpoint.socketPath);
    }
  }

  public async waitForPortReady(port: number, host = '127.0.0.1', timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const ready = await new Promise<boolean>((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(500);
        socket.once('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.once('error', () => {
          socket.destroy();
          resolve(false);
        });
        socket.once('timeout', () => {
          socket.destroy();
          resolve(false);
        });
        socket.connect(port, host);
      });

      if (ready) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(`Timed out waiting for service on ${host}:${port}`);
  }

  public async isConnectionTargetReady(target: RuntimeConnectionTarget, timeoutMs = 1_500): Promise<boolean> {
    try {
      if (target.socketPath) {
        return await this.waitForSocketReady(target.socketPath, timeoutMs);
      }

      if (target.url) {
        const url = new URL(target.url);
        const port = parseInt(url.port || (url.protocol === 'https:' ? '443' : '80'), 10);
        return await this.waitForTcpProbe(port, url.hostname, timeoutMs);
      }

      return false;
    } catch {
      return false;
    }
  }

  public registerSocketOrigins(origin: string, socketPath: string): () => Promise<void> {
    const unregisterSocketFetch = registerSocketFetchOrigin(origin, socketPath);
    const unregisterSocketHttp = registerSocketHttpOrigin(origin, socketPath);

    return async(): Promise<void> => {
      await unregisterSocketFetch();
      await unregisterSocketHttp();
    };
  }

  public cleanupSocketPath(socketPath: string): void {
    removeSocketPath(socketPath);
  }

  private async waitForSocketReady(socketPath: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const ready = await new Promise<boolean>((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(500);
        socket.once('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.once('error', () => {
          socket.destroy();
          resolve(false);
        });
        socket.once('timeout', () => {
          socket.destroy();
          resolve(false);
        });
        socket.connect(socketPath);
      });

      if (ready) {
        return true;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return false;
  }

  private async waitForTcpProbe(port: number, host: string, timeoutMs: number): Promise<boolean> {
    try {
      await this.waitForPortReady(port, host, timeoutMs);
      return true;
    } catch {
      return false;
    }
  }
}

export const nodeRuntimeHost = new NodeRuntimeHost();
