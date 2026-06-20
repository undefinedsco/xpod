import type { P2PCandidateRole, P2PTransportCandidate } from './types';
import type { P2PSignalingClient } from './P2PSignalingClient';
import type {
  UdpP2PDataPlaneTransport,
  UdpP2PDataPlaneTransportOptions,
} from './UdpP2PTransport';
import {
  createUdpP2PDataPlaneTransport,
} from './UdpP2PTransport';
import type {
  UdpP2PRendezvousConnectOptions,
  UdpP2PRendezvousConnection,
  UdpP2PRendezvousPeer,
} from './UdpP2PRendezvous';

const DEFAULT_SIGNALING_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 100;

export interface ConnectUdpP2PThroughSignalingOptions {
  signaling: P2PSignalingClient;
  sessionId: string;
  role: P2PCandidateRole;
  sourceId: string;
  peer: UdpP2PRendezvousPeer;
  timeoutMs?: number;
  pollIntervalMs?: number;
  rendezvous?: UdpP2PRendezvousConnectOptions;
  transport?: Omit<UdpP2PDataPlaneTransportOptions, 'remoteHost' | 'remotePort' | 'socket'>;
}

export interface SignaledUdpP2PConnection extends UdpP2PRendezvousConnection {
  localCandidate: P2PTransportCandidate;
  remoteCandidates: P2PTransportCandidate[];
  transport: UdpP2PDataPlaneTransport;
  close(): void;
}

export async function connectUdpP2PThroughSignaling(
  options: ConnectUdpP2PThroughSignalingOptions,
): Promise<SignaledUdpP2PConnection> {
  await options.peer.listen();
  const localCandidate = options.peer.candidate();
  const session = await options.signaling.addP2PCandidates(options.sessionId, {
    role: options.role,
    sourceId: options.sourceId,
    candidates: [localCandidate],
  });
  const remoteCandidates = await waitForRemoteCandidates({
    signaling: options.signaling,
    sessionId: options.sessionId,
    role: options.role,
    sourceId: options.sourceId,
    initialCandidates: session.candidates,
    timeoutMs: options.timeoutMs ?? DEFAULT_SIGNALING_TIMEOUT_MS,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
  });
  const rendezvous = await options.peer.connect(remoteCandidates, options.rendezvous);
  const transport = createUdpP2PDataPlaneTransport({
    ...options.transport,
    socket: options.peer.socket(),
    remoteHost: rendezvous.remoteHost,
    remotePort: rendezvous.remotePort,
  });

  return {
    ...rendezvous,
    localCandidate,
    remoteCandidates,
    transport,
    close: () => {
      transport.close();
    },
  };
}

async function waitForRemoteCandidates(options: {
  signaling: P2PSignalingClient;
  sessionId: string;
  role: P2PCandidateRole;
  sourceId: string;
  initialCandidates: P2PTransportCandidate[];
  timeoutMs: number;
  pollIntervalMs: number;
}): Promise<P2PTransportCandidate[]> {
  const deadline = Date.now() + options.timeoutMs;
  let candidates = filterRemoteCandidates(options.initialCandidates, options.role, options.sourceId);
  while (candidates.length === 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`Timed out waiting for remote P2P candidates in session ${options.sessionId}`);
    }
    await sleep(Math.min(options.pollIntervalMs, remaining));
    const session = await options.signaling.getP2PSession(options.sessionId);
    candidates = filterRemoteCandidates(session.candidates, options.role, options.sourceId);
  }
  return candidates;
}

function filterRemoteCandidates(
  candidates: P2PTransportCandidate[],
  role: P2PCandidateRole,
  sourceId: string,
): P2PTransportCandidate[] {
  return candidates.filter((candidate) => candidate.role !== role && candidate.sourceId !== sourceId);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
