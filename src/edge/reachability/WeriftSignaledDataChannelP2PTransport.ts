import {
  RTCPeerConnection,
  type PeerConfig,
  type RTCDataChannel,
  type RTCIceCandidate,
  type RTCIceCandidateInit,
} from 'werift';
import type { P2PCandidateRole, P2PSession, P2PTransportCandidate } from './types';
import type { P2PSignalingClient } from './P2PSignalingClient';

const WERIFT_PROVIDER = 'werift-datachannel' as const;
const DEFAULT_LABEL = 'xpod-p2p-http';
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 100;

export interface ConnectWeriftDataChannelThroughSignalingOptions {
  signaling: P2PSignalingClient;
  sessionId: string;
  role: P2PCandidateRole;
  sourceId: string;
  label?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  peerConfig?: Partial<PeerConfig>;
  randomId?: () => string;
  now?: () => Date;
}

export interface CreateWeriftDataChannelSessionThroughSignalingOptions {
  signaling: P2PSignalingClient;
  sourceId: string;
  label?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  peerConfig?: Partial<PeerConfig>;
  capabilities?: string[];
  randomId?: () => string;
  now?: () => Date;
}

export interface SignaledWeriftDataChannelConnection {
  peer: RTCPeerConnection;
  channel: RTCDataChannel;
  localSignal: P2PTransportCandidate;
  remoteSignal: P2PTransportCandidate;
  close(): Promise<void>;
}

export interface CreatedWeriftDataChannelSessionConnection extends SignaledWeriftDataChannelConnection {
  session: Awaited<ReturnType<P2PSignalingClient['createP2PSession']>>;
}

type WeriftSignalType = 'offer' | 'answer';
type WeriftIceSignalType = 'ice-candidate' | 'ice-complete';
type WeriftIceServer = PeerConfig['iceServers'][number];

export async function connectWeriftDataChannelThroughSignaling(
  options: ConnectWeriftDataChannelThroughSignalingOptions,
): Promise<SignaledWeriftDataChannelConnection> {
  return options.role === 'client'
    ? connectClient(options)
    : connectNode(options);
}

export async function createWeriftDataChannelSessionThroughSignaling(
  options: CreateWeriftDataChannelSessionThroughSignalingOptions,
): Promise<CreatedWeriftDataChannelSessionConnection> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const label = options.label ?? DEFAULT_LABEL;
  const peer = new RTCPeerConnection(resolveWeriftPeerConfig(options.peerConfig));
  const channel = peer.createDataChannel(label, { ordered: true });
  let stopTrickleIceSync: (() => void) | undefined;

  try {
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const provisionalOptions: ConnectWeriftDataChannelThroughSignalingOptions = {
      ...options,
      sessionId: 'pending',
      role: 'client',
    };
    const localSignal = buildSignalCandidate(provisionalOptions, 'offer', peer.localDescription!.sdp, label);
    const session = await options.signaling.createP2PSession({
      clientId: options.sourceId,
      capabilities: options.capabilities ?? ['webrtc-datachannel'],
      candidates: [localSignal],
    });
    localSignal.url = `webrtc://${session.sessionId}/offer`;
    localSignal.metadata = {
      ...localSignal.metadata,
      sessionId: session.sessionId,
    };
    const remoteSignal = await waitForSignal({
      ...options,
      sessionId: session.sessionId,
      role: 'client',
      signalType: 'answer',
      initialCandidates: session.candidates,
    });
    await peer.setRemoteDescription({
      type: 'answer',
      sdp: readSignalSdp(remoteSignal),
    });
    stopTrickleIceSync = startTrickleIceSync(peer, {
      ...options,
      sessionId: session.sessionId,
      role: 'client',
    }).stop;
    await waitForChannelOpen(channel, timeoutMs);
    return {
      ...buildConnection(peer, channel, localSignal, remoteSignal, stopTrickleIceSync),
      session,
    };
  } catch (error) {
    stopTrickleIceSync?.();
    await peer.close();
    throw error;
  }
}

