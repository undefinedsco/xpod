import {
  RTCPeerConnection,
  type PeerConfig,
  type RTCDataChannel,
} from 'werift';
import type { P2PCandidateRole, P2PTransportCandidate } from './types';
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

export interface SignaledWeriftDataChannelConnection {
  peer: RTCPeerConnection;
  channel: RTCDataChannel;
  localSignal: P2PTransportCandidate;
  remoteSignal: P2PTransportCandidate;
  close(): Promise<void>;
}

type WeriftSignalType = 'offer' | 'answer';

export async function connectWeriftDataChannelThroughSignaling(
  options: ConnectWeriftDataChannelThroughSignalingOptions,
): Promise<SignaledWeriftDataChannelConnection> {
  return options.role === 'client'
    ? connectClient(options)
    : connectNode(options);
}

async function connectClient(
  options: ConnectWeriftDataChannelThroughSignalingOptions,
): Promise<SignaledWeriftDataChannelConnection> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const label = options.label ?? DEFAULT_LABEL;
  const peer = new RTCPeerConnection(options.peerConfig);
  const channel = peer.createDataChannel(label, { ordered: true });

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
    await waitForChannelOpen(channel, timeoutMs);
    return buildConnection(peer, channel, localSignal, remoteSignal);
  } catch (error) {
    await peer.close();
    throw error;
  }
}

async function connectNode(
  options: ConnectWeriftDataChannelThroughSignalingOptions,
): Promise<SignaledWeriftDataChannelConnection> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const label = options.label ?? DEFAULT_LABEL;
  const peer = new RTCPeerConnection(options.peerConfig);
  const nodeChannelPromise = waitForNodeDataChannel(peer, timeoutMs);

  try {
    const initialSession = await options.signaling.getP2PSession(options.sessionId);
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
    const channel = await nodeChannelPromise;
    await waitForChannelOpen(channel, timeoutMs);
    return buildConnection(peer, channel, localSignal, remoteSignal);
  } catch (error) {
    await peer.close();
    throw error;
  }
}

function buildConnection(
  peer: RTCPeerConnection,
  channel: RTCDataChannel,
  localSignal: P2PTransportCandidate,
  remoteSignal: P2PTransportCandidate,
): SignaledWeriftDataChannelConnection {
  return {
    peer,
    channel,
    localSignal,
    remoteSignal,
    close: async () => {
      channel.close();
      await peer.close();
    },
  };
}

function buildSignalCandidate(
  options: ConnectWeriftDataChannelThroughSignalingOptions,
  signalType: WeriftSignalType,
  sdp: string,
  label: string,
): P2PTransportCandidate {
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
      sdpType: signalType,
      sdp,
      label,
      sessionId: options.sessionId,
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
