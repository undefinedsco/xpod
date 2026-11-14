import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Finalizable, WebSocketHandler } from '@solid/community-server';
import { createErrorMessage, guardStream, ServerConfigurator } from '@solid/community-server';
import { getLoggerFor } from 'global-logger-factory';
import { WebSocketServer } from 'ws';

interface OwnedWebSocketServer {
  server: Server;
  sockets: WebSocketServer;
  upgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
}

/** CSS-compatible upgrade handling with App-owned connection finalization. */
export class FinalizingWebSocketServerConfigurator extends ServerConfigurator implements Finalizable {
  private readonly logger = getLoggerFor(this);
  private readonly owned = new Set<OwnedWebSocketServer>();
  private stopping = false;
  private finalizing?: Promise<void>;

  public constructor(private readonly handler: WebSocketHandler) { super(); }

  public async handle(server: Server): Promise<void> {
    if (this.stopping) throw new Error('WebSocket configurator has already stopped');
    if ([...this.owned].some(entry => entry.server === server)) return;
    const sockets = new WebSocketServer({ noServer: true });
    const upgrade = (upgradeRequest: IncomingMessage, socket: Duplex, head: Buffer): void => {
      sockets.handleUpgrade(upgradeRequest, socket, head, (webSocket) => {
        void this.handler.handleSafe({ upgradeRequest: guardStream(upgradeRequest), webSocket }).catch((error: unknown) => {
          const message = createErrorMessage(error);
          this.logger.error(`Something went wrong handling a WebSocket connection: ${message}`);
          webSocket.send(`There was an error opening this WebSocket: ${message}`);
          webSocket.close();
        });
      });
    };
    this.owned.add({ server, sockets, upgrade });
    server.on('upgrade', upgrade);
  }

  public finalize(): Promise<void> {
    if (this.finalizing) return this.finalizing;
    this.stopping = true;
    this.finalizing = this.closeOwnedServers();
    return this.finalizing;
  }

  private async closeOwnedServers(): Promise<void> {
    const results = await Promise.allSettled([...this.owned].map(async(entry) => {
      entry.server.removeListener('upgrade', entry.upgrade);
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          entry.sockets.close((error?: Error) => error ? reject(error) : resolve());
          for (const socket of entry.sockets.clients) socket.close(1001, 'Server shutting down');
          timer = setTimeout(() => {
            timedOut = true;
            for (const socket of entry.sockets.clients) socket.terminate();
          }, 5_000);
          timer.unref?.();
        });
        this.owned.delete(entry);
        if (timedOut) throw new Error('WebSocket shutdown timed out; remaining connections were terminated');
      } finally { if (timer) clearTimeout(timer); }
    }));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length === 1) throw failures[0].reason;
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'WebSocket servers could not close');
  }
}
