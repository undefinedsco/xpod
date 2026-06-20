import { buildAuthenticatedFetch, EVENTS, type ILoginInputOptions, type SessionTokenSet } from '@inrupt/solid-client-authn-core';
import { Session } from '@inrupt/solid-client-authn-node';
import type { PeerConfig } from 'werift';
import {
  createWeriftSignaledP2PDataPlaneClientFromApi,
  type WeriftSignaledP2PDataPlaneClient,
} from './WeriftSignaledDataChannelP2PTransport';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_TRANSPORT_TIMEOUT_MS = 10_000;

export interface WeriftP2PSmokeSolidAuthOptions {
  oidcIssuer: string;
  clientId: string;
  clientSecret: string;
  tokenType?: ILoginInputOptions['tokenType'];
}

export interface WeriftP2PSmokeOptions {
  apiBaseUrl: string;
  nodeId: string;
  token?: string;
  sourceId: string;
  url: string;
  method?: string;
  headers?: [string, string][];
  body?: string;
  expectStatus?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  transportTimeoutMs?: number;
  peerConfig?: Partial<PeerConfig>;
  solidAuth?: WeriftP2PSmokeSolidAuthOptions;
}

export interface WeriftP2PSmokeResult {
  sessionId: string;
  routeKind: string;
  routeTargetUrl: string;
  status: number;
  statusText: string;
  headers: [string, string][];
  bodyText: string;
  authWebId?: string;
}

export type WeriftP2PSmokeCreateClient = (
  options: Parameters<typeof createWeriftSignaledP2PDataPlaneClientFromApi>[0],
) => Promise<WeriftSignaledP2PDataPlaneClient>;

export interface WeriftP2PSmokeAuthenticatedFetch {
  fetch: typeof fetch;
  webId?: string;
  close?: () => Promise<void>;
}

export type WeriftP2PSmokeCreateAuthenticatedFetch = (
  options: WeriftP2PSmokeSolidAuthOptions & { fetchImpl: typeof fetch },
) => Promise<WeriftP2PSmokeAuthenticatedFetch>;

export interface WeriftP2PSmokeDeps {
  createClient?: WeriftP2PSmokeCreateClient;
  createAuthenticatedFetch?: WeriftP2PSmokeCreateAuthenticatedFetch;
}

