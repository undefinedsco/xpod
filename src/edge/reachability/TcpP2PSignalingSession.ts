import { createConnection, type Socket } from 'node:net';
import type { AccessRoute, P2PCandidateRole, P2PSession, P2PTransportCandidate } from './types';
import type { CreateP2PSessionInput, P2PSignalingClient } from './P2PSignalingClient';
import {
  computeTcpHolePunchPlan,
  createTcpP2PDataPlaneTransport,
  type TcpP2PDataPlaneTransport,
  type TcpHolePunchPlan,
  type TcpHolePunchPlanOptions,
} from './TcpP2PDataPlaneTransport';

export const RAW_TCP_HOLE_PUNCH_TRANSPORT = 'raw-tcp-hole-punch' as const;
export const RAW_TCP_HOLE_PUNCH_CAPABILITY = 'tcp-punch' as const;

export interface CreateRawTcpHolePunchCandidatesOptions {
  role: P2PCandidateRole;
  sourceId: string;
  host?: string;
  address?: string;
  createdAt?: Date;
  priority?: number;
  plan?: TcpHolePunchPlan;
  planOptions?: TcpHolePunchPlanOptions;
  candidateIdPrefix?: string;
}

export interface SignaledRawTcpP2PSessionOptions {
  signaling: P2PSignalingClient;
  clientId: string;
  host?: string;
  address?: string;
  capabilities?: string[];
  priority?: number;
  createdAt?: Date;
  plan?: TcpHolePunchPlan;
  planOptions?: TcpHolePunchPlanOptions;
  candidateIdPrefix?: string;
}

export interface SignaledRawTcpP2PSession {
  session: P2PSession;
  plan: TcpHolePunchPlan;
  localCandidates: P2PTransportCandidate[];
  rawTcpRoute?: AccessRoute;
}

export interface AnswerPendingRawTcpP2PSessionsOnceOptions {
  signaling: P2PSignalingClient;
  sourceId: string;
  host?: string;
  address?: string;
  priority?: number;
  createdAt?: Date;
  candidateIdPrefix?: string;
}

