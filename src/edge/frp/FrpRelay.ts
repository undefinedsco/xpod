import net from 'node:net';
import { getLoggerFor } from '@solid/community-server';

export interface FrpRelayOptions {
  bindPort: number;
  targetHost: string;
  targetPort: number;
}

export class FrpRelay {
  private readonly logger = getLoggerFor(this);
  private server?: net.Server;

  public start(options: FrpRelayOptions): void {
    this.server = net.createServer((socket) => {
      const target = net.createConnection(options.targetPort, options.targetHost);
      socket.pipe(target);
      target.pipe(socket);
    });
    this.server.listen(options.bindPort, () => {
      this.logger.info(`FRP relay listening on ${options.bindPort}`);
    });
  }

  public stop(): void {
    this.server?.close();
    this.server = undefined;
  }
}
