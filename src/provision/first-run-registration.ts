/**
 * First-run Local Cloud registration, extracted from the API runtime so the
 * modular capability launcher can establish the canonical managed authority
 * BEFORE it creates the CSS child.
 *
 * This is the SAME implementation the legacy CLI and XpodRuntime already use;
 * it lives here so those callers and the modular launcher share one authority
 * without the CLI importing the whole API container.
 */
import { getLoggerFor } from 'global-logger-factory';
import { OFFICIAL_CLOUD_IDENTITY_ORIGIN, cloudApiEndpointFromIssuer } from '../runtime/oidc-issuer';
import {
  resolveLocalSetupPath, resolveLocalSetupProviderId, upsertLocalProvisionState,
} from './LocalProvisionState';
import type { TunnelProfile } from '../tunnel/TunnelProfiles';

/**
 * The narrow slice of runtime configuration that first-run registration reads.
 *
 * Declared structurally on purpose: importing the API container's config type
 * would drag the whole API type graph into the standalone CLI, which must keep
 * working without the API implementation installed.
 */
export interface FirstRunProvisionConfig {
  edition: string;
  host: string;
  port: number;
  rootDir?: string;
  baseUrl?: string;
  solidBaseUrl?: string;
  oidcIssuer?: string;
  socketPath?: string;
  nodeId?: string;
  nodeToken?: string;
  serviceToken?: string;
  provisionCode?: string;
  publicUrl?: string;
  spDomain?: string;
  cloudApiEndpoint?: string;
  cloudflareTunnelToken?: string;
  apiBaseUrl?: string;
  /** Same shape the API container config uses; only read by tunnel refresh. */
  activeTunnelProfile?: TunnelProfile;
  tunnelProvider?: string;
  localSetupPath?: string;
  localSetupProviderId?: string;
  identityDbUrl?: string;
  sparqlEndpoint?: string;
}

const OFFICIAL_CLOUD_API_ORIGIN = 'https://api.undefineds.co';

interface ProvisionNodeResponse {
  nodeId?: unknown;
  nodeToken?: unknown;
  serviceToken?: unknown;
  provisionCode?: unknown;
  publicUrl?: unknown;
  spDomain?: unknown;
  tunnelToken?: unknown;
  tunnelProvider?: unknown;
  tunnelEndpoint?: unknown;
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

function resolveApiBaseUrl(config: FirstRunProvisionConfig): string {
  if (process.env.XPOD_API_BASE_URL) {
    return process.env.XPOD_API_BASE_URL;
  }
  if (process.env.CSS_BASE_URL) {
    return process.env.CSS_BASE_URL;
  }
  if (config.socketPath) {
    return 'http://localhost/';
  }
  return `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`;
}

function resolveCloudIdentityUrl(config: FirstRunProvisionConfig): string | undefined {
  if (config.oidcIssuer) {
    return config.oidcIssuer;
  }

  try {
    const endpoint = new URL(config.cloudApiEndpoint ?? OFFICIAL_CLOUD_API_ORIGIN);
    const official = new URL(OFFICIAL_CLOUD_API_ORIGIN);
    return endpoint.hostname === official.hostname ? OFFICIAL_CLOUD_IDENTITY_ORIGIN : undefined;
  } catch {
    return undefined;
  }
}

export async function autoProvisionFirstRunLocal<T extends FirstRunProvisionConfig>(
  config: T,
  logger: ReturnType<typeof getLoggerFor>,
): Promise<T> {
  // Registration only enriches the caller's config; the cast preserves the
  // caller's exact config type (the API container config has many more fields).
  const runtimeBaseUrl = normalizeUrl(process.env.CSS_BASE_URL ?? resolveApiBaseUrl(config));
  if (
    config.edition !== 'local'
    || !config.oidcIssuer
    || isSameRuntimeOrigin(config.oidcIssuer, runtimeBaseUrl)
    || (
      config.nodeToken
      && config.serviceToken
      && !needsProvisionCodeRefresh(config)
      && !needsManagedTunnelRefresh(config)
    )
  ) {
    return config;
  }

  const cloudApiEndpoint = config.cloudApiEndpoint ?? cloudApiEndpointFromIssuer(config.oidcIssuer);
  const nodeId = config.nodeId;
  const explicitPublicUrl = normalizeUrl(process.env.XPOD_PUBLIC_URL ?? config.publicUrl);
  const fallbackLocalUrl = normalizeUrl(process.env.CSS_BASE_URL ?? resolveApiBaseUrl(config));
  if (!nodeId) {
    return config;
  }

  const requestBody: Record<string, unknown> = {
    nodeId,
    nodeToken: config.nodeToken,
    serviceToken: config.serviceToken,
    domainMode: config.spDomain || !explicitPublicUrl ? 'managed' : 'self-managed',
    spDomain: config.spDomain,
  };
  if (explicitPublicUrl) {
    requestBody.publicUrl = explicitPublicUrl;
  }
  const localPort = readPositiveInteger(
    process.env.XPOD_MAIN_PORT ?? process.env.CSS_PORT ?? process.env.XPOD_PORT ?? process.env.PORT,
  );
  if (localPort) {
    requestBody.localPort = localPort;
  }
  const tunnelToken = process.env.CLOUDFLARE_TUNNEL_TOKEN ?? process.env.SAKURA_TUNNEL_TOKEN ?? process.env.SAKURA_TOKEN;
  if (tunnelToken) {
    requestBody.tunnelToken = tunnelToken;
    requestBody.tunnelMode = 'client';
  }

  try {
    const endpoint = new URL('/provision/nodes', ensureTrailingSlash(cloudApiEndpoint)).toString();
    const timeoutMs = readPositiveInteger(process.env.XPOD_LOCAL_AUTO_PROVISION_TIMEOUT_MS) ?? 5_000;
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);
    const postProvision = (): Promise<Response> => fetch(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: abortController.signal,
    });
    let response: Response;
    try {
      response = await postProvision();
      if (
        !response.ok
        && ('localPort' in requestBody || 'tunnelToken' in requestBody)
      ) {
        await response.text().catch(() => '');
        delete requestBody.localPort;
        delete requestBody.tunnelToken;
        delete requestBody.tunnelMode;
        response = await postProvision();
      }
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      logger.warn(`First-run Local Cloud registration failed: ${detail || `HTTP ${response.status}`}`);
      return config;
    }

