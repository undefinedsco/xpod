import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';
import { describe, expect, it } from 'vitest';
import { discoverUdpServerReflexiveCandidate } from '../../../src/edge/reachability';

const MAGIC_COOKIE = 0x2112A442;

describe('UDP STUN candidate discovery', () => {
  it('builds a server-reflexive p2p candidate from a STUN binding response on the same socket', async () => {
    const stunServer = await createFakeStunServer({
      mappedHost: '203.0.113.44',
      mappedPort: 43122,
    });
    const socket = createSocket('udp4');
    await bind(socket, 0, '127.0.0.1');

    try {
      const candidate = await discoverUdpServerReflexiveCandidate({
        socket,
        stunServer: { host: '127.0.0.1', port: stunServer.port },
        sessionId: 'p2p-session-1',
        role: 'client',
        sourceId: 'device-1',
        timeoutMs: 1_000,
        randomId: () => 'fixed-id',
        now: () => new Date('2026-06-20T00:00:00.000Z'),
      });

      expect(candidate).toMatchObject({
        id: 'udp_srflx_client_device-1_fixed-id',
        role: 'client',
        sourceId: 'device-1',
        createdAt: '2026-06-20T00:00:00.000Z',
        protocol: 'udp',
        transport: 'udp',
        host: '203.0.113.44',
        port: 43122,
        metadata: {
          provider: 'stun',
          candidateType: 'server-reflexive',
          sessionId: 'p2p-session-1',
          stunServer: '127.0.0.1',
          stunPort: stunServer.port,
        },
      });
      expect(stunServer.lastRequestFrom?.port).toBe((socket.address() as { port: number }).port);
    } finally {
      socket.close();
      await stunServer.close();
    }
  });
});

async function createFakeStunServer(options: {
  mappedHost: string;
  mappedPort: number;
}): Promise<{
  port: number;
  lastRequestFrom?: RemoteInfo;
  close(): Promise<void>;
}> {
  const socket = createSocket('udp4');
  const server = {
    port: 0,
    lastRequestFrom: undefined as RemoteInfo | undefined,
    close: async () => {
      await close(socket);
    },
  };
  socket.on('message', (message, remote) => {
    server.lastRequestFrom = remote;
    const transactionId = message.subarray(8, 20);
    const response = buildBindingSuccessResponse(transactionId, options.mappedHost, options.mappedPort);
    socket.send(response, remote.port, remote.address);
  });
  await bind(socket, 0, '127.0.0.1');
  server.port = (socket.address() as { port: number }).port;
  return server;
}

function buildBindingSuccessResponse(transactionId: Buffer, mappedHost: string, mappedPort: number): Buffer {
  const attribute = Buffer.alloc(12);
  attribute.writeUInt16BE(0x0020, 0);
  attribute.writeUInt16BE(8, 2);
  attribute.writeUInt8(0, 4);
  attribute.writeUInt8(0x01, 5);
  attribute.writeUInt16BE(mappedPort ^ (MAGIC_COOKIE >>> 16), 6);
  const addressParts = mappedHost.split('.').map((part) => Number(part));
  for (let index = 0; index < 4; index += 1) {
    attribute[8 + index] = addressParts[index] ^ ((MAGIC_COOKIE >>> (24 - index * 8)) & 0xff);
  }

  const response = Buffer.alloc(20 + attribute.length);
  response.writeUInt16BE(0x0101, 0);
  response.writeUInt16BE(attribute.length, 2);
  response.writeUInt32BE(MAGIC_COOKIE, 4);
  transactionId.copy(response, 8);
  attribute.copy(response, 20);
  return response;
}

async function bind(socket: Socket, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once('listening', resolve);
    socket.once('error', reject);
    socket.bind(port, host);
  });
}

async function close(socket: Socket): Promise<void> {
  await new Promise<void>((resolve) => {
    socket.close(() => resolve());
  });
}
