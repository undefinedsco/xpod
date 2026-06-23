export interface P2PRealnetAcceptancePlanOptions {
  apiBaseUrl: string;
  nodeId: string;
  nodeToken: string;
  baseUrl: string;
  targetBaseUrl: string;
  nodeHost?: string;
  nodeAddress?: string;
  nodeLocalAddress?: string;
  clientHost?: string;
  clientAddress?: string;
  clientLocalAddress?: string;
  clientId: string;
  token?: string;
  resourceUrl: string;
  runTimeoutMs?: number;
  connectTimeoutMs?: number;
  waitTimeoutMs?: number;
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
  winnerSelectionWindowMs?: number;
  windowSeconds?: number;
  maxClockErrorSeconds?: number;
  minRunWindowSeconds?: number;
  numPorts?: number;
  basePort?: number;
  portRange?: number;
}

export interface P2PRealnetAcceptanceCommand {
  role: 'node' | 'client';
  command: string[];
  shell: string;
  description: string;
}

export interface P2PRealnetAcceptanceMobilePlan {
  appLabel: 'LinX P2P Smoke';
  packageName: 'com.linxmobile.p2psmoke';
  fields: {
    idpUrl: string;
    storageUrl: string;
    clientId: string;
    resourcePath: string;
  };
  description: string;
}

export interface P2PRealnetAcceptancePlan {
  kind: 'raw-tcp-p2p-realnet-acceptance';
  node: P2PRealnetAcceptanceCommand;
  client: P2PRealnetAcceptanceCommand;
  mobile: P2PRealnetAcceptanceMobilePlan;
  successCriteria: string[];
  routeFallbacksPreserved: string[];
  caveats: string[];
}

export interface P2PRealnetAcceptanceVerifyOptions {
  clientId: string;
  expectedStatus?: number;
  expectedPutStatus?: number;
  requirePutStatus2xx?: boolean;
  nodeResult: unknown;
  clientResult: unknown;
}

export interface P2PRealnetAcceptanceCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface P2PRealnetAcceptanceVerification {
  smokeOk: boolean;
  checks: P2PRealnetAcceptanceCheck[];
  routeFallbacksPreserved: string[];
}

const FALLBACKS = ['Cloudflare Tunnel', 'FRP/SakuraFRP'] as const;

