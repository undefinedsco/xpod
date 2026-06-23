#!/usr/bin/env bun

import {
  createP2PDataPlaneHandler,
  createP2PSignalingClient,
  createRawTcpHolePunchCandidates,
  createTcpP2PDataPlaneServer,
  type P2PSession,
  type P2PTransportCandidate,
} from '../src/edge/reachability';

interface CliOptions {
  apiBaseUrl: string;
  signalEndpoint: string;
  nodeId: string;
  nodeToken: string;
  baseUrl: string;
  targetBaseUrl: string;
  runTimeoutMs: number;
  pollIntervalMs: number;
  requireSession: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const apiBaseUrl = process.env.XPOD_DOCKER_P2P_API_BASE_URL ?? 'http://signal:8080/';
  const options: CliOptions = {
    apiBaseUrl,
    signalEndpoint: process.env.XPOD_DOCKER_P2P_SIGNAL_ENDPOINT ?? new URL('/v1/signal', apiBaseUrl).toString(),
    nodeId: process.env.XPOD_DOCKER_P2P_NODE_ID ?? '',
    nodeToken: process.env.XPOD_DOCKER_P2P_NODE_TOKEN ?? '',
    baseUrl: process.env.XPOD_DOCKER_P2P_BASE_URL ?? '',
    targetBaseUrl: process.env.XPOD_DOCKER_P2P_TARGET_BASE_URL ?? 'http://signal:8081/',
    runTimeoutMs: parseOptionalInteger(process.env.XPOD_DOCKER_P2P_NODE_RUN_TIMEOUT_MS, 'XPOD_DOCKER_P2P_NODE_RUN_TIMEOUT_MS') ?? 15_000,
    pollIntervalMs: parseOptionalInteger(process.env.XPOD_DOCKER_P2P_POLL_INTERVAL_MS, 'XPOD_DOCKER_P2P_POLL_INTERVAL_MS') ?? 25,
    requireSession: process.env.XPOD_DOCKER_P2P_ALLOW_NO_SESSION !== 'true',
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
      case '--api-base-url':
        options.apiBaseUrl = readValue();
        options.signalEndpoint = new URL('/v1/signal', options.apiBaseUrl).toString();
        break;
      case '--signal-endpoint':
        options.signalEndpoint = readValue();
        break;
      case '--node-id':
        options.nodeId = readValue();
        break;
      case '--node-token':
        options.nodeToken = readValue();
        break;
      case '--base-url':
        options.baseUrl = readValue();
        break;
      case '--target-base-url':
        options.targetBaseUrl = readValue();
        break;
      case '--run-timeout-ms':
        options.runTimeoutMs = parsePositiveInteger(readValue(), key);
        break;
      case '--poll-interval-ms':
        options.pollIntervalMs = parsePositiveInteger(readValue(), key);
        break;
      case '--allow-no-session':
        options.requireSession = false;
        break;
      case '--require-session':
        options.requireSession = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function usage(): void {
  console.log(`Usage: bun scripts/docker-p2p-node-listener-smoke.ts --api-base-url <url> --node-id <id> --node-token <token> --base-url <url> --target-base-url <url>

Docker-only node runner for deterministic bridge integration. It publishes the
managed p2p route, starts a raw TCP data-plane listener in the node container,
and answers client sessions with port-only node candidates so the signal API
must enrich the node address from the Docker bridge source address.

This is not a cross-NAT simultaneous-open proof; it validates the non-browser
raw TCP data plane across Docker bridge peers.`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  requireAbsoluteUrl(options.apiBaseUrl, '--api-base-url');
  requireAbsoluteUrl(options.signalEndpoint, '--signal-endpoint');
  requireAbsoluteUrl(options.baseUrl, '--base-url');
  requireAbsoluteUrl(options.targetBaseUrl, '--target-base-url');
  requireNonEmpty(options.nodeId, '--node-id');
  requireNonEmpty(options.nodeToken, '--node-token');

  const dataPlaneServer = createTcpP2PDataPlaneServer({
    host: '0.0.0.0',
    handler: createP2PDataPlaneHandler({ targetBaseUrl: options.targetBaseUrl }),
  });
  await dataPlaneServer.listen(0);
  const listenPort = dataPlaneServer.address().port;
  const answered: Array<Record<string, unknown>> = [];
  let lastError = '';
  let heartbeatOk = false;

  try {
    await sendHeartbeat(options);
    heartbeatOk = true;
    const signaling = createP2PSignalingClient({
      apiBaseUrl: options.apiBaseUrl,
      nodeId: options.nodeId,
      token: options.nodeToken,
    });
    const startedAt = Date.now();
    while (Date.now() - startedAt < options.runTimeoutMs) {
      try {
        const sessions = await signaling.listP2PSessions();
        for (const session of sessions) {
          if (answered.some((entry) => entry.sessionId === session.sessionId)) continue;
          const plan = planFromClientCandidates(session.candidates);
          if (!plan) continue;
          const nodeCandidates = createRawTcpHolePunchCandidates({
            role: 'node',
            sourceId: options.nodeId,
            plan: { ...plan, ports: [listenPort] },
          });
          const updated = await signaling.addP2PCandidates(session.signalingUrl || session.sessionId, {
            role: 'node',
            sourceId: options.nodeId,
            candidates: nodeCandidates,
          });
          answered.push({
            sessionId: updated.sessionId,
            nodeId: updated.nodeId,
            clientId: updated.clientId,
            nodeAddress: addressEvidence(updated.candidates, 'node', options.nodeId),
            clientAddress: addressEvidence(updated.candidates, 'client', updated.clientId),
            localPort: listenPort,
            answeredAt: new Date().toISOString(),
          });
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (answered.length > 0) {
        await sleep(Math.min(1_000, Math.max(0, options.runTimeoutMs - (Date.now() - startedAt))));
        break;
      }
      await sleep(options.pollIntervalMs);
    }

    const smokeOk = !options.requireSession || answered.length > 0;
    writeJson({
      smokeOk,
      ...(smokeOk ? {} : { error: `No docker P2P session was answered before timeout${lastError ? `: ${lastError}` : ''}` }),
      heartbeatOk,
      requireSession: options.requireSession,
      accepted: answered,
      answered,
      listenPort,
      evidence: {
        networkBoundary: 'docker-bridge',
        dataPlane: 'docker-bridge-tcp-listener',
        nodeAddress: answered[0]?.nodeAddress,
      },
      routeFallbacksPreserved: ['Cloudflare Tunnel', 'FRP/SakuraFRP'],
      caveats: [
        'Docker bridge listener mode validates direct non-browser raw TCP data plane, not real cross-NAT simultaneous open.',
        'Node candidates are port-only; signal must inject observed Docker bridge address.',
      ],
    });
    if (!smokeOk) process.exitCode = 1;
  } finally {
    await dataPlaneServer.close();
  }
}

async function sendHeartbeat(options: CliOptions): Promise<void> {
  const response = await fetch(options.signalEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${options.nodeToken}`,
      'x-node-id': options.nodeId,
    },
    body: JSON.stringify({
      nodeId: options.nodeId,
      baseUrl: options.baseUrl,
      metadata: {
        routes: [{
          id: 'p2p-raw-tcp',
          nodeId: options.nodeId,
          canonicalUrl: options.baseUrl,
          kind: 'p2p',
          targetUrl: `tcp-punch://node/${encodeURIComponent(options.nodeId)}`,
          priority: 40,
          requiresManagedClient: true,
          visibility: 'authorized-client',
          health: 'healthy',
          metadata: { protocols: { 'raw-tcp-hole-punch': { enabled: true } } },
        }],
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`heartbeat failed with ${response.status}: ${await response.text()}`);
  }
}

function planFromClientCandidates(candidates: P2PTransportCandidate[]): { bucket: number; boundary: number; rendezvousTimeSeconds: number; ports: number[] } | undefined {
  const candidate = candidates.find((entry) => entry.role === 'client'
    && entry.transport === 'raw-tcp-hole-punch'
    && typeof entry.metadata?.bucket === 'number'
    && typeof entry.metadata?.boundary === 'number'
    && typeof entry.metadata?.rendezvousTimeSeconds === 'number');
  if (!candidate) return undefined;
  return {
    bucket: candidate.metadata!.bucket as number,
    boundary: candidate.metadata!.boundary as number,
    rendezvousTimeSeconds: candidate.metadata!.rendezvousTimeSeconds as number,
    ports: [candidate.port ?? 0].filter((port) => port > 0),
  };
}

function addressEvidence(candidates: P2PTransportCandidate[], role: 'node' | 'client', sourceId: string): string {
  const candidate = candidates.find((entry) => entry.role === role && entry.sourceId === sourceId && entry.transport === 'raw-tcp-hole-punch');
  if (!candidate) return 'missing';
  if (candidate.host) return 'explicit-host';
  if (candidate.address && candidate.url) return 'explicit-address';
  if (candidate.address) return 'signal-observed';
  if (candidate.url) return 'candidate-url';
  return 'port-only';
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function requireNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0) throw new Error(`${name} is required`);
}

function requireAbsoluteUrl(value: string, name: string): void {
  requireNonEmpty(value, name);
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('not http');
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parseOptionalInteger(value: string | undefined, name: string): number | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : parsePositiveInteger(value, name);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  writeJson({ smokeOk: false, error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