export function parseWeriftP2PSmokeArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): WeriftP2PSmokeOptions {
  const parsed: Partial<WeriftP2PSmokeOptions> = {
    apiBaseUrl: env.XPOD_P2P_API_BASE_URL,
    nodeId: env.XPOD_P2P_NODE_ID,
    token: env.XPOD_P2P_TOKEN,
    sourceId: env.XPOD_P2P_SOURCE_ID,
    url: env.XPOD_P2P_URL,
    method: env.XPOD_P2P_METHOD,
    body: env.XPOD_P2P_BODY,
    headers: [],
    solidAuth: parseSolidAuthFromEnv(env),
  };

  if (env.XPOD_P2P_EXPECT_STATUS) parsed.expectStatus = parseStatus(env.XPOD_P2P_EXPECT_STATUS, 'XPOD_P2P_EXPECT_STATUS');
  if (env.XPOD_P2P_TIMEOUT_MS) parsed.timeoutMs = parsePositiveInteger(env.XPOD_P2P_TIMEOUT_MS, 'XPOD_P2P_TIMEOUT_MS');
  if (env.XPOD_P2P_POLL_INTERVAL_MS) parsed.pollIntervalMs = parsePositiveInteger(env.XPOD_P2P_POLL_INTERVAL_MS, 'XPOD_P2P_POLL_INTERVAL_MS');
  if (env.XPOD_P2P_TRANSPORT_TIMEOUT_MS) parsed.transportTimeoutMs = parsePositiveInteger(env.XPOD_P2P_TRANSPORT_TIMEOUT_MS, 'XPOD_P2P_TRANSPORT_TIMEOUT_MS');
  if (env.XPOD_P2P_ICE_SERVERS) parsed.peerConfig = mergePeerConfig(parsed.peerConfig, { iceServers: parseIceServers(env.XPOD_P2P_ICE_SERVERS, 'XPOD_P2P_ICE_SERVERS') });
  if (env.XPOD_P2P_ICE_TRANSPORT_POLICY) {
    parsed.peerConfig = mergePeerConfig(parsed.peerConfig, {
      iceTransportPolicy: parseIceTransportPolicy(env.XPOD_P2P_ICE_TRANSPORT_POLICY, 'XPOD_P2P_ICE_TRANSPORT_POLICY'),
    });
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      index += 1;
      if (index >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[index];
    };

    if (arg === '--help' || arg === '-h') throw new WeriftP2PSmokeUsageError();
    else if (arg === '--api-base-url') parsed.apiBaseUrl = next();
    else if (arg.startsWith('--api-base-url=')) parsed.apiBaseUrl = arg.slice('--api-base-url='.length);
    else if (arg === '--node-id') parsed.nodeId = next();
    else if (arg.startsWith('--node-id=')) parsed.nodeId = arg.slice('--node-id='.length);
    else if (arg === '--token') parsed.token = next();
    else if (arg.startsWith('--token=')) parsed.token = arg.slice('--token='.length);
    else if (arg === '--source-id') parsed.sourceId = next();
    else if (arg.startsWith('--source-id=')) parsed.sourceId = arg.slice('--source-id='.length);
    else if (arg === '--url') parsed.url = next();
    else if (arg.startsWith('--url=')) parsed.url = arg.slice('--url='.length);
    else if (arg === '--method' || arg === '-X') parsed.method = next();
    else if (arg.startsWith('--method=')) parsed.method = arg.slice('--method='.length);
    else if (arg === '--header' || arg === '-H') parsed.headers!.push(parseHeader(next(), arg));
    else if (arg.startsWith('--header=')) parsed.headers!.push(parseHeader(arg.slice('--header='.length), '--header'));
    else if (arg === '--body' || arg === '-d') parsed.body = next();
    else if (arg.startsWith('--body=')) parsed.body = arg.slice('--body='.length);
    else if (arg === '--expect-status') parsed.expectStatus = parseStatus(next(), arg);
    else if (arg.startsWith('--expect-status=')) parsed.expectStatus = parseStatus(arg.slice('--expect-status='.length), '--expect-status');
    else if (arg === '--timeout-ms') parsed.timeoutMs = parsePositiveInteger(next(), arg);
    else if (arg.startsWith('--timeout-ms=')) parsed.timeoutMs = parsePositiveInteger(arg.slice('--timeout-ms='.length), '--timeout-ms');
    else if (arg === '--poll-interval-ms') parsed.pollIntervalMs = parsePositiveInteger(next(), arg);
    else if (arg.startsWith('--poll-interval-ms=')) parsed.pollIntervalMs = parsePositiveInteger(arg.slice('--poll-interval-ms='.length), '--poll-interval-ms');
    else if (arg === '--transport-timeout-ms') parsed.transportTimeoutMs = parsePositiveInteger(next(), arg);
    else if (arg.startsWith('--transport-timeout-ms=')) parsed.transportTimeoutMs = parsePositiveInteger(arg.slice('--transport-timeout-ms='.length), '--transport-timeout-ms');
    else if (arg === '--solid-oidc-issuer') parsed.solidAuth = { ...parsed.solidAuth, oidcIssuer: requireHttpOrigin(next(), arg) } as WeriftP2PSmokeSolidAuthOptions;
    else if (arg.startsWith('--solid-oidc-issuer=')) parsed.solidAuth = { ...parsed.solidAuth, oidcIssuer: requireHttpOrigin(arg.slice('--solid-oidc-issuer='.length), '--solid-oidc-issuer') } as WeriftP2PSmokeSolidAuthOptions;
    else if (arg === '--solid-client-id') parsed.solidAuth = { ...parsed.solidAuth, clientId: next() } as WeriftP2PSmokeSolidAuthOptions;
    else if (arg.startsWith('--solid-client-id=')) parsed.solidAuth = { ...parsed.solidAuth, clientId: arg.slice('--solid-client-id='.length) } as WeriftP2PSmokeSolidAuthOptions;
    else if (arg === '--solid-client-secret') parsed.solidAuth = { ...parsed.solidAuth, clientSecret: next() } as WeriftP2PSmokeSolidAuthOptions;
    else if (arg.startsWith('--solid-client-secret=')) parsed.solidAuth = { ...parsed.solidAuth, clientSecret: arg.slice('--solid-client-secret='.length) } as WeriftP2PSmokeSolidAuthOptions;
    else if (arg === '--solid-token-type') parsed.solidAuth = { ...parsed.solidAuth, tokenType: parseTokenType(next(), arg) } as WeriftP2PSmokeSolidAuthOptions;
    else if (arg.startsWith('--solid-token-type=')) parsed.solidAuth = { ...parsed.solidAuth, tokenType: parseTokenType(arg.slice('--solid-token-type='.length), '--solid-token-type') } as WeriftP2PSmokeSolidAuthOptions;
    else if (arg === '--ice-servers') parsed.peerConfig = mergePeerConfig(parsed.peerConfig, { iceServers: parseIceServers(next(), arg) });
    else if (arg.startsWith('--ice-servers=')) parsed.peerConfig = mergePeerConfig(parsed.peerConfig, { iceServers: parseIceServers(arg.slice('--ice-servers='.length), '--ice-servers') });
    else if (arg === '--ice-transport-policy') parsed.peerConfig = mergePeerConfig(parsed.peerConfig, { iceTransportPolicy: parseIceTransportPolicy(next(), arg) });
    else if (arg.startsWith('--ice-transport-policy=')) parsed.peerConfig = mergePeerConfig(parsed.peerConfig, { iceTransportPolicy: parseIceTransportPolicy(arg.slice('--ice-transport-policy='.length), '--ice-transport-policy') });
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return normalizeOptions(parsed);
}

export async function runWeriftP2PSmoke(
  options: WeriftP2PSmokeOptions,
  deps: WeriftP2PSmokeDeps = {},
): Promise<WeriftP2PSmokeResult> {
  const normalized = normalizeOptions(options);
  const createClient = deps.createClient ?? createWeriftSignaledP2PDataPlaneClientFromApi;
  const createAuthenticatedFetch = deps.createAuthenticatedFetch ?? createSolidClientCredentialsP2PFetch;
  const client = await createClient({
    apiBaseUrl: normalized.apiBaseUrl,
    nodeId: normalized.nodeId,
    token: normalized.token,
    sourceId: normalized.sourceId,
    capabilities: ['webrtc-datachannel'],
    timeoutMs: normalized.timeoutMs,
    pollIntervalMs: normalized.pollIntervalMs,
    transportTimeoutMs: normalized.transportTimeoutMs,
    peerConfig: normalized.peerConfig,
  });

  let authenticated: WeriftP2PSmokeAuthenticatedFetch | undefined;

  try {
    const resourceFetch = normalized.solidAuth
      ? (authenticated = await createAuthenticatedFetch({
          ...normalized.solidAuth,
          fetchImpl: client.fetch,
        })).fetch
      : client.fetch;
    const response = await resourceFetch(normalized.url, {
      method: normalized.method,
      headers: normalized.headers,
      body: normalized.body,
    });
    const bodyText = await response.text();
    const result: WeriftP2PSmokeResult = {
      sessionId: client.session.sessionId,
      routeKind: client.route.kind,
      routeTargetUrl: client.route.targetUrl,
      status: response.status,
      statusText: response.statusText,
      headers: headersToList(response.headers),
      bodyText,
      authWebId: authenticated?.webId,
    };
    if (normalized.expectStatus !== undefined && response.status !== normalized.expectStatus) {
      throw new Error(`Expected P2P HTTP status ${normalized.expectStatus}, got ${response.status}`);
    }
    return result;
  } finally {
    await authenticated?.close?.();
    await client.close();
  }
}

export async function createSolidClientCredentialsP2PFetch(
  options: WeriftP2PSmokeSolidAuthOptions & { fetchImpl: typeof fetch },
): Promise<WeriftP2PSmokeAuthenticatedFetch> {
  const session = new Session({ keepAlive: false });
  let tokenSet: SessionTokenSet | undefined;
  session.events.on(EVENTS.NEW_TOKENS, (nextTokenSet) => {
    tokenSet = nextTokenSet;
  });
  await session.login({
    oidcIssuer: options.oidcIssuer,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    tokenType: options.tokenType ?? 'DPoP',
  });
  if (!tokenSet?.accessToken) {
    await session.logout({ logoutType: 'app' });
    throw new Error('Solid client credentials login did not return an access token');
  }

  return {
    fetch: buildAuthenticatedFetch(tokenSet.accessToken, {
      dpopKey: tokenSet.dpopKey,
      fetch: options.fetchImpl,
    }),
    webId: tokenSet.webId ?? session.info.webId,
    close: async () => {
      await session.logout({ logoutType: 'app' });
    },
  };
}

export function formatWeriftP2PSmokeResult(result: WeriftP2PSmokeResult): string {
  return [
    'Xpod werift P2P smoke result',
    `  sessionId: ${result.sessionId}`,
    `  route:     ${result.routeKind} ${result.routeTargetUrl}`,
    `  status:    ${result.status} ${result.statusText}`.trimEnd(),
    `  headers:   ${result.headers.length}`,
    '',
    result.bodyText,
  ].join('\n');
}

export function weriftP2PSmokeUsage(): string {
  return `Usage: bun scripts/werift-p2p-smoke.ts --api-base-url <url> --node-id <id> --source-id <id> --url <solid-url> [options]

Runs a non-browser werift DataChannel P2P smoke request. The request remains a
canonical Solid HTTP request; P2P only carries xpod-p2p-http/1 frames.

Required flags or env:
  --api-base-url <url>        Cloud/API base URL, or XPOD_P2P_API_BASE_URL
  --node-id <id>              Edge node id, or XPOD_P2P_NODE_ID
  --source-id <id>            Managed client/device id, or XPOD_P2P_SOURCE_ID
  --url <solid-url>           Canonical Solid resource URL, or XPOD_P2P_URL

Options:
  --token <token>             API bearer token, or XPOD_P2P_TOKEN
  --method, -X <method>       HTTP method. Default: GET
  --header, -H <k: v>         HTTP header forwarded inside the P2P frame
  --solid-oidc-issuer <url>   Optional Solid issuer for automatic DPoP auth
  --solid-client-id <id>      Optional Solid client credentials id
  --solid-client-secret <sec> Optional Solid client credentials secret
  --solid-token-type <type>   Optional Solid token type. Default: DPoP
  --body, -d <text>           HTTP request body
  --expect-status <code>      Fail if response status differs
  --timeout-ms <ms>           Signaling/ICE timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --poll-interval-ms <ms>     Signaling polling interval. Default: ${DEFAULT_POLL_INTERVAL_MS}
  --transport-timeout-ms <ms> P2P HTTP frame timeout. Default: ${DEFAULT_TRANSPORT_TIMEOUT_MS}
  --ice-servers <json>        PeerConfig iceServers JSON array, also XPOD_P2P_ICE_SERVERS
  --ice-transport-policy <p>   ICE policy all|relay, also XPOD_P2P_ICE_TRANSPORT_POLICY
  --help, -h                  Show this help

Example:
  XPOD_P2P_TOKEN=... bun scripts/werift-p2p-smoke.ts \\
    --api-base-url https://id.undefineds.co/ \\
    --node-id node-0000 \\
    --source-id desktop-ganlu \\
    --url https://node-0000.undefineds.co/.well-known/openid-configuration \\
    --expect-status 200
`;
}

export class WeriftP2PSmokeUsageError extends Error {
  public constructor() {
    super('Usage requested');
  }
}

function normalizeOptions(options: Partial<WeriftP2PSmokeOptions>): WeriftP2PSmokeOptions {
  const apiBaseUrl = requireHttpOrigin(options.apiBaseUrl, 'apiBaseUrl');
  const url = requireHttpUrl(options.url, 'url');
  const nodeId = requireNonEmpty(options.nodeId, 'nodeId');
  const sourceId = requireNonEmpty(options.sourceId, 'sourceId');
  const method = (options.method ?? 'GET').trim().toUpperCase();
  if (!method) throw new Error('method is required');

  return {
    apiBaseUrl,
    nodeId,
    token: trimOptional(options.token),
    sourceId,
    url,
    method,
    headers: options.headers ?? [],
    body: options.body,
    expectStatus: options.expectStatus,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    transportTimeoutMs: options.transportTimeoutMs ?? DEFAULT_TRANSPORT_TIMEOUT_MS,
    peerConfig: options.peerConfig,
    solidAuth: normalizeSolidAuth(options.solidAuth),
  };
}

function parseSolidAuthFromEnv(env: Record<string, string | undefined>): WeriftP2PSmokeSolidAuthOptions | undefined {
  const oidcIssuer = trimOptional(env.XPOD_P2P_SOLID_OIDC_ISSUER);
  const clientId = trimOptional(env.XPOD_P2P_SOLID_CLIENT_ID);
  const clientSecret = trimOptional(env.XPOD_P2P_SOLID_CLIENT_SECRET);
  const tokenType = trimOptional(env.XPOD_P2P_SOLID_TOKEN_TYPE);
  if (!oidcIssuer && !clientId && !clientSecret && !tokenType) {
    return undefined;
  }
  return normalizeSolidAuth({
    oidcIssuer,
    clientId,
    clientSecret,
    tokenType: tokenType ? parseTokenType(tokenType, 'XPOD_P2P_SOLID_TOKEN_TYPE') : undefined,
  });
}

function normalizeSolidAuth(options?: Partial<WeriftP2PSmokeSolidAuthOptions>): WeriftP2PSmokeSolidAuthOptions | undefined {
  if (!options) {
    return undefined;
  }
  return {
    oidcIssuer: requireHttpOrigin(options.oidcIssuer, 'solidAuth.oidcIssuer'),
    clientId: requireNonEmpty(options.clientId, 'solidAuth.clientId'),
    clientSecret: requireNonEmpty(options.clientSecret, 'solidAuth.clientSecret'),
    tokenType: options.tokenType ?? 'DPoP',
  };
}

function parseTokenType(value: string, optionName: string): ILoginInputOptions['tokenType'] {
  if (value !== 'DPoP' && value !== 'Bearer') {
    throw new Error(`${optionName} must be DPoP or Bearer`);
  }
  return value;
}

function requireNonEmpty(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required`);
  return trimmed;
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function requireHttpOrigin(value: string | undefined, name: string): string {
  const parsed = new URL(requireNonEmpty(value, name));
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${name} must use http or https`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`${name} must be an origin/base URL without search or hash`);
  }
  return parsed.toString();
}

