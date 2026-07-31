import type { ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { getLoggerFor } from 'global-logger-factory';
import type { ApiServer } from '../ApiServer';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';

export interface NetworkSettingsStatus {
  endpoint: string;
  addresses: {
    local: string[];
    lan: string[];
    public: string[];
  };
  tls: CapabilityStatus & { expiresAt?: string };
  dns: CapabilityStatus;
  tunnel: CapabilityStatus;
  actions: {
    diagnose: true;
    renewCertificate: boolean;
  };
}

export interface CapabilityStatus {
  supported: boolean;
  status: string;
}

export type DiagnosticStatus = 'ok' | 'warning' | 'error' | 'unsupported';

export interface NetworkDiagnosticCheckResult {
  id: string;
  label: string;
  status: DiagnosticStatus;
  detail?: string;
}

export interface NetworkDiagnosticCheck {
  id: string;
  label: string;
  run(): Promise<Omit<NetworkDiagnosticCheckResult, 'id' | 'label'> | DiagnosticStatus>;
}

export interface NetworkCapabilityReader<T extends CapabilityStatus = CapabilityStatus> {
  read(): Promise<T>;
}

export interface CertificateRenewer {
  renew(): Promise<void>;
}

export interface NetworkSettingsHandlerOptions {
  endpoint: string | (() => string | undefined);
  localAddresses?: () => string[];
  lanAddresses?: () => string[];
  publicAddresses?: () => string[];
  tlsStatusReader?: NetworkCapabilityReader<NetworkSettingsStatus['tls']>;
  dnsStatusReader?: NetworkCapabilityReader;
  tunnelStatusReader?: NetworkCapabilityReader;
  certificateRenewer?: CertificateRenewer;
  diagnostics?: NetworkDiagnosticCheck[];
  logger?: Pick<ReturnType<typeof getLoggerFor>, 'warn' | 'error'>;
}

export function registerNetworkSettingsRoutes(server: ApiServer, options: NetworkSettingsHandlerOptions): void {
  const logger = options.logger ?? getLoggerFor('NetworkSettingsHandler');

  server.get('/api/network/settings/status', async (request, response) => {
    if (!isSolidRequest(request)) {
      sendJson(response, 401, { error: 'Authentication required' });
      return;
    }

    try {
      sendJson(response, 200, await readNetworkStatus(options, logger));
    } catch (error) {
      logger.error(`Failed to read network settings status: ${redactSecretText(error)}`);
      sendJson(response, 500, { error: 'Failed to read network settings status' });
    }
  });

  server.post('/api/network/settings/diagnose', async (request, response) => {
    if (!isSolidRequest(request)) {
      sendJson(response, 401, { error: 'Authentication required' });
      return;
    }

    try {
      const diagnostics = options.diagnostics ?? buildDefaultDiagnostics(options, logger);
      const checks = await Promise.all(diagnostics.map((check) => runDiagnostic(check, logger)));
      sendJson(response, 200, { checks });
    } catch (error) {
      logger.error(`Failed to run network diagnostics: ${redactSecretText(error)}`);
      sendJson(response, 500, { error: 'Failed to run network diagnostics' });
    }
  });

  if (options.certificateRenewer) {
    server.post('/api/network/settings/certificate/renew', async (request, response) => {
      if (!isSolidRequest(request)) {
        sendJson(response, 401, { error: 'Authentication required' });
        return;
      }

      try {
        await options.certificateRenewer!.renew();
        sendJson(response, 200, { success: true });
      } catch (error) {
        logger.warn(`Failed to renew network certificate: ${redactSecretText(error)}`);
        sendJson(response, 500, { error: 'Failed to renew network certificate' });
      }
    });
  }
}

export function createAddressReaders(input: {
  endpoint: string | (() => string | undefined);
  port?: number;
  publicUrls?: Array<string | undefined>;
}): Pick<NetworkSettingsHandlerOptions, 'localAddresses' | 'lanAddresses' | 'publicAddresses'> {
  const endpoint = () => normalizeEndpoint(resolveValue(input.endpoint)) ?? '';
  return {
    localAddresses: () => uniqueUrls([
      endpoint(),
      input.port ? `http://127.0.0.1:${input.port}/` : undefined,
    ].filter((value): value is string => Boolean(value)).filter(isLoopbackEndpoint)),
    lanAddresses: () => {
      const port = input.port ?? readPort(endpoint());
      if (!port) return [];
      return readLanIpAddresses().map((host) => `http://${host}:${port}/`);
    },
    publicAddresses: () => uniqueUrls(input.publicUrls?.map(normalizeEndpoint).filter(Boolean) as string[] ?? []),
  };
}

export function createDdnsStatusReader(ddnsManager: unknown): NetworkCapabilityReader | undefined {
  if (!hasFunction(ddnsManager, 'getStatus')) {
    return undefined;
  }
  return {
    read: async () => {
      const status = ddnsManager.getStatus() as {
        allocated?: boolean;
        mode?: string;
        tunnelProvider?: string;
      };
      if (!status.allocated) {
        return { supported: true, status: 'pending' };
      }
      return { supported: true, status: status.mode === 'unknown' ? 'allocated' : status.mode ?? 'allocated' };
    },
  };
}

export function createTunnelStatusReader(tunnelProvider: unknown): NetworkCapabilityReader | undefined {
  if (!hasFunction(tunnelProvider, 'getStatus')) {
    return undefined;
  }
  return {
    read: async () => {
      const status = tunnelProvider.getStatus() as { running?: boolean; connected?: boolean; error?: string };
      if (status.connected) {
        return { supported: true, status: 'active' };
      }
      if (status.running) {
        return { supported: true, status: 'starting' };
      }
      if (status.error) {
        return { supported: true, status: 'error' };
      }
      return { supported: true, status: 'inactive' };
    },
  };
}

async function readNetworkStatus(
  options: NetworkSettingsHandlerOptions,
  logger: Pick<ReturnType<typeof getLoggerFor>, 'warn' | 'error'>,
): Promise<NetworkSettingsStatus> {
  const [tls, dns, tunnel] = await Promise.all([
    safeReadCapability(options.tlsStatusReader, { supported: false, status: 'unsupported' }, 'TLS', logger),
    safeReadCapability(options.dnsStatusReader, { supported: false, status: 'unsupported' }, 'DNS', logger),
    safeReadCapability(options.tunnelStatusReader, { supported: false, status: 'unsupported' }, 'Tunnel', logger),
  ]);
  return {
    endpoint: normalizeEndpoint(resolveValue(options.endpoint)) ?? '',
    addresses: {
      local: safeAddressList(options.localAddresses, logger),
      lan: safeAddressList(options.lanAddresses, logger),
      public: safeAddressList(options.publicAddresses, logger),
    },
    tls,
    dns,
    tunnel,
    actions: {
      diagnose: true,
      renewCertificate: Boolean(options.certificateRenewer),
    },
  };
}

async function safeReadCapability<T extends CapabilityStatus>(
  reader: NetworkCapabilityReader<T> | undefined,
  fallback: T,
  label: string,
  logger: Pick<ReturnType<typeof getLoggerFor>, 'warn' | 'error'>,
): Promise<T> {
  if (!reader) {
    return fallback;
  }
  try {
    return await reader.read();
  } catch (error) {
    logger.warn(`Failed to read ${label} status: ${redactSecretText(error)}`);
    return { ...fallback, supported: true, status: 'error' };
  }
}

function safeAddressList(
  reader: (() => string[]) | undefined,
  logger: Pick<ReturnType<typeof getLoggerFor>, 'warn' | 'error'>,
): string[] {
  if (!reader) return [];
  try {
    return uniqueUrls(reader().map(normalizeEndpoint).filter(Boolean) as string[]);
  } catch (error) {
    logger.warn(`Failed to read network addresses: ${redactSecretText(error)}`);
    return [];
  }
}

function buildDefaultDiagnostics(
  options: NetworkSettingsHandlerOptions,
  logger: Pick<ReturnType<typeof getLoggerFor>, 'warn' | 'error'>,
): NetworkDiagnosticCheck[] {
  return [
    {
      id: 'endpoint',
      label: 'Endpoint',
      run: async () => {
        const endpoint = normalizeEndpoint(resolveValue(options.endpoint));
        return endpoint ? { status: 'ok', detail: endpoint } : { status: 'unsupported', detail: 'endpoint_unavailable' };
      },
    },
    {
      id: 'tls',
      label: 'TLS',
      run: async () => capabilityToDiagnostic(await safeReadCapability(
        options.tlsStatusReader,
        { supported: false, status: 'unsupported' },
        'TLS',
        logger,
      )),
    },
    {
      id: 'dns',
      label: 'DNS',
      run: async () => capabilityToDiagnostic(await safeReadCapability(
        options.dnsStatusReader,
        { supported: false, status: 'unsupported' },
        'DNS',
        logger,
      )),
    },
    {
      id: 'tunnel',
      label: 'Tunnel',
      run: async () => capabilityToDiagnostic(await safeReadCapability(
        options.tunnelStatusReader,
        { supported: false, status: 'unsupported' },
        'Tunnel',
        logger,
      )),
    },
  ];
}

async function runDiagnostic(
  check: NetworkDiagnosticCheck,
  logger: Pick<ReturnType<typeof getLoggerFor>, 'warn' | 'error'>,
): Promise<NetworkDiagnosticCheckResult> {
  try {
    const result = await check.run();
    if (typeof result === 'string') {
      return { id: check.id, label: check.label, status: result };
    }
    return {
      id: check.id,
      label: check.label,
      status: result.status,
      ...(result.detail ? { detail: redactSecretText(result.detail) } : {}),
    };
  } catch (error) {
    logger.warn(`Network diagnostic ${check.id} failed: ${redactSecretText(error)}`);
    return { id: check.id, label: check.label, status: 'error', detail: redactSecretText(error) };
  }
}

function capabilityToDiagnostic(capability: CapabilityStatus): Omit<NetworkDiagnosticCheckResult, 'id' | 'label'> {
  if (!capability.supported) {
    return { status: 'unsupported', detail: capability.status };
  }
  if (capability.status === 'active' || capability.status === 'valid' || capability.status === 'synced' || capability.status === 'direct') {
    return { status: 'ok', detail: capability.status };
  }
  if (capability.status === 'error') {
    return { status: 'error', detail: capability.status };
  }
  return { status: 'warning', detail: capability.status };
}

function isSolidRequest(request: AuthenticatedRequest): boolean {
  return request.auth?.type === 'solid';
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(data));
}

