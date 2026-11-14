import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { stopCommand } from '../../src/cli/commands/stop';

describe('Gateway stop acknowledgment', () => {
  it.each([200, 503])('stops a reachable Gateway with no running children (status %s)', async (status) => {
    await checkStop(status, 202);
  });

  it('does not report stopped or accepted when the stop endpoint fails', async () => {
    await checkStop(503, 500);
  });
});

async function checkStop(status: number, stopStatus: number): Promise<void> {
  const requests: string[] = [];
  const services = [{ name: 'css', status: 'crashed' }, { name: 'api', status: 'given-up' }];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader('Content-Type', 'application/json');
    response.statusCode = request.url === '/service/status' ? status : stopStatus;
    response.end(JSON.stringify(request.url === '/service/status' ? services : { accepted: stopStatus === 202 }));
  });
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP fixture address missing');
    if (typeof stopCommand.handler !== 'function') throw new Error('CLI stop handler missing');
    await stopCommand.handler({ port: address.port, host: '127.0.0.1', timeout: 10000, json: true, _: [], $0: 'xpod' });
    expect(requests).toEqual(['GET /service/status', 'POST /service/stop']);
    const result = JSON.parse(String(output.mock.calls[0]?.[0]));
    expect(result.data.stopped).toBe(false);
    expect(result.data.services).toEqual(services);
    if (stopStatus === 202) {
      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({ running: false, accepted: true, state: 'closing' });
    } else {
      expect(result.ok).toBe(false);
      expect(result.code).toBe('stop_signal_failed');
      expect(result.data.accepted).not.toBe(true);
    }
  } finally {
    output.mockRestore();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
