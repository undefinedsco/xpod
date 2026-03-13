import { getLoggerFor } from 'global-logger-factory';
import { closeAllIdentityConnections } from '../identity/drizzle/db';
import { Supervisor } from '../supervisor/Supervisor';
import {
  createCssRuntimeConfig,
  initRuntimeLogger,
  resolveRuntimeBootstrap,
} from './bootstrap';
import { nodeRuntimeDriver } from './driver/node/NodeRuntimeDriver';
import { createRuntimeEnvironmentSession } from './environment';
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
  const driver = options.driver ?? nodeRuntimeDriver;
  const host = options.host ?? driver.host;
  const platform = options.platform ?? driver.platform;
  const cssRunner = options.cssRunner ?? driver.cssRunner;
  const apiRunner = options.apiRunner ?? driver.apiRunner;
  const gatewayRunner = options.gatewayRunner ?? driver.gatewayRunner;
  const id = platform.createRuntimeId();
  const state = await resolveRuntimeBootstrap(id, options, host, platform);

  initRuntimeLogger(state.logLevel, platform);
  const logger = getLoggerFor('XpodRuntime');
  const environment = createRuntimeEnvironmentSession(state, options, platform);

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
      cssRunner,
    });

    services.apiService = await startApiRuntime({
      state,
      host,
      supervisor,
      authContext: options.authContext,
      apiRunner,
    });

    services.gateway = await startGatewayRuntime({
      state,
      host,
      supervisor,
      shutdownHandler: stop,
      gatewayRunner,
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
          return platform.fetch(new URL(String(input), state.baseUrl), init);
        }
        return platform.fetch(input, init);
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