export function createP2PRealnetAcceptancePlan(
  options: P2PRealnetAcceptancePlanOptions,
): P2PRealnetAcceptancePlan {
  const apiBaseUrl = ensureTrailingSlash(options.apiBaseUrl);
  const signalEndpoint = new URL('/v1/signal', apiBaseUrl).toString();
  const nodeCommand = compactCommand([
    'bun',
    'run',
    'smoke:p2p:node-accept',
    '--signal-endpoint',
    signalEndpoint,
    '--node-id',
    options.nodeId,
    '--node-token',
    options.nodeToken,
    '--base-url',
    options.baseUrl,
    '--target-base-url',
    options.targetBaseUrl,
    ...optionalPair('--host', options.nodeHost),
    ...optionalPair('--address', options.nodeAddress),
    ...optionalPair('--local-address', options.nodeLocalAddress),
    ...optionalNumberPair('--connect-timeout-ms', options.connectTimeoutMs),
    ...optionalNumberPair('--winner-selection-window-ms', options.winnerSelectionWindowMs),
    ...optionalNumberPair('--run-timeout-ms', options.runTimeoutMs),
    '--require-accept',
  ]);
  const clientCommand = compactCommand([
    'bun',
    'run',
    'smoke:p2p:managed',
    '--api-base-url',
    apiBaseUrl,
    '--node-id',
    options.nodeId,
    '--client-id',
    options.clientId,
    ...optionalPair('--token', options.token),
    ...optionalPair('--host', options.clientHost),
    ...optionalPair('--address', options.clientAddress),
    ...optionalPair('--local-address', options.clientLocalAddress),
    '--resource-url',
    options.resourceUrl,
    ...optionalNumberPair('--connect-timeout-ms', options.connectTimeoutMs),
    ...optionalNumberPair('--winner-selection-window-ms', options.winnerSelectionWindowMs),
    ...optionalNumberPair('--wait-timeout-ms', options.waitTimeoutMs),
    ...optionalNumberPair('--poll-interval-ms', options.pollIntervalMs),
    ...optionalNumberPair('--request-timeout-ms', options.requestTimeoutMs),
    ...optionalNumberPair('--window-seconds', options.windowSeconds),
    ...optionalNumberPair('--max-clock-error-seconds', options.maxClockErrorSeconds),
    ...optionalNumberPair('--min-run-window-seconds', options.minRunWindowSeconds),
    ...optionalNumberPair('--num-ports', options.numPorts),
    ...optionalNumberPair('--base-port', options.basePort),
    ...optionalNumberPair('--port-range', options.portRange),
    '--require-p2p',
  ]);

  return {
    kind: 'raw-tcp-p2p-realnet-acceptance',
    node: {
      role: 'node',
      command: nodeCommand,
      shell: shellQuoteCommand(nodeCommand),
      description: 'Run this on the local node/SP machine that can reach the local CSS/SP target base URL.',
    },
    client: {
      role: 'client',
      command: clientCommand,
      shell: shellQuoteCommand(clientCommand),
      description: 'Run this from a second non-browser runtime on another network/device.',
    },
    mobile: createMobilePlan(options),
    successCriteria: [
      `node accepted at least one raw TCP P2P session for client ${options.clientId}`,
      'client selected route.kind=p2p and route.id=p2p-raw-tcp',
      'client emitted a raw TCP connector success event',
      'client evidence reports clientAddress=signal-observed',
      'node accepted evidence for the same client reports nodeAddress=signal-observed',
      'canonical Solid HTTP request returned the expected status over xpod-p2p-http/1',
      'mobile write/read validation may require both putStatus and status to match expected 2xx values',
      'both peers may omit host/address and rely on signal-observed address enrichment for port-only candidates',
      'Cloudflare Tunnel and FRP/SakuraFRP remain available as independent user-tunnel fallback routes',
    ],
    routeFallbacksPreserved: [...FALLBACKS],
    caveats: [
      'This is for non-browser runtimes only; it does not prove browser P2P because browsers cannot open raw TCP sockets.',
      'A successful loopback/local smoke is not enough; run the node and client commands from separate network contexts for cross-NAT evidence.',
      'When host/address is omitted, signal injects the observed address for port-only candidates; observed address discovery does not guarantee NAT reachability.',
      'Mobile smoke evidence must still be verified with the same realnet verifier; phone USB is only for install/log collection, not the data plane.',
      'Cloudflare Tunnel and FRP/SakuraFRP remain fallback routes and are not replaced by raw TCP P2P.',
    ],
  };
}

