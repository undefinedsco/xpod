import { getLoggerFor } from 'global-logger-factory';
import { loadConfigFromEnv, type ApiContainerConfig } from '../api/container';
import { autoProvisionFirstRunLocal } from '../api/runtime';
import { closeAllIdentityConnections } from '../identity/drizzle/db';
import { Supervisor } from '../supervisor/Supervisor';
import {
  createCssRuntimeConfig,
  initRuntimeLogger,
  resolveRuntimeBootstrap,
} from './bootstrap';
import { DEFAULT_LOCAL_OIDC_ISSUER, resolveExternalOidcIssuer } from './oidc-issuer';
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
  let runtimeOptions = state.mode === 'local'
    && !state.apiOpen
    && !resolveExternalOidcIssuer({
      SOLID_OIDC_ISSUER: options.env?.SOLID_OIDC_ISSUER ?? platform.baseEnv.SOLID_OIDC_ISSUER,
    })
    ? {
        ...options,
        env: {
          ...options.env,
          SOLID_OIDC_ISSUER: DEFAULT_LOCAL_OIDC_ISSUER,
        },
      }
    : options;
  let environment = createRuntimeEnvironmentSession(state, runtimeOptions, platform);

  // Local+Cloud registration must finish before CSS reads oidcIssuer. Running
  // this in the API child is too late because CSS has already selected its IdP.
  if (
    state.mode === 'local'
    && !state.apiOpen
    && isExternalRuntimeIssuer(
      resolveExternalOidcIssuer({
        SOLID_OIDC_ISSUER: runtimeOptions.env?.SOLID_OIDC_ISSUER ?? environment.env.SOLID_OIDC_ISSUER,
      }),
      state.baseUrl,
    )
  ) {
    const provisioned = await autoProvisionFirstRunLocal(loadConfigFromEnv(), logger);
    if (provisioned.oidcIssuer) {
      if (provisioned.publicUrl) {
        state.canonicalBaseUrl = ensureCanonicalBaseUrl(provisioned.publicUrl);
      }
      environment.restore();
      delete process.env.SOLID_OIDC_ISSUER;
      runtimeOptions = withProvisionedRuntimeEnv(runtimeOptions, provisioned);
      environment = createRuntimeEnvironmentSession(state, runtimeOptions, platform);
    }
  }

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
      clientRemoteAddressResolver: options.gatewayClientRemoteAddressResolver,
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

function isExternalRuntimeIssuer(issuer: string | undefined, runtimeBaseUrl: string): boolean {
  if (!issuer) {
    return false;
  }

  try {
    const issuerUrl = new URL(issuer);
    const runtimeUrl = new URL(runtimeBaseUrl);
    const sameHost = issuerUrl.hostname === runtimeUrl.hostname
      || (isLoopbackHost(issuerUrl.hostname) && isLoopbackHost(runtimeUrl.hostname));
    return !(issuerUrl.protocol === runtimeUrl.protocol
      && issuerUrl.port === runtimeUrl.port
      && sameHost);
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function ensureCanonicalBaseUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Provisioned publicUrl must use http or https')
  }
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url.href
}

function withProvisionedRuntimeEnv(
  options: XpodRuntimeOptions,
  config: ApiContainerConfig,
): XpodRuntimeOptions {
  return {
    ...options,
    env: {
      ...options.env,
      SOLID_OIDC_ISSUER: config.oidcIssuer,
      XPOD_NODE_ID: config.nodeId,
      XPOD_NODE_TOKEN: config.nodeToken,
      XPOD_SERVICE_TOKEN: config.serviceToken,
      XPOD_PROVISION_CODE: config.provisionCode,
      XPOD_PUBLIC_URL: config.publicUrl,
      XPOD_SP_DOMAIN: config.spDomain,
      XPOD_LOCAL_SETUP_PATH: config.localSetupPath,
      XPOD_PROVIDER_ID: config.localSetupProviderId,
    },
  };
}

export type { XpodRuntimeHandle, XpodRuntimeOptions } from './runtime-types';
