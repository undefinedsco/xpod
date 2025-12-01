import net from 'node:net';
import { describe, it, expect, afterEach } from 'vitest';
import { FrpRelay } from '../../../src/edge/frp/FrpRelay';

describe('FrpRelay', () => {
  const relays: FrpRelay[] = [];
  const servers: net.Server[] = [];

  afterEach(() => {
    for (const relay of relays) {
      relay.stop();
    }
    relays.length = 0;
    for (const server of servers) {
      server.close();
    }
    servers.length = 0;
  });

  it('creates and stops relay without errors', () => {
    const relay = new FrpRelay();
    relays.push(relay);
    expect(relay).toBeDefined();
    relay.stop();
  });

  it('relays data between client and target', async () => {
    const targetPort = 19876;
    const relayPort = 19877;
    const receivedData: string[] = [];

    // Create target server
    const targetServer = net.createServer((socket) => {
      socket.on('data', (data) => {
        receivedData.push(data.toString());
        socket.write(`echo: ${data.toString()}`);
      });
    });
    servers.push(targetServer);

    await new Promise<void>((resolve) => {
      targetServer.listen(targetPort, '127.0.0.1', resolve);
    });

    // Start relay
    const relay = new FrpRelay();
    relays.push(relay);
    relay.start({
      bindPort: relayPort,
      targetHost: '127.0.0.1',
      targetPort,
    });

    // Wait for relay to start
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Connect through relay
    const response = await new Promise<string>((resolve, reject) => {
      const client = net.createConnection(relayPort, '127.0.0.1', () => {
        client.write('hello');
      });
      client.on('data', (data) => {
        client.end();
        resolve(data.toString());
      });
      client.on('error', reject);
    });

    expect(receivedData).toContain('hello');
    expect(response).toBe('echo: hello');
  });

  it('handles multiple stop calls gracefully', () => {
    const relay = new FrpRelay();
    relays.push(relay);
    relay.stop();
    relay.stop();
    expect(relay).toBeDefined();
  });
});
