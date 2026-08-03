import type { ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { getLoggerFor } from 'global-logger-factory';
import type { ApiServer } from '../ApiServer';
import type { AuthContext } from '../auth/AuthContext';
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
  renew(): Promise<CertificateRenewalResult | void>;
  isAvailable?(): boolean | Promise<boolean>;
}

export interface CertificateRenewalResult {
  status: 'renewed' | 'unchanged';
}

export interface NetworkSettingsAuthorizer {
  canRead(auth: AuthContext): boolean | Promise<boolean>;
  canWrite(auth: AuthContext): boolean | Promise<boolean>;
}

export interface NetworkSettingsIdentityAuthorizerOptions {
  deployment: 'cloud' | 'local';
  accountRoleRepository?: {
    findByWebId(webId: string): Promise<{ roles?: string[] } | undefined>;
  };
}

export interface CertificateCapability {
  tlsStatusReader?: NetworkCapabilityReader<NetworkSettingsStatus['tls']>;
  certificateRenewer?: CertificateRenewer;
}

export interface NetworkPublicAddressReaderOptions {
  configuredUrls?: Array<string | undefined>;
  ddnsManager?: unknown;
  tunnelProvider?: unknown;
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
  authorizer?: NetworkSettingsAuthorizer;
  logger?: Pick<ReturnType<typeof getLoggerFor>, 'warn' | 'error'>;
}