export interface WaitForRawTcpRemoteCandidatesOptions {
  signaling: P2PSignalingClient;
  sessionIdOrUrl: string;
  localRole: P2PCandidateRole;
  localSourceId: string;
  bucket?: number;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface ConnectRawTcpP2PTransportOptions {
  localCandidates: P2PTransportCandidate[];
  remoteCandidates: P2PTransportCandidate[];
  connectTimeoutMs?: number;
  timeoutMs?: number;
  localAddress?: string;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

export function createRawTcpHolePunchCandidates(
  options: CreateRawTcpHolePunchCandidatesOptions,
): P2PTransportCandidate[] {
  const plan = options.plan ?? computeTcpHolePunchPlan(options.planOptions);
  const createdAt = (options.createdAt ?? new Date()).toISOString();
  const hostOrAddress = options.host ?? options.address;
  const prefix = options.candidateIdPrefix ?? `${options.sourceId}_${plan.bucket}`;

  return plan.ports.map((port, index) => ({
    id: `${prefix}_${port}_${index}`,
    role: options.role,
    sourceId: options.sourceId,
    createdAt,
    protocol: 'tcp',
    transport: RAW_TCP_HOLE_PUNCH_TRANSPORT,
    ...(options.host ? { host: options.host } : {}),
    ...(options.address ? { address: options.address } : {}),
    ...(hostOrAddress ? { url: `tcp-punch://${hostOrAddress}:${port}` } : {}),
    port,
    priority: options.priority ?? (100 - index),
    metadata: {
      provider: RAW_TCP_HOLE_PUNCH_TRANSPORT,
      bucket: plan.bucket,
      boundary: plan.boundary,
      rendezvousTimeSeconds: plan.rendezvousTimeSeconds,
    },
  }));
}

export async function createSignaledRawTcpP2PSession(
  options: SignaledRawTcpP2PSessionOptions,
): Promise<SignaledRawTcpP2PSession> {
  const plan = options.plan ?? computeTcpHolePunchPlan(options.planOptions);
  const localCandidates = createRawTcpHolePunchCandidates({
    role: 'client',
    sourceId: options.clientId,
    host: options.host,
    address: options.address,
    createdAt: options.createdAt,
    priority: options.priority,
    plan,
    candidateIdPrefix: options.candidateIdPrefix,
  });
  const request: CreateP2PSessionInput = {
    clientId: options.clientId,
    capabilities: uniqueStrings([
      RAW_TCP_HOLE_PUNCH_CAPABILITY,
      ...(options.capabilities ?? []),
    ]),
    candidates: localCandidates,
  };
  const session = await options.signaling.createP2PSession(request);
  return {
    session,
    plan,
    localCandidates,
    rawTcpRoute: selectRawTcpP2PRoute(session.nodeCandidates),
  };
}

export async function answerPendingRawTcpP2PSessionsOnce(
  options: AnswerPendingRawTcpP2PSessionsOnceOptions,
): Promise<P2PSession[]> {
  const sessions = await options.signaling.listP2PSessions();
  const answered: P2PSession[] = [];
  for (const session of sessions) {
    if (!selectRawTcpP2PRoute(session.nodeCandidates)) {
      continue;
    }
    const plan = planFromRemoteCandidates(session.candidates, 'client');
    if (!plan) {
      continue;
    }
    if (hasRawTcpCandidate(session.candidates, 'node', options.sourceId, plan.bucket)) {
      continue;
    }
    const candidates = createRawTcpHolePunchCandidates({
      role: 'node',
      sourceId: options.sourceId,
      host: options.host,
      address: options.address,
      createdAt: options.createdAt,
      priority: options.priority,
      plan,
      candidateIdPrefix: options.candidateIdPrefix,
    });
    answered.push(await options.signaling.addP2PCandidates(session.signalingUrl || session.sessionId, {
      role: 'node',
      sourceId: options.sourceId,
      candidates,
    }));
  }
  return answered;
}

export async function waitForRawTcpRemoteCandidates(
  options: WaitForRawTcpRemoteCandidatesOptions,
): Promise<P2PTransportCandidate[]> {
  const startedAt = Date.now();
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS);
  const pollIntervalMs = positiveInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  for (;;) {
    const session = await options.signaling.getP2PSession(options.sessionIdOrUrl);
    const candidates = filterRawTcpRemoteCandidates(
      session.candidates,
      options.localRole,
      options.localSourceId,
      options.bucket,
    );
    if (candidates.length > 0) {
      return candidates;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for raw TCP P2P candidates after ${timeoutMs}ms`);
    }
    await sleep(Math.min(pollIntervalMs, Math.max(1, timeoutMs - (Date.now() - startedAt))));
  }
}

export async function connectRawTcpP2PTransport(
  options: ConnectRawTcpP2PTransportOptions,
): Promise<TcpP2PDataPlaneTransport> {
  const pairs = candidatePairs(options.localCandidates, options.remoteCandidates);
  if (pairs.length === 0) {
    throw new Error('No compatible raw TCP P2P candidate pairs');
  }

  const errors: string[] = [];
  for (const { local, remote } of pairs) {
    try {
      const socket = await connectCandidatePair(local, remote, {
        timeoutMs: positiveInteger(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS),
        localAddress: options.localAddress,
      });
      return createTcpP2PDataPlaneTransport({
        remoteHost: candidateHost(remote),
        remotePort: remote.port!,
        socket,
        timeoutMs: options.timeoutMs,
      });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`Failed to connect raw TCP P2P candidates: ${errors.join('; ')}`);
}

export function filterRawTcpRemoteCandidates(
  candidates: P2PTransportCandidate[],
  localRole: P2PCandidateRole,
  localSourceId: string,
  bucket?: number,
): P2PTransportCandidate[] {
  return candidates.filter((candidate) => {
    if (!isRawTcpHolePunchCandidate(candidate)) {
      return false;
    }
    if (candidate.role === localRole && candidate.sourceId === localSourceId) {
      return false;
    }
    if (bucket !== undefined && getNumericMetadata(candidate, 'bucket') !== bucket) {
      return false;
    }
    return true;
  });
}

export function selectRawTcpP2PRoute(routes: AccessRoute[]): AccessRoute | undefined {
  return routes.find((route) => {
    if (route.kind !== 'p2p') {
      return false;
    }
    if (route.targetUrl.startsWith('tcp-punch://')) {
      return true;
    }
    const protocols = isRecord(route.metadata?.protocols) ? route.metadata.protocols : undefined;
    const rawTcp = isRecord(protocols?.[RAW_TCP_HOLE_PUNCH_TRANSPORT])
      ? protocols[RAW_TCP_HOLE_PUNCH_TRANSPORT]
      : undefined;
    return rawTcp?.enabled === true;
  });
}

export function isRawTcpHolePunchCandidate(candidate: P2PTransportCandidate): boolean {
  return candidate.protocol === 'tcp'
    && candidate.transport === RAW_TCP_HOLE_PUNCH_TRANSPORT
    && getNumericMetadata(candidate, 'bucket') !== undefined
    && getNumericMetadata(candidate, 'rendezvousTimeSeconds') !== undefined
    && typeof candidate.port === 'number';
}

function candidatePairs(
  localCandidates: P2PTransportCandidate[],
  remoteCandidates: P2PTransportCandidate[],
): { local: P2PTransportCandidate; remote: P2PTransportCandidate }[] {
  const local = localCandidates.filter(isRawTcpHolePunchCandidate).sort(compareCandidatePriority);
  const remote = remoteCandidates
    .filter(isRawTcpHolePunchCandidate)
    .filter((candidate) => candidateHost(candidate).length > 0)
    .sort(compareCandidatePriority);
  const result: { local: P2PTransportCandidate; remote: P2PTransportCandidate }[] = [];
  for (const localCandidate of local) {
    const localBucket = getNumericMetadata(localCandidate, 'bucket');
    for (const remoteCandidate of remote) {
      if (localBucket === getNumericMetadata(remoteCandidate, 'bucket')) {
        result.push({ local: localCandidate, remote: remoteCandidate });
      }
    }
  }
  return result;
}

async function connectCandidatePair(
  local: P2PTransportCandidate,
  remote: P2PTransportCandidate,
  options: { timeoutMs: number; localAddress?: string },
): Promise<Socket> {
  const remoteHost = candidateHost(remote);
  const remotePort = remote.port;
  if (!remoteHost || !remotePort) {
    throw new Error(`Remote raw TCP candidate ${remote.id} is missing host or port`);
  }
  return new Promise((resolve, reject) => {
    const connectOptions = {
      host: remoteHost,
      port: remotePort,
      localAddress: options.localAddress,
      ...(local.port ? { localPort: local.port } : {}),
    };
    const socket = createConnection(connectOptions);
    const timeout = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error(`Raw TCP candidate connect timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timeout);
      socket.off('connect', onConnect);
      socket.off('error', onError);
    };
    const onConnect = (): void => {
      cleanup();
      resolve(socket);
    };
    const onError = (error: Error): void => {
      cleanup();
      socket.destroy();
      reject(error);
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

function candidateHost(candidate: P2PTransportCandidate): string {
  return candidate.host ?? candidate.address ?? hostFromCandidateUrl(candidate.url) ?? '';
}

function hostFromCandidateUrl(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

function compareCandidatePriority(left: P2PTransportCandidate, right: P2PTransportCandidate): number {
  return (right.priority ?? 0) - (left.priority ?? 0);
}

function planFromRemoteCandidates(
  candidates: P2PTransportCandidate[],
  role: P2PCandidateRole,
): TcpHolePunchPlan | undefined {
  const rawCandidates = candidates
    .filter((candidate) => candidate.role === role)
    .filter(isRawTcpHolePunchCandidate);
  const first = rawCandidates[0];
  if (!first) {
    return undefined;
  }
  const bucket = getNumericMetadata(first, 'bucket');
  const boundary = getNumericMetadata(first, 'boundary');
  const rendezvousTimeSeconds = getNumericMetadata(first, 'rendezvousTimeSeconds');
  if (bucket === undefined || boundary === undefined || rendezvousTimeSeconds === undefined) {
    return undefined;
  }
  const ports = rawCandidates
    .filter((candidate) => getNumericMetadata(candidate, 'bucket') === bucket)
    .map((candidate) => candidate.port)
    .filter((port): port is number => typeof port === 'number' && Number.isInteger(port) && port > 0);
  if (ports.length === 0) {
    return undefined;
  }
  return {
    bucket,
    boundary,
    rendezvousTimeSeconds,
    ports: [...new Set(ports)].sort((a, b) => b - a),
  };
}

function hasRawTcpCandidate(
  candidates: P2PTransportCandidate[],
  role: P2PCandidateRole,
  sourceId: string,
  bucket: number,
): boolean {
  return candidates.some((candidate) => candidate.role === role
    && candidate.sourceId === sourceId
    && isRawTcpHolePunchCandidate(candidate)
    && getNumericMetadata(candidate, 'bucket') === bucket);
}

function getNumericMetadata(candidate: P2PTransportCandidate, key: string): number | undefined {
  const value = candidate.metadata?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