function requireHttpUrl(value: string | undefined, name: string): string {
  const parsed = new URL(requireNonEmpty(value, name));
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${name} must use http or https`);
  }
  return parsed.toString();
}

function parseHeader(value: string, optionName: string): [string, string] {
  const separator = value.indexOf(':');
  if (separator <= 0) throw new Error(`${optionName} must be formatted as "name: value"`);
  const name = value.slice(0, separator).trim().toLowerCase();
  const headerValue = value.slice(separator + 1).trim();
  if (!name) throw new Error(`${optionName} header name is required`);
  return [name, headerValue];
}

function parseStatus(value: string, optionName: string): number {
  const parsed = parsePositiveInteger(value, optionName);
  if (parsed < 100 || parsed > 599) throw new Error(`${optionName} must be an HTTP status code`);
  return parsed;
}

function parsePositiveInteger(value: string, optionName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${optionName} must be a positive integer`);
  return parsed;
}

function parseIceServers(value: string, optionName: string): PeerConfig['iceServers'] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`${optionName} must be a JSON array`);
  return parsed as PeerConfig['iceServers'];
}

function parseIceTransportPolicy(value: string, optionName: string): PeerConfig['iceTransportPolicy'] {
  if (value !== 'all' && value !== 'relay') {
    throw new Error(`${optionName} must be all or relay`);
  }
  return value;
}

function mergePeerConfig(
  current: Partial<PeerConfig> | undefined,
  next: Partial<PeerConfig>,
): Partial<PeerConfig> {
  return {
    ...current,
    ...next,
  };
}

function headersToList(headers: Headers): [string, string][] {
  const result: [string, string][] = [];
  headers.forEach((value, key) => result.push([key, value]));
  return result;
}
