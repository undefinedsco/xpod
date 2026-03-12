import { randomUUID } from 'node:crypto';
import { getLoggerFor } from 'global-logger-factory';
import { closeAllIdentityConnections } from '../identity/drizzle/db';
import { Supervisor } from '../supervisor/Supervisor';
import {
  createCssRuntimeConfig,
  initRuntimeLogger,
  resolveRuntimeBootstrap,
} from './bootstrap';
import { createRuntimeEnvironmentSession } from './environment';
import { nodeRuntimeHost } from './host/node/NodeRuntimeHost';
import {
  registerManagedRuntimeServices,
  startApiRuntime,
  startCssRuntime,
  startGatewayRuntime,
  stopRuntimeServices,
  type RuntimeServices,
} from './lifecycle';
import type { XpodRuntimeHandle, XpodRuntimeOptions } from './runtime-types';

export async function startXpodRuntime(options: XpodRuntimeOptions = {}): Promise<XpodRuntimeHandle> {
  const host = options.host ?? nodeRuntimeHost;
  const id = randomUUID().slice(0, 8);
  const state = await resolveRuntimeBootstrap(id, options, host);

  initRuntimeLogger(state.logLevel);
  const logger = getLoggerFor('XpodRuntime');
  const environment = createRuntimeEnvironmentSession(state, options);

  const unregisterSocketOrigins = state.transport === 'socket'
    ? host.registerSocketOrigins(state.baseUrl, state.sockets.gateway!)
    : async(): Promise<void> => undefined;

  const supervisor = new Supervisor({ handleProcessSignals: false });
  const services: RuntimeServices = {};
  let stopped = false;
  let stopPromise: Promise<void> | undefined;

  const stop = async(): Promise<void> => {
    if (stopPromise) {
      return stopPromise;
    }

    stopPromise = (async() => {
      if (stopped) {
        return;
      }
      stopped = true;

      await stopRuntimeServices({
        services,
        supervisor,
        logger,
        host,
        state,
        unregisterSocketOrigins,
        closeIdentityConnections: closeAllIdentityConnections,
        restoreRuntimeEnv: environment.restore,
      });
    })();

    return stopPromise;
  };

  registerManagedRuntimeServices(supervisor, services);

  try {
    services.cssApp = await startCssRuntime({
      state,
      host,
      runtimeShorthand: environment.shorthand,
      supervisor,
      open: options.open ?? false,
      createCssRuntimeConfig,
    });

    services.apiService = await startApiRuntime({
      state,
      host,
      supervisor,
      authContext: options.authContext,
    });

    services.gateway = await startGatewayRuntime({
      state,
      host,
      supervisor,
      shutdownHandler: stop,
    });
    environment.restore();

    return {
      id,
      mode: state.mode,
      transport: state.transport,
      baseUrl: state.baseUrl,
      supervisor,
      ports: state.ports,
      sockets: state.sockets,
      fetch: async(input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        if (typeof input === 'string' || input instanceof URL) {
          return fetch(new URL(String(input), state.baseUrl), init);
        }
        return fetch(input, init);
      },
      stop,
    };
  } catch (error) {
    environment.restore();
    await stop();
    throw error;
  }
}

export type { XpodRuntimeHandle, XpodRuntimeOptions } from './runtime-types';
