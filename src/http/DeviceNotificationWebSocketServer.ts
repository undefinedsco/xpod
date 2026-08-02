import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { DeviceNotificationTicketStore } from '../api/handlers/DeviceNotificationTicketHandler';
import { DeviceNotificationHub } from '../notifications/DeviceNotificationHub';
import {
  XPOD_NOTIFICATIONS_PROTOCOL,
  createProtocolErrorFrame,
  parseClientFrame,
  parseDeviceNotificationSubprotocols,
  serializeServerFrame,
} from '../notifications/device-notification-protocol';

export interface DeviceNotificationWebSocketServerOptions {
  hub: DeviceNotificationHub;
  ticketStore: DeviceNotificationTicketStore;
  path?: string;
  heartbeatIntervalMs?: number;
}

export class DeviceNotificationWebSocketServer {
  private readonly hub: DeviceNotificationHub;
  private readonly ticketStore: DeviceNotificationTicketStore;
  private readonly path: string;
  private readonly heartbeatIntervalMs: number;
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly sockets = new Set<WebSocket>();
  private readonly socketConnections = new Map<WebSocket, string>();
  private readonly alive = new Map<WebSocket, boolean>();
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  public constructor(options: DeviceNotificationWebSocketServerOptions) {
    this.hub = options.hub;
    this.ticketStore = options.ticketStore;
    this.path = options.path ?? '/v1/notifications/ws';
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    this.startHeartbeat();
  }

  public attach(server: Server): void {
    server.on('upgrade', (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    });
  }

  public handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname !== this.path) {
      return;
    }
    const { protocolAccepted, ticket } = parseDeviceNotificationSubprotocols(request.headers['sec-websocket-protocol']);
    if (!protocolAccepted || !ticket) {
      this.reject(socket, 401, 'Missing notification subprotocol');
      return;
    }
    const record = this.ticketStore.consume(ticket);
    if (!record) {
      this.reject(socket, 401, 'Invalid notification ticket');
      return;
    }
    this.wss.handleUpgrade(request, socket as any, head, (ws) => {
      this.sockets.add(ws);
      const connection = this.hub.openConnection({
        identity: record.identity,
        deviceSessionId: record.deviceSessionId,
        send: (frame) => {
          if (ws.readyState !== WebSocket.OPEN) {
            return false;
          }
          ws.send(serializeServerFrame(frame));
          return true;
        },
        close: (code, reason) => {
          ws.close(code, reason);
        },
      });
      this.socketConnections.set(ws, connection.connectionId);
      this.alive.set(ws, true);
      ws.on('pong', () => {
        this.alive.set(ws, true);
      });
      ws.on('message', (data) => {
        void (async () => {
          try {
          const frame = parseClientFrame(JSON.parse(data.toString()), {
            origin: record.origin,
          });
            await this.handleFrame(connection.connectionId, frame);
          } catch (error) {
            ws.send(serializeServerFrame(createProtocolErrorFrame('bad-frame', (error as Error).message)));
          }
        })();
      });
      ws.on('close', () => {
        this.cleanupSocket(ws);
      });
      ws.on('error', () => {
        this.cleanupSocket(ws);
      });
    });
  }

  public stop(): void {
    for (const socket of this.sockets) {
      socket.close();
    }
    this.sockets.clear();
    this.socketConnections.clear();
    this.alive.clear();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.wss.close();
  }

  private async handleFrame(connectionId: string, frame: ReturnType<typeof parseClientFrame>): Promise<void> {
    switch (frame.type) {
      case 'hello':
        this.hub.hello(connectionId, frame.resumeFrom);
        break;
      case 'register':
        await this.hub.registerTopics(connectionId, frame.requestId, frame.topics);
        break;
      case 'unregister':
        await this.hub.unregisterTopics(connectionId, frame.requestId, frame.topics);
        break;
      case 'ack':
        this.hub.ack(connectionId, frame.sequence);
        break;
    }
  }

  private reject(socket: Duplex, status: number, message: string): void {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
    socket.end();
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const socket of this.sockets) {
        if (this.alive.get(socket) === false) {
          this.cleanupSocket(socket);
          socket.close();
          continue;
        }
        this.alive.set(socket, false);
        socket.ping();
      }
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private cleanupSocket(socket: WebSocket): void {
    this.sockets.delete(socket);
    this.alive.delete(socket);
    const connectionId = this.socketConnections.get(socket);
    this.socketConnections.delete(socket);
    if (connectionId) {
      this.hub.closeConnection(connectionId);
    }
  }
}