async function connectClient(
  options: ConnectWeriftDataChannelThroughSignalingOptions,
): Promise<SignaledWeriftDataChannelConnection> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const label = options.label ?? DEFAULT_LABEL;
  const initialSession = await options.signaling.getP2PSession(options.sessionId);
  const peer = new RTCPeerConnection(resolveWeriftPeerConfig(options.peerConfig, initialSession));
  const channel = peer.createDataChannel(label, { ordered: true });
  let stopTrickleIceSync: (() => void) | undefined;

  try {
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const localSignal = buildSignalCandidate(options, 'offer', peer.localDescription!.sdp, label);
    const session = await options.signaling.addP2PCandidates(options.sessionId, {
      role: options.role,
      sourceId: options.sourceId,
      candidates: [localSignal],
    });
    const remoteSignal = await waitForSignal({
      ...options,
      signalType: 'answer',
      initialCandidates: session.candidates,
    });
    await peer.setRemoteDescription({
      type: 'answer',
      sdp: readSignalSdp(remoteSignal),
    });
    stopTrickleIceSync = startTrickleIceSync(peer, options).stop;
    await waitForChannelOpen(channel, timeoutMs);
    return buildConnection(peer, channel, localSignal, remoteSignal, stopTrickleIceSync);
  } catch (error) {
    stopTrickleIceSync?.();
    await peer.close();
    throw error;
  }
}

async function connectNode(
  options: ConnectWeriftDataChannelThroughSignalingOptions,
): Promise<SignaledWeriftDataChannelConnection> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const label = options.label ?? DEFAULT_LABEL;
  const initialSession = await options.signaling.getP2PSession(options.sessionId);
  const peer = new RTCPeerConnection(resolveWeriftPeerConfig(options.peerConfig, initialSession));
  const nodeChannelPromise = waitForNodeDataChannel(peer, timeoutMs);
  let stopTrickleIceSync: (() => void) | undefined;

  try {
    const remoteSignal = await waitForSignal({
      ...options,
      signalType: 'offer',
      initialCandidates: initialSession.candidates,
    });
    await peer.setRemoteDescription({
      type: 'offer',
      sdp: readSignalSdp(remoteSignal),
    });
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    const localSignal = buildSignalCandidate(options, 'answer', peer.localDescription!.sdp, label);
    await options.signaling.addP2PCandidates(options.sessionId, {
      role: options.role,
      sourceId: options.sourceId,
      candidates: [localSignal],
    });
    stopTrickleIceSync = startTrickleIceSync(peer, options).stop;
    const channel = await nodeChannelPromise;
    await waitForChannelOpen(channel, timeoutMs);
    return buildConnection(peer, channel, localSignal, remoteSignal, stopTrickleIceSync);
  } catch (error) {
    stopTrickleIceSync?.();
    await peer.close();
    throw error;
  }
}

export function resolveWeriftPeerConfig(
  peerConfig?: Partial<PeerConfig>,
  session?: Pick<P2PSession, 'nodeCandidates'>,
): Partial<PeerConfig> {
  if (peerConfig && Object.prototype.hasOwnProperty.call(peerConfig, 'iceServers')) {
    return { ...peerConfig };
  }
  const iceServers = extractWeriftIceServers(session);
  if (iceServers.length === 0) {
    return peerConfig ? { ...peerConfig } : {};
  }
  return {
    ...peerConfig,
    iceServers,
  };
}

function buildConnection(
  peer: RTCPeerConnection,
  channel: RTCDataChannel,
  localSignal: P2PTransportCandidate,
  remoteSignal: P2PTransportCandidate,
  stopTrickleIceSync?: () => void,
): SignaledWeriftDataChannelConnection {
  return {
    peer,
    channel,
    localSignal,
    remoteSignal,
    close: async () => {
      stopTrickleIceSync?.();
      channel.close();
      await peer.close();
    },
  };
}