export function registerNetworkSettingsRoutes(server: ApiServer, options: NetworkSettingsHandlerOptions): void {
  const logger = options.logger ?? getLoggerFor('NetworkSettingsHandler');
  const authorizer = options.authorizer ?? createDeploymentNetworkSettingsAuthorizer();

  server.get('/api/network/settings/status', async (request, response) => {
    if (!await requireNetworkPermission(request, response, authorizer, 'read')) {
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
    if (!await requireNetworkPermission(request, response, authorizer, 'read')) {
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
      if (!await requireNetworkPermission(request, response, authorizer, 'write')) {
        return;
      }

      try {
        if (!await isCertificateRenewalAvailable(options.certificateRenewer, logger)) {
          sendJson(response, 503, {
            error: 'Certificate renewal is unavailable',
            code: 'certificate_renewal_unavailable',
          });
          return;
        }
        const result = await options.certificateRenewer!.renew();
        sendJson(response, 200, { success: true, status: result?.status ?? 'renewed' });
      } catch (error) {
        logger.warn(`Failed to renew network certificate: ${redactSecretText(error)}`);
        const renewalError = normalizeRenewalError(error);
        sendJson(response, renewalError.statusCode, {
          error: renewalError.message,
          code: renewalError.code,
        });
      }
    });
  }
}

export function createDeploymentNetworkSettingsAuthorizer(
  options?: NetworkSettingsIdentityAuthorizerOptions,
): NetworkSettingsAuthorizer {
  return {
    canRead: async (auth) => hasDeploymentNetworkScope(auth, 'network:read')
      || hasDeploymentNetworkScope(auth, 'network:write')
      || await isDeploymentOwnerOrAdmin(auth, options),
    canWrite: async (auth) => hasDeploymentNetworkScope(auth, 'network:write')
      || await isDeploymentOwnerOrAdmin(auth, options),
  };
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

export function createDnsStatusReader(input: {
  ddnsManager?: unknown;
  dnsProvider?: unknown;
  dnsCoordinator?: unknown;
}): NetworkCapabilityReader | undefined {
  const ddnsReader = createDdnsStatusReader(input.ddnsManager);
  if (ddnsReader) {
    return ddnsReader;
  }
  if (input.dnsProvider || input.dnsCoordinator) {
    return {
      read: async () => ({ supported: true, status: 'configured' }),
    };
  }
  return undefined;
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

export function createPublicAddressReader(options: NetworkPublicAddressReaderOptions): () => string[] {
  return () => uniqueUrls([
    ...(options.configuredUrls ?? []),
    readDdnsPublicUrl(options.ddnsManager),
    readTunnelEndpoint(options.tunnelProvider),
    readTunnelStatusEndpoint(options.tunnelProvider),
  ].map(normalizeEndpoint).filter(Boolean) as string[]);
}

export function createCertificateCapability(...candidates: unknown[]): CertificateCapability | undefined {
  for (const candidate of candidates) {
    const tlsStatusReader = createCertificateStatusReader(candidate);
    const certificateRenewer = createCertificateRenewer(candidate);
    if (tlsStatusReader || certificateRenewer) {
      return {
        ...(tlsStatusReader ? { tlsStatusReader } : {}),
        ...(certificateRenewer ? { certificateRenewer } : {}),
      };
    }
  }
  return undefined;
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
      renewCertificate: await isCertificateRenewalAvailable(options.certificateRenewer, logger),
    },
  };
}

async function isCertificateRenewalAvailable(
  renewer: CertificateRenewer | undefined,
  logger: Pick<ReturnType<typeof getLoggerFor>, 'warn' | 'error'>,
): Promise<boolean> {
  if (!renewer) {
    return false;
  }
  if (!renewer.isAvailable) {
    return true;
  }
  try {
    return Boolean(await renewer.isAvailable());
  } catch (error) {
    logger.warn(`Failed to read certificate renewal availability: ${redactSecretText(error)}`);
    return false;
  }
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

async function requireNetworkPermission(
  request: AuthenticatedRequest,
  response: ServerResponse,
  authorizer: NetworkSettingsAuthorizer,
  mode: 'read' | 'write',
): Promise<boolean> {
  if (!request.auth) {
    sendJson(response, 401, { error: 'Authentication required' });
    return false;
  }
  const allowed = mode === 'read'
    ? await authorizer.canRead(request.auth)
    : await authorizer.canWrite(request.auth);
  if (!allowed) {
    sendJson(response, 403, { error: `Missing required permission: network:${mode}` });
    return false;
  }
  return true;
}

function hasDeploymentNetworkScope(auth: AuthContext, scope: 'network:read' | 'network:write'): boolean {
  const scopes = readAuthScopes(auth);
  if (scopes.includes(scope)) {
    return true;
  }
  return false;
}

function readAuthScopes(auth: AuthContext): string[] {
  if (auth.type === 'service') {
    return auth.scopes;
  }
  return [];
}

async function isDeploymentOwnerOrAdmin(
  auth: AuthContext,
  options: NetworkSettingsIdentityAuthorizerOptions | undefined,
): Promise<boolean> {
  if (auth.type !== 'solid' || !options) {
    return false;
  }

  const roles = (await options.accountRoleRepository?.findByWebId(auth.webId))?.roles ?? [];
  return roles.includes('admin') || (options.deployment === 'local' && roles.includes('owner'));
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

function readDdnsPublicUrl(ddnsManager: unknown): string | undefined {
  if (!hasFunction(ddnsManager, 'getStatus')) {
    return undefined;
  }
  const status = ddnsManager.getStatus() as { allocated?: boolean; fqdn?: string; baseUrl?: string };
  if (status.baseUrl) {
    return status.baseUrl;
  }
  if (status.allocated && status.fqdn) {
    return `https://${status.fqdn}/`;
  }
  return undefined;
}

function readTunnelEndpoint(tunnelProvider: unknown): string | undefined {
  if (!hasFunction(tunnelProvider, 'getEndpoint')) {
    return undefined;
  }
  const endpoint = tunnelProvider.getEndpoint();
  return typeof endpoint === 'string' ? endpoint : undefined;
}

function readTunnelStatusEndpoint(tunnelProvider: unknown): string | undefined {
  if (!hasFunction(tunnelProvider, 'getStatus')) {
    return undefined;
  }
  const status = tunnelProvider.getStatus() as { endpoint?: string };
  return typeof status.endpoint === 'string' ? status.endpoint : undefined;
}

function createCertificateStatusReader(candidate: unknown): NetworkCapabilityReader<NetworkSettingsStatus['tls']> | undefined {
  const statusMethod = [
    'readCertificateStatus',
    'getCertificateStatus',
    'readTlsStatus',
    'getTlsStatus',
  ].find((method) => hasFunction(candidate, method));
  if (!statusMethod) {
    return undefined;
  }
  return {
    read: async () => normalizeCertificateStatus(
      await (candidate as Record<string, () => unknown>)[statusMethod](),
    ),
  };
}

function createCertificateRenewer(candidate: unknown): CertificateRenewer | undefined {
  const renewMethod = [
    'renewCertificate',
    'renew',
    'ensureCertificate',
  ].find((method) => hasFunction(candidate, method));
  if (!renewMethod) {
    return undefined;
  }
  return {
    renew: async () => {
      return await (candidate as Record<string, () => unknown>)[renewMethod]() as CertificateRenewalResult | void;
    },
    ...(hasFunction(candidate, 'isAvailable') ? {
      isAvailable: async () => Boolean(await (candidate as Record<string, () => unknown>).isAvailable()),
    } : {}),
  };
}

function normalizeRenewalError(error: unknown): { statusCode: number; code: string; message: string } {
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const statusCode = typeof record.statusCode === 'number' ? record.statusCode : undefined;
    const code = typeof record.code === 'string' ? record.code : undefined;
    const message = error instanceof Error ? error.message : undefined;
    if (statusCode && code) {
      return {
        statusCode,
        code,
        message: message ?? 'Certificate renewal failed',
      };
    }
  }
  return {
    statusCode: 500,
    code: 'certificate_renewal_failed',
    message: 'Failed to renew network certificate',
  };
}

function normalizeCertificateStatus(value: unknown): NetworkSettingsStatus['tls'] {
  if (typeof value === 'string') {
    return { supported: true, status: value };
  }
  if (!value || typeof value !== 'object') {
    return { supported: true, status: 'configured' };
  }
  const record = value as Record<string, unknown>;
  const nestedCertificate = record.certificate && typeof record.certificate === 'object'
    ? record.certificate as Record<string, unknown>
    : undefined;
  const status = typeof record.status === 'string' ? record.status : 'configured';
  const expiresAt = normalizeIsoDate(record.expiresAt ?? nestedCertificate?.expiresAt);
  return {
    supported: record.supported === false ? false : true,
    status,
    ...(expiresAt ? { expiresAt } : {}),
  };
}

function normalizeIsoDate(value: unknown): string | undefined {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : value;
  }
  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  }
  return undefined;
}