export function verifyP2PRealnetAcceptance(
  options: P2PRealnetAcceptanceVerifyOptions,
): P2PRealnetAcceptanceVerification {
  const node = asRecord(options.nodeResult);
  const client = asRecord(options.clientResult);
  const accepted = Array.isArray(node.accepted) ? node.accepted.filter(asRecord) : [];
  const route = asRecord(client.route);
  const connectorEvents = Array.isArray(client.connectorEvents) ? client.connectorEvents.filter(asRecord) : [];
  const routeFallbacksPreserved = fallbackEvidence(node);

  const checks: P2PRealnetAcceptanceCheck[] = [
    {
      name: 'node smoke ok',
      ok: node.smokeOk === true,
      detail: node.smokeOk === true ? 'node runner reported smokeOk=true' : 'node runner did not report smokeOk=true',
    },
    {
      name: 'node accepted client',
      ok: accepted.some((event) => event.clientId === options.clientId),
      detail: accepted.length > 0
        ? `accepted clients: ${accepted.map((event) => String(event.clientId ?? '<unknown>')).join(', ')}`
        : 'node runner accepted no sessions',
    },
    {
      name: 'client smoke ok',
      ok: client.smokeOk === true,
      detail: client.smokeOk === true ? 'client runner reported smokeOk=true' : 'client runner did not report smokeOk=true',
    },
    {
      name: 'client selected p2p route',
      ok: route.kind === 'p2p',
      detail: `client route.kind=${String(route.kind ?? '<missing>')}`,
    },
    {
      name: 'raw tcp connector succeeded',
      ok: connectorEvents.some((event) => event.type === 'success'),
      detail: connectorEvents.length > 0
        ? `connector events: ${connectorEvents.map((event) => String(event.type ?? '<unknown>')).join(', ')}`
        : 'client runner emitted no connector events',
    },
    {
      name: 'client address came from signal',
      ok: client.clientAddress === 'signal-observed',
      detail: `clientAddress=${String(client.clientAddress ?? '<missing>')}`,
    },
    {
      name: 'node address came from signal',
      ok: accepted.some((event) => event.clientId === options.clientId && event.nodeAddress === 'signal-observed'),
      detail: accepted.length > 0
        ? `accepted nodeAddress evidence: ${accepted.map((event) => `${String(event.clientId ?? '<unknown>')}=${String(event.nodeAddress ?? '<missing>')}`).join(', ')}`
        : 'node runner accepted no sessions',
    },
    {
      name: 'expected http status',
      ok: options.expectedStatus === undefined || client.status === options.expectedStatus,
      detail: options.expectedStatus === undefined
        ? 'no expected HTTP status was configured'
        : `client status=${String(client.status ?? '<missing>')}, expected=${options.expectedStatus}`,
    },
    {
      name: 'expected write http status',
      ok: options.expectedPutStatus === undefined || client.putStatus === options.expectedPutStatus,
      detail: options.expectedPutStatus === undefined
        ? 'no expected write HTTP status was configured'
        : `client putStatus=${String(client.putStatus ?? '<missing>')}, expected=${options.expectedPutStatus}`,
    },
    {
      name: 'write http status is 2xx',
      ok: options.requirePutStatus2xx !== true || is2xxStatus(client.putStatus),
      detail: options.requirePutStatus2xx !== true
        ? '2xx write HTTP status was not required'
        : `client putStatus=${String(client.putStatus ?? '<missing>')}`,
    },
    {
      name: 'tunnel fallbacks preserved',
      ok: FALLBACKS.every((fallback) => routeFallbacksPreserved.includes(fallback)),
      detail: `fallback evidence: ${routeFallbacksPreserved.join(', ') || '<none>'}`,
    },
  ];

  return {
    smokeOk: checks.every((check) => check.ok),
    checks,
    routeFallbacksPreserved,
  };
}


function createMobilePlan(options: P2PRealnetAcceptancePlanOptions): P2PRealnetAcceptanceMobilePlan {
  const resource = new URL(options.resourceUrl);
  const storageUrl = `${resource.origin}/`;
  return {
    appLabel: 'LinX P2P Smoke',
    packageName: 'com.linxmobile.p2psmoke',
    fields: {
      idpUrl: deriveIdpBaseUrlFromApiBaseUrl(options.apiBaseUrl),
      storageUrl,
      clientId: options.clientId,
      resourcePath: resource.pathname,
    },
    description: 'Install/run the mobile smoke package over USB/ADB/HDB/Xcode, log in on-device, and use the same clientId as the node acceptance command. The app obtains auth from its own client session; no signal token is a human input.',
  };
}

function deriveIdpBaseUrlFromApiBaseUrl(apiBaseUrl: string): string {
  const api = new URL(ensureTrailingSlash(apiBaseUrl));
  const labels = api.hostname.split('.');
  if (labels[0] === 'api' && labels.length > 1) {
    labels[0] = 'id';
  }
  return `${api.protocol}//${labels.join('.')}/`;
}

function optionalPair(name: string, value: string | undefined): string[] {
  return value === undefined || value.length === 0 ? [] : [name, value];
}

function optionalNumberPair(name: string, value: number | undefined): string[] {
  return value === undefined ? [] : [name, String(value)];
}

function compactCommand(parts: string[]): string[] {
  return parts.filter((part) => part.length > 0);
}

function shellQuoteCommand(command: string[]): string {
  return command.map(shellQuote).join(' ');
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function is2xxStatus(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 200 && value <= 299;
}

function fallbackEvidence(node: Record<string, unknown>): string[] {
  const explicit = Array.isArray(node.routeFallbacksPreserved)
    ? node.routeFallbacksPreserved.filter((value): value is string => typeof value === 'string')
    : [];
  const caveats = Array.isArray(node.caveats)
    ? node.caveats.filter((value): value is string => typeof value === 'string').join('\n')
    : '';
  return [...new Set([
    ...explicit,
    ...FALLBACKS.filter((fallback) => caveats.includes(fallback)),
  ])];
}