function extractWeriftIceServers(session?: Pick<P2PSession, 'nodeCandidates'>): WeriftIceServer[] {
  if (!session) {
    return [];
  }
  const iceServers: WeriftIceServer[] = [];
  const seen = new Set<string>();
  for (const route of session.nodeCandidates) {
    const metadata = route.metadata;
    for (const value of [
      metadata?.iceServers,
      readNested(metadata, ['protocols', WERIFT_PROVIDER, 'iceServers']),
      readNested(metadata, ['protocols', 'webrtc', 'iceServers']),
    ]) {
      for (const iceServer of normalizeIceServers(value)) {
        const key = `${iceServer.urls}\u0000${iceServer.username ?? ''}\u0000${iceServer.credential ?? ''}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        iceServers.push(iceServer);
      }
    }
  }
  return iceServers;
}

function normalizeIceServers(value: unknown): WeriftIceServer[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const iceServers: WeriftIceServer[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const urls = Array.isArray(item.urls) ? item.urls : [item.urls];
    for (const url of urls) {
      if (typeof url !== 'string' || url.length === 0) {
        continue;
      }
      iceServers.push({
        urls: url,
        ...(typeof item.username === 'string' ? { username: item.username } : {}),
        ...(typeof item.credential === 'string' ? { credential: item.credential } : {}),
      });
    }
  }
  return iceServers;
}

function readNested(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function buildSignalCandidate(
  options: ConnectWeriftDataChannelThroughSignalingOptions,
  signalType: WeriftSignalType,
  sdp: string,
  label: string,
): P2PTransportCandidate {
  const randomId = options.randomId ?? (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  const now = options.now ?? (() => new Date());
  const hasSessionId = options.sessionId !== 'pending';
  return {
    id: `werift_${signalType}_${options.role}_${options.sourceId}_${randomId()}`,
    role: options.role,
    sourceId: options.sourceId,
    createdAt: now().toISOString(),
    protocol: 'webrtc',
    transport: 'datachannel',
    url: hasSessionId ? `webrtc://${options.sessionId}/${signalType}` : `webrtc://${signalType}`,
    metadata: {
      provider: WERIFT_PROVIDER,
      signalType,
      sdpType: signalType,
      sdp,
      label,
      ...(hasSessionId ? { sessionId: options.sessionId } : {}),
    },
  };
}

function startTrickleIceSync(
  peer: RTCPeerConnection,
  options: ConnectWeriftDataChannelThroughSignalingOptions,
): { stop(): void } {
  let stopped = false;
  const appliedRemoteIceSignals = new Set<string>();
  const subscription = peer.onIceCandidate.subscribe((candidate) => {
    if (stopped) {
      return;
    }
    void options.signaling.addP2PCandidates(options.sessionId, {
      role: options.role,
      sourceId: options.sourceId,
      candidates: [buildIceSignalCandidate(options, candidate)],
    }).catch(() => undefined);
  });

  void pollRemoteIceSignals(peer, options, appliedRemoteIceSignals, () => stopped);

  return {
    stop: () => {
      stopped = true;
      subscription.unSubscribe();
    },
  };
}

async function pollRemoteIceSignals(
  peer: RTCPeerConnection,
  options: ConnectWeriftDataChannelThroughSignalingOptions,
  appliedRemoteIceSignals: Set<string>,
  isStopped: () => boolean,
): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  while (!isStopped()) {
    await sleep(pollIntervalMs);
    if (isStopped()) {
      return;
    }
    try {
      const session = await options.signaling.getP2PSession(options.sessionId);
      const remoteIceSignals = findRemoteIceSignals(session.candidates, options.role, options.sourceId);
      for (const signal of remoteIceSignals) {
        if (appliedRemoteIceSignals.has(signal.id)) {
          continue;
        }
        if (signal.metadata?.signalType === 'ice-candidate') {
          await peer.addIceCandidate(readIceCandidate(signal));
        }
        appliedRemoteIceSignals.add(signal.id);
      }
    } catch {
      // Signaling polling is opportunistic. The connection may already be closing or the
      // remote candidate may not be applicable yet; retry on the next poll while active.
    }
  }
}

function buildIceSignalCandidate(
  options: ConnectWeriftDataChannelThroughSignalingOptions,
  candidate: RTCIceCandidate | undefined,
): P2PTransportCandidate {
  const signalType: WeriftIceSignalType = candidate ? 'ice-candidate' : 'ice-complete';
  const randomId = options.randomId ?? (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  const now = options.now ?? (() => new Date());
  return {
    id: `werift_${signalType}_${options.role}_${options.sourceId}_${randomId()}`,
    role: options.role,
    sourceId: options.sourceId,
    createdAt: now().toISOString(),
    protocol: 'webrtc',
    transport: 'datachannel',
    url: `webrtc://${options.sessionId}/${signalType}`,
    metadata: {
      provider: WERIFT_PROVIDER,
      signalType,
      sessionId: options.sessionId,
      ...(candidate ? { candidate } : {}),
    },
  };
}

async function waitForSignal(options: ConnectWeriftDataChannelThroughSignalingOptions & {
  signalType: WeriftSignalType;
  initialCandidates: P2PTransportCandidate[];
}): Promise<P2PTransportCandidate> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  let signal = findRemoteSignal(options.initialCandidates, options.role, options.sourceId, options.signalType);
  while (!signal) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`Timed out waiting for werift ${options.signalType} in session ${options.sessionId}`);
    }
    await sleep(Math.min(pollIntervalMs, remaining));
    const session = await options.signaling.getP2PSession(options.sessionId);
    signal = findRemoteSignal(session.candidates, options.role, options.sourceId, options.signalType);
  }
  return signal;
}