    const payload = await response.json().catch(() => undefined) as ProvisionNodeResponse | undefined;
    if (
      !payload
      || typeof payload.nodeId !== 'string'
      || typeof payload.nodeToken !== 'string'
      || typeof payload.serviceToken !== 'string'
      || typeof payload.provisionCode !== 'string'
    ) {
      logger.warn('First-run Local Cloud registration returned an incomplete response.');
      return config;
    }

    const nodeIdIssued = payload.nodeId;
    const nodeTokenIssued = payload.nodeToken;
    const serviceTokenIssued = payload.serviceToken;
    const provisionCodeIssued = payload.provisionCode;
    const requiresManagedRoute = requestBody.domainMode === 'managed' || typeof payload.spDomain === 'string';
    if (requiresManagedRoute && !hasManagedRouteProvisionCode(provisionCodeIssued)) {
      logger.warn('First-run Local Cloud registration returned a provision code without usable managed-route credentials.');
      return config;
    }
    const cloudIdentityUrl = resolveCloudIdentityUrl(config);
    const tunnelProvider = typeof payload.tunnelProvider === 'string' ? payload.tunnelProvider : undefined;
    const tunnelToken = typeof payload.tunnelToken === 'string' ? payload.tunnelToken : undefined;
    const tunnelEndpoint = typeof payload.tunnelEndpoint === 'string' ? payload.tunnelEndpoint : undefined;
    const cloudflareTunnelToken = tunnelProvider === 'cloudflare' && tunnelToken
      ? tunnelToken
      : config.cloudflareTunnelToken;
    const managedTunnelProfile = tunnelProvider === 'cloudflare' && tunnelToken
      ? {
        id: 'cloud-managed',
        provider: 'cloudflare' as const,
        label: 'Xpod Cloud Tunnel',
        publicUrl: tunnelEndpoint,
        credentialConfigured: true,
      }
      : config.activeTunnelProfile;
    const nextConfig: FirstRunProvisionConfig = {
      ...config,
      cloudApiEndpoint,
      nodeId: nodeIdIssued,
      nodeToken: nodeTokenIssued,
      serviceToken: serviceTokenIssued,
      provisionCode: provisionCodeIssued,
      publicUrl: typeof payload.publicUrl === 'string' ? payload.publicUrl : explicitPublicUrl ?? fallbackLocalUrl,
      spDomain: typeof payload.spDomain === 'string' ? payload.spDomain : config.spDomain,
      cloudflareTunnelToken,
      activeTunnelProfile: managedTunnelProfile,
      tunnelProvider: managedTunnelProfile?.provider ?? config.tunnelProvider,
      oidcIssuer: config.oidcIssuer ?? cloudIdentityUrl,
      localSetupPath: config.localSetupPath ?? resolveLocalSetupPath(process.env.XPOD_LOCAL_SETUP_PATH),
      localSetupProviderId: config.localSetupProviderId ?? resolveLocalSetupProviderId(process.env.XPOD_PROVIDER_ID),
    };

