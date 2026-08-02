import type { ServerResponse } from 'node:http';
import type { ApiServer } from '../ApiServer';
import { DeviceNotificationTicketHandler, DeviceNotificationTicketStore } from './DeviceNotificationTicketHandler';
import { DeviceNotificationWebSocketServer } from '../../http/DeviceNotificationWebSocketServer';
import { DeviceNotificationHub } from '../../notifications/DeviceNotificationHub';
import { DeviceNotificationResourceListener } from '../../notifications/DeviceNotificationResourceListener';
import { ObservableResourceStore } from '../../storage/ObservableResourceStore';
import { XPOD_NOTIFICATIONS_PROTOCOL } from '../../notifications/device-notification-protocol';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';

export interface DeviceNotificationRuntimeOptions {
  origin: string;
  ticketEndpoint?: string;
  webSocketEndpoint?: string;
  ticketTtlMs?: number;
  authorizeTopic?: ConstructorParameters<typeof DeviceNotificationHub>[0]['authorizeTopic'];
}

export interface DeviceNotificationRuntimeHandle {
  hub: DeviceNotificationHub;
  ticketHandler: DeviceNotificationTicketHandler;
  webSocketServer: DeviceNotificationWebSocketServer;
  resourceListener: DeviceNotificationResourceListener;
  descriptor: {
    protocol: typeof XPOD_NOTIFICATIONS_PROTOCOL;
    ticketEndpoint: string;
    webSocketEndpoint: string;
  };
  stop(): void;
}

export function registerDeviceNotificationRuntime(
  server: ApiServer,
  options: DeviceNotificationRuntimeOptions,
): DeviceNotificationRuntimeHandle {
  const ticketEndpoint = options.ticketEndpoint ?? '/v1/notifications/tickets';
  const webSocketEndpoint = options.webSocketEndpoint ?? '/v1/notifications/ws';
  const descriptor: DeviceNotificationRuntimeHandle['descriptor'] = {
    protocol: XPOD_NOTIFICATIONS_PROTOCOL,
    ticketEndpoint,
    webSocketEndpoint,
  };
  const hub = new DeviceNotificationHub({
    origin: options.origin,
    authorizeTopic: options.authorizeTopic,
  });
  const ticketStore = new DeviceNotificationTicketStore();
  const ticketHandler = new DeviceNotificationTicketHandler({
    origin: options.origin,
    webSocketEndpoint,
    ticketTtlMs: options.ticketTtlMs,
    ticketStore,
  });
  const webSocketServer = new DeviceNotificationWebSocketServer({
    hub,
    ticketStore,
    path: webSocketEndpoint,
  });
  const resourceListener = new DeviceNotificationResourceListener({
    origin: options.origin,
    hub,
  });

  server.addResponseHeaders({
    'X-Xpod-Notifications': JSON.stringify(descriptor),
  });
  server.post(ticketEndpoint, async (request, response) => {
    await ticketHandler.handle(request as AuthenticatedRequest, response);
  });
  server.get('/.well-known/xpod-notifications', async (_request, response) => {
    sendJson(response, 200, descriptor);
  }, { public: true });
  server.addUpgradeHandler((request, socket, head) => {
    webSocketServer.handleUpgrade(request, socket, head);
  });
  ObservableResourceStore.addGlobalListener(resourceListener);
  server.addShutdownHandler(() => {
    webSocketServer.stop();
    ticketStore.clear();
    ObservableResourceStore.removeGlobalListener(resourceListener);
  });

  return {
    hub,
    ticketHandler,
    webSocketServer,
    resourceListener,
    descriptor,
    stop: () => {
      webSocketServer.stop();
      ticketStore.clear();
      ObservableResourceStore.removeGlobalListener(resourceListener);
    },
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(encoded),
  });
  response.end(encoded);
}
