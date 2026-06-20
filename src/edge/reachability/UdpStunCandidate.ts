import type { Socket } from 'node:dgram';
import type { P2PCandidateRole, P2PTransportCandidate } from './types';

const STUN_BINDING_REQUEST = 0x0001;
const STUN_BINDING_SUCCESS_RESPONSE = 0x0101;
const STUN_ATTR_MAPPED_ADDRESS = 0x0001;
const STUN_ATTR_XOR_MAPPED_ADDRESS = 0x0020;
const STUN_MAGIC_COOKIE = 0x2112A442;
const DEFAULT_TIMEOUT_MS = 3_000;

export interface UdpStunServer {
  host: string;
  port: number;
}

export interface DiscoverUdpServerReflexiveCandidateOptions {
  socket: Socket;
  stunServer: UdpStunServer;
  sessionId: string;
  role: P2PCandidateRole;
  sourceId: string;
  timeoutMs?: number;
  randomId?: () => string;
  now?: () => Date;
}

export async function discoverUdpServerReflexiveCandidate(
  options: DiscoverUdpServerReflexiveCandidateOptions,
): Promise<P2PTransportCandidate> {
  const randomId = options.randomId ?? (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  const now = options.now ?? (() => new Date());
  const transactionId = createTransactionId();
  const response = await sendStunBindingRequest({
    socket: options.socket,
    server: options.stunServer,
    transactionId,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  const mappedAddress = parseStunBindingResponse(response, transactionId);

  return {
    id: `udp_srflx_${options.role}_${options.sourceId}_${randomId()}`,
    role: options.role,
    sourceId: options.sourceId,
    createdAt: now().toISOString(),
    protocol: 'udp',
    transport: 'udp',
    host: mappedAddress.host,
    port: mappedAddress.port,
    metadata: {
      provider: 'stun',
      candidateType: 'server-reflexive',
      sessionId: options.sessionId,
      stunServer: options.stunServer.host,
      stunPort: options.stunServer.port,
    },
  };
}

async function sendStunBindingRequest(options: {
  socket: Socket;
  server: UdpStunServer;
  transactionId: Buffer;
  timeoutMs: number;
}): Promise<Buffer> {
  const request = Buffer.alloc(20);
  request.writeUInt16BE(STUN_BINDING_REQUEST, 0);
  request.writeUInt16BE(0, 2);
  request.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  options.transactionId.copy(request, 8);

  return new Promise<Buffer>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`STUN binding request to ${options.server.host}:${options.server.port} timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    const onMessage = (message: Buffer): void => {
      if (!isMatchingStunResponse(message, options.transactionId)) {
        return;
      }
      cleanup();
      resolve(message);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      options.socket.off('message', onMessage);
      options.socket.off('error', onError);
    };

    options.socket.on('message', onMessage);
    options.socket.on('error', onError);
    options.socket.send(request, options.server.port, options.server.host, (error) => {
      if (error) {
        cleanup();
        reject(error);
      }
    });
  });
}

function parseStunBindingResponse(message: Buffer, transactionId: Buffer): { host: string; port: number } {
  if (!isMatchingStunResponse(message, transactionId)) {
    throw new Error('STUN response transaction id does not match request');
  }
  const length = message.readUInt16BE(2);
  if (message.byteLength < 20 + length) {
    throw new Error('STUN response length exceeds datagram size');
  }

  let mappedAddress: { host: string; port: number } | undefined;
  for (let offset = 20; offset < 20 + length;) {
    if (offset + 4 > message.byteLength) {
      break;
    }
    const type = message.readUInt16BE(offset);
    const attributeLength = message.readUInt16BE(offset + 2);
    const valueOffset = offset + 4;
    const nextOffset = valueOffset + paddedAttributeLength(attributeLength);
    if (valueOffset + attributeLength > message.byteLength) {
      break;
    }
    if (type === STUN_ATTR_XOR_MAPPED_ADDRESS) {
      mappedAddress = parseXorMappedAddress(message.subarray(valueOffset, valueOffset + attributeLength));
      break;
    }
    if (type === STUN_ATTR_MAPPED_ADDRESS && !mappedAddress) {
      mappedAddress = parseMappedAddress(message.subarray(valueOffset, valueOffset + attributeLength));
    }
    offset = nextOffset;
  }

  if (!mappedAddress) {
    throw new Error('STUN response does not contain a mapped address');
  }
  return mappedAddress;
}

function isMatchingStunResponse(message: Buffer, transactionId: Buffer): boolean {
  return message.byteLength >= 20
    && message.readUInt16BE(0) === STUN_BINDING_SUCCESS_RESPONSE
    && message.readUInt32BE(4) === STUN_MAGIC_COOKIE
    && message.subarray(8, 20).equals(transactionId);
}

function parseXorMappedAddress(value: Buffer): { host: string; port: number } {
  const parsed = parseAddressHeader(value);
  if (parsed.family !== 0x01 || value.byteLength < 8) {
    throw new Error('Only IPv4 STUN XOR-MAPPED-ADDRESS is supported');
  }
  const port = parsed.port ^ (STUN_MAGIC_COOKIE >>> 16);
  const octets = [];
  for (let index = 0; index < 4; index += 1) {
    octets.push(value[4 + index] ^ ((STUN_MAGIC_COOKIE >>> (24 - index * 8)) & 0xff));
  }
  return { host: octets.join('.'), port };
}

function parseMappedAddress(value: Buffer): { host: string; port: number } {
  const parsed = parseAddressHeader(value);
  if (parsed.family !== 0x01 || value.byteLength < 8) {
    throw new Error('Only IPv4 STUN MAPPED-ADDRESS is supported');
  }
  return {
    host: `${value[4]}.${value[5]}.${value[6]}.${value[7]}`,
    port: parsed.port,
  };
}

function parseAddressHeader(value: Buffer): { family: number; port: number } {
  if (value.byteLength < 4 || value[0] !== 0) {
    throw new Error('Invalid STUN address attribute');
  }
  return {
    family: value[1],
    port: value.readUInt16BE(2),
  };
}

function paddedAttributeLength(length: number): number {
  return length + ((4 - (length % 4)) % 4);
}

function createTransactionId(): Buffer {
  const transactionId = Buffer.alloc(12);
  for (let index = 0; index < transactionId.byteLength; index += 1) {
    transactionId[index] = Math.floor(Math.random() * 256);
  }
  return transactionId;
}