    process.env.XPOD_NODE_ID = nodeIdIssued;
    process.env.XPOD_NODE_TOKEN = nodeTokenIssued;
    process.env.XPOD_SERVICE_TOKEN = serviceTokenIssued;
    process.env.XPOD_PROVISION_CODE = provisionCodeIssued;
    if (nextConfig.spDomain) {
      process.env.XPOD_SP_DOMAIN = nextConfig.spDomain;
    }
    if (nextConfig.oidcIssuer) {
      process.env.XPOD_PROVISION_URL = `${nextConfig.oidcIssuer.replace(/\/+$/u, '')}/.account/create-pod/?provisionCode=${encodeURIComponent(provisionCodeIssued)}`;
    }

    upsertLocalProvisionState(nextConfig.localSetupPath!, nextConfig.localSetupProviderId!, {
      nodeId: nodeIdIssued,
      nodeToken: nodeTokenIssued,
      serviceToken: serviceTokenIssued,
      provisionCode: provisionCodeIssued,
      publicUrl: nextConfig.publicUrl,
      spDomain: nextConfig.spDomain,
      tunnelToken,
      tunnelProvider,
      tunnelEndpoint,
      cloudUrl: nextConfig.cloudApiEndpoint,
      cloudBaseUrl: nextConfig.oidcIssuer,
    });

    logger.info(`First-run Local Cloud registration completed for ${nodeIdIssued}`);
    return nextConfig as T;
  } catch (error) {
    logger.warn(`First-run Local Cloud registration failed: ${error}`);
    return config;
  }
}

function isSameRuntimeOrigin(issuer: string, runtimeBaseUrl: string | undefined): boolean {
  if (!runtimeBaseUrl) {
    return false;
  }

  try {
    const issuerUrl = new URL(issuer);
    const runtimeUrl = new URL(runtimeBaseUrl);
    const sameHost = issuerUrl.hostname === runtimeUrl.hostname
      || (isLoopbackHost(issuerUrl.hostname) && isLoopbackHost(runtimeUrl.hostname));
    return issuerUrl.protocol === runtimeUrl.protocol
      && issuerUrl.port === runtimeUrl.port
      && sameHost;
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function needsProvisionCodeRefresh(config: FirstRunProvisionConfig): boolean {
  if (!config.provisionCode) {
    return true;
  }
  if (config.spDomain) {
    return !hasManagedRouteProvisionCode(config.provisionCode);
  }
  return !hasFreshProvisionCode(config.provisionCode);
}

function hasFreshProvisionCode(code: string): boolean {
  const dotIndex = code.indexOf('.');
  if (dotIndex <= 0) {
    return true;
  }

  try {
    const payload = JSON.parse(Buffer.from(code.slice(0, dotIndex), 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    return typeof payload.exp === 'number'
      && payload.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function hasManagedRouteProvisionCode(code: string): boolean {
  const dotIndex = code.indexOf('.');
  if (dotIndex <= 0) {
    return false;
  }

  try {
    const payload = JSON.parse(Buffer.from(code.slice(0, dotIndex), 'base64url').toString('utf8')) as {
      nodeId?: unknown;
      routeAccessToken?: unknown;
      routeAccessTokenExp?: unknown;
      signalApiUrl?: unknown;
    };
    return typeof payload.nodeId === 'string'
      && typeof payload.signalApiUrl === 'string'
      && typeof payload.routeAccessToken === 'string'
      && typeof payload.routeAccessTokenExp === 'number'
      && payload.routeAccessTokenExp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function needsManagedTunnelRefresh(config: FirstRunProvisionConfig): boolean {
  return Boolean(
    config.spDomain
    && config.publicUrl
    && !config.cloudflareTunnelToken
    && process.env.XPOD_TUNNEL_PROVIDER !== 'none',
  );
}

function readPositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  try {
    return new URL(value.trim()).toString().replace(/\/+$/u, '') + '/';
  } catch {
    return value.trim();
  }
}
