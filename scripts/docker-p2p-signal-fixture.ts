#!/usr/bin/env bun

import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { ApiServer } from '../src/api/ApiServer';
import { MultiAuthenticator } from '../src/api/auth/MultiAuthenticator';
import { NodeTokenAuthenticator } from '../src/api/auth/NodeTokenAuthenticator';
import { ServiceTokenAuthenticator } from '../src/api/auth/ServiceTokenAuthenticator';
import { registerEdgeNodeSignalRoutes } from '../src/api/handlers/EdgeNodeSignalHandler';
import { registerReachabilityRoutes } from '../src/api/handlers/ReachabilityHandler';
import { AuthMiddleware } from '../src/api/middleware/AuthMiddleware';
import { EdgeNodeRepository } from '../src/identity/drizzle/EdgeNodeRepository';
import { closeAllIdentityConnections, getIdentityDatabase } from '../src/identity/drizzle/db';
import { ServiceTokenRepository } from '../src/identity/drizzle/ServiceTokenRepository';

interface CliOptions {
  nodeId: string;
  nodeToken: string;
  serviceToken: string;
  baseStorageDomain: string;
  resourcePath: string;
  targetBody: string;
  signalPort: number;
  targetPort: number;
  help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    nodeId: process.env.XPOD_DOCKER_P2P_NODE_ID ?? 'docker-node',
    nodeToken: process.env.XPOD_DOCKER_P2P_NODE_TOKEN ?? 'docker-node-token',
    serviceToken: process.env.XPOD_DOCKER_P2P_SERVICE_TOKEN ?? 'svc-dockerp2p',
    baseStorageDomain: process.env.XPOD_DOCKER_P2P_BASE_STORAGE_DOMAIN ?? 'pods.example',
    resourcePath: process.env.XPOD_DOCKER_P2P_RESOURCE_PATH ?? '/alice/docker-p2p-e2e.txt?version=1',
    targetBody: process.env.XPOD_DOCKER_P2P_TARGET_BODY ?? 'docker p2p e2e response',
    signalPort: parseOptionalInteger(process.env.XPOD_DOCKER_P2P_SIGNAL_PORT, 'XPOD_DOCKER_P2P_SIGNAL_PORT') ?? 8080,
    targetPort: parseOptionalInteger(process.env.XPOD_DOCKER_P2P_TARGET_PORT, 'XPOD_DOCKER_P2P_TARGET_PORT') ?? 8081,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const separator = arg.indexOf('=');
    const key = separator > 0 ? arg.slice(0, separator) : arg;
    const inline = separator > 0 ? arg.slice(separator + 1) : undefined;
    const readValue = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      index += 1;
      return next;
    };

    switch (key) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--node-id':
        options.nodeId = readValue();
        break;
      case '--node-token':
        options.nodeToken = readValue();
        break;
      case '--service-token':
      case '--token':
        options.serviceToken = readValue();
        break;
      case '--base-storage-domain':
        options.baseStorageDomain = readValue();
        break;
      case '--resource-path':
        options.resourcePath = readValue();
        break;
      case '--target-body':
        options.targetBody = readValue();
        break;
      case '--signal-port':
        options.signalPort = parsePositiveInteger(readValue(), key);
        break;
      case '--target-port':
        options.targetPort = parsePositiveInteger(readValue(), key);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.resourcePath = options.resourcePath.startsWith('/') ? options.resourcePath : `/${options.resourcePath}`;
  return options;
}

function usage(): void {
  console.log(`Usage: bun scripts/docker-p2p-signal-fixture.ts --node-id <id> --node-token <token> --service-token <token>

Starts a repository-backed signal API and a target HTTP server inside a Docker
network. This lets the signal API observe real Docker bridge peer addresses for
port-only raw TCP P2P candidates.`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const db = getIdentityDatabase(`sqlite::memory:docker-p2p-signal-${Date.now()}-${Math.random()}`);
  const nodeRepo = new EdgeNodeRepository(db);
  const serviceTokenRepo = new ServiceTokenRepository(db);
  await nodeRepo.registerSpNode({
    nodeId: options.nodeId,
    nodeToken: options.nodeToken,
    serviceToken: options.serviceToken,
    publicUrl: `https://${options.nodeId}.${options.baseStorageDomain}/`,
    displayName: 'docker-p2p-node',
  });
  await serviceTokenRepo.registerToken(options.serviceToken, {
    serviceType: 'cloud',
    serviceId: 'docker-p2p-smoke',
    scopes: ['reachability:read', 'reachability:write'],
  });

  const target = await startTargetServer(options);
  const api = await startSignalApi({
    nodeRepo,
    serviceTokenRepo,
    baseStorageDomain: options.baseStorageDomain,
    signalPort: options.signalPort,
    targetRequests: target.requests,
  });

  const shutdown = async (): Promise<void> => {
    await api.close();
    await target.close();
    await closeAllIdentityConnections();
    process.exit(0);
  };
  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });

  process.stdout.write(JSON.stringify({
    ready: true,
    signalUrl: `http://0.0.0.0:${options.signalPort}/`,
    targetUrl: `http://0.0.0.0:${options.targetPort}/`,
    nodeId: options.nodeId,
  }) + '\n');
}

async function startSignalApi(options: {
  nodeRepo: EdgeNodeRepository;
  serviceTokenRepo: ServiceTokenRepository;
  baseStorageDomain: string;
  signalPort: number;
  targetRequests: Array<{ method: string; url: string; headers: Record<string, string | string[] | undefined> }>;
}): Promise<{ close(): Promise<void> }> {
  const authenticator = new MultiAuthenticator({
    authenticators: [
      new ServiceTokenAuthenticator({ repository: options.serviceTokenRepo }),
      new NodeTokenAuthenticator({ repository: options.nodeRepo }),
    ],
  });
  const server = new ApiServer({
    port: options.signalPort,
    host: '0.0.0.0',
    authMiddleware: new AuthMiddleware({ authenticator }),
  });
  const apiBaseUrl = `http://signal:${options.signalPort}/`;
  server.get('/__fixture/health', async (_request, response) => {
    sendJson(response, 200, { status: 'ok' });
  }, { public: true });
  server.get('/__fixture/requests', async (_request, response) => {
    sendJson(response, 200, { requests: options.targetRequests });
  }, { public: true });
  registerEdgeNodeSignalRoutes(server, { repository: options.nodeRepo });
  registerReachabilityRoutes(server, {
    repository: options.nodeRepo,
    baseStorageDomain: options.baseStorageDomain,
    apiBaseUrl,
  });
  await server.start();
  return { close: () => server.stop() };
}

async function startTargetServer(options: CliOptions): Promise<{
  requests: Array<{ method: string; url: string; headers: Record<string, string | string[] | undefined> }>;
  close(): Promise<void>;
}> {
  const requests: Array<{ method: string; url: string; headers: Record<string, string | string[] | undefined> }> = [];
  const server = createHttpServer((request, response) => {
    requests.push({
      method: request.method ?? 'GET',
      url: request.url ?? '/',
      headers: request.headers,
    });
    if (request.url === options.resourcePath) {
      response.statusCode = 200;
      response.setHeader('content-type', 'text/plain');
      response.end(options.targetBody);
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.targetPort, '0.0.0.0', resolve);
  });
  return {
    requests,
    close: () => closeHttpServer(server),
  };
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(value));
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parseOptionalInteger(value: string | undefined, name: string): number | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : parsePositiveInteger(value, name);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