function findRemoteIceSignals(
  candidates: P2PTransportCandidate[],
  role: P2PCandidateRole,
  sourceId: string,
): P2PTransportCandidate[] {
  return candidates.filter((candidate) => candidate.role !== role &&
    candidate.sourceId !== sourceId &&
    candidate.transport === 'datachannel' &&
    candidate.protocol === 'webrtc' &&
    candidate.metadata?.provider === WERIFT_PROVIDER &&
    (candidate.metadata.signalType === 'ice-candidate' || candidate.metadata.signalType === 'ice-complete'));
}

function readIceCandidate(candidate: P2PTransportCandidate): RTCIceCandidateInit {
  const value = candidate.metadata?.candidate;
  if (!isRecord(value) || typeof value.candidate !== 'string') {
    throw new Error(`werift signal ${candidate.id} is missing ICE candidate data`);
  }
  return {
    candidate: value.candidate,
    sdpMid: typeof value.sdpMid === 'string' ? value.sdpMid : undefined,
    sdpMLineIndex: typeof value.sdpMLineIndex === 'number' ? value.sdpMLineIndex : undefined,
    usernameFragment: typeof value.usernameFragment === 'string' ? value.usernameFragment : undefined,
  };
}

function findRemoteSignal(
  candidates: P2PTransportCandidate[],
  role: P2PCandidateRole,
  sourceId: string,
  signalType: WeriftSignalType,
): P2PTransportCandidate | undefined {
  return candidates.find((candidate) => candidate.role !== role &&
    candidate.sourceId !== sourceId &&
    candidate.transport === 'datachannel' &&
    candidate.protocol === 'webrtc' &&
    candidate.metadata?.provider === WERIFT_PROVIDER &&
    candidate.metadata.signalType === signalType &&
    typeof candidate.metadata.sdp === 'string');
}

function readSignalSdp(candidate: P2PTransportCandidate): string {
  const sdp = candidate.metadata?.sdp;
  if (typeof sdp !== 'string' || sdp.length === 0) {
    throw new Error(`werift signal ${candidate.id} is missing SDP`);
  }
  return sdp;
}

async function waitForNodeDataChannel(peer: RTCPeerConnection, timeoutMs: number): Promise<RTCDataChannel> {
  const [channel] = await peer.onDataChannel.asPromise(timeoutMs);
  if (!channel) {
    throw new Error('Timed out waiting for remote werift DataChannel');
  }
  return channel;
}

async function waitForChannelOpen(channel: RTCDataChannel, timeoutMs: number): Promise<void> {
  if (channel.readyState === 'open') {
    return;
  }
  await channel.stateChange.watch((state) => state === 'open', timeoutMs);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