function hasFunction<T extends string>(value: unknown, key: T): value is Record<T, (...args: never[]) => unknown> {
  return Boolean(value && typeof value === 'object' && typeof (value as Record<T, unknown>)[key] === 'function');
}

export function redactSecretText(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  const containsSensitiveValue = [
    /\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer|dpop|basic)?\s*[^,\s;]+/iu,
    /\bdpop\s*[:=]\s*[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/iu,
    /\b(?:bearer|dpop)\s+[A-Za-z0-9._~+/=-]{8,}/iu,
    /\b(?:cookie|set-cookie)\s*[:=]\s*[^,\n]+/iu,
    /\b(?:token|secret|password|passwd|api[_-]?key|authorization|credential|clientSecret|client_secret)\s*[=:]\s*[^,\s;]+/iu,
    /(?:[?#&]|\b)(?:access_token|refresh_token|id_token|token_type)\s*=\s*[^&#\s;,]+/iu,
    /[?&]code=[^&#\s]+/iu,
    /\b(?:oauth|oidc|auth(?:orization)?|callback)\b[^,\n]*\bcode\s*[=:]\s*[^,\s;&]+/iu,
    /\bcode\s*[=:]\s*[^,\s;&]+[^,\n]*\b(?:oauth|oidc|auth(?:orization)?|callback)\b/iu,
    /\bxpod_(?:gw|inv)_[A-Za-z0-9._-]+/iu,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
    /"d"\s*:\s*"[^"]{8,}"/u,
    /\b(?:postgres|postgresql|mysql|redis|mongodb|sqlite):\/\/[^,\s]+/iu,
    /\bfile:\/\/\/[^\s,;]+/iu,
    /(?:^|\s)\/(?:Users|home|var|tmp|private|etc)\/[^\s,;]+/iu,
    /\b[A-Za-z]:[\\/][^\s,;]+/u,
    /\\\\[^\\\s,;]+\\[^\\\s,;]+\\[^\s,;]+/u,
  ].some((pattern) => pattern.test(raw));
  return containsSensitiveValue ? '[redacted]' : raw;
}