function resolveValue(value: string | (() => string | undefined) | undefined): string | undefined {
  return typeof value === 'function' ? value() : value;
}

function normalizeEndpoint(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.toString().replace(/\/+$/u, '') + '/';
  } catch {
    return undefined;
  }
}

function uniqueUrls(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function isLoopbackEndpoint(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

function readPort(endpoint: string | undefined): number | undefined {
  if (!endpoint) return undefined;
  try {
    const url = new URL(endpoint);
    if (url.port) return Number.parseInt(url.port, 10);
    return url.protocol === 'https:' ? 443 : 80;
  } catch {
    return undefined;
  }
}

function readLanIpAddresses(): string[] {
  const result: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        result.push(entry.address);
      }
    }
  }
  return result;
}

function hasFunction<T extends string>(value: unknown, key: T): value is Record<T, (...args: never[]) => unknown> {
  return Boolean(value && typeof value === 'object' && typeof (value as Record<T, unknown>)[key] === 'function');
}

export function redactSecretText(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  const containsSensitiveValue = [
    /\b(?:token|secret|password|passwd|api[_-]?key|authorization|credential)\s*[=:]\s*[^,\s;]+/iu,
    /\b(?:postgres|postgresql|mysql|redis|mongodb|sqlite):\/\/[^,\s]+/iu,
    /\/(?:Users|home|var|tmp|private|etc)\/[^\s,;]+/iu,
  ].some((pattern) => pattern.test(raw));
  return containsSensitiveValue ? '[redacted]' : raw;
}
