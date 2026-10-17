import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { PodHttpLowerFileSystem, PodLowerConflictError, PodLowerHttpError } from '../../packages/xpod-afs/src/agent-fs/pod-lower';
import { AgentDirectoryClient, type AgentDirectoryRequest } from '../../packages/xpod-afs/src/directory/client';
import { startPodContractServer, type PodContractServer } from './support/podContractServer';

const TOKEN = 'counterexample-token';
const ALPHA = 'ALPHA_BODY_0123456789\n';

function authedFetch(token: string): AgentDirectoryRequest {
  return (url, init) =>
    fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` },
    });
}

async function startRawServer(
  handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => handler(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

describe('PodHttpLowerFileSystem conditional-write counterexamples', () => {
  let server: PodContractServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('does not issue an unconditional DELETE when no version baseline is given', async () => {
    let deleteSawIfMatch: boolean | undefined;
    const raw = await startRawServer((request, response) => {
      deleteSawIfMatch = request.headers['if-match'] !== undefined;
      response.writeHead(204);
      response.end();
    });
    const request = authedFetch(TOKEN);
    const lower = new PodHttpLowerFileSystem({
      baseUrl: `${raw.origin}/pod/`,
      request,
      client: new AgentDirectoryClient({ baseUrl: `${raw.origin}/pod/`, request }),
    });
    try {
      await expect(lower.remove('alpha.txt')).rejects.toBeInstanceOf(PodLowerHttpError);
      expect(deleteSawIfMatch).toBeUndefined();
    } finally {
      await raw.close();
    }
  });

  it('replaces an existing target on rename (editor atomic-save pattern)', async () => {
    server = await startPodContractServer({
      token: TOKEN,
      files: { 'from.txt': 'NEW_CONTENT\n', 'to.txt': 'OLD_CONTENT\n' },
    });
    const request = authedFetch(TOKEN);
    const lower = new PodHttpLowerFileSystem({
      baseUrl: server.podRoot,
      request,
      client: new AgentDirectoryClient({ baseUrl: server.podRoot, request }),
    });

    await lower.rename('from.txt', 'to.txt');
    expect(server.readBody('to.txt')).toBe('NEW_CONTENT\n');
    expect(server.readBody('from.txt')).toBe('');
  });

  it('keeps a pending operation when commit hits a hard server error', async () => {
    const raw = await startRawServer((_request, response) => {
      response.writeHead(500, { 'content-type': 'application/json', 'content-length': 2 });
      response.end('{}');
    });
    const request = authedFetch(TOKEN);
    const lower = new PodHttpLowerFileSystem({
      baseUrl: `${raw.origin}/pod/`,
      request,
      client: new AgentDirectoryClient({ baseUrl: `${raw.origin}/pod/`, request }),
    });
    try {
      lower.enqueue({ id: 'e1', op: 'write', path: 'broken.txt', dataBase64: Buffer.from('X').toString('base64'), create: true });
      await expect(lower.commit()).rejects.toBeInstanceOf(PodLowerHttpError);
      expect(lower.listPending().map((operation) => operation.id)).toEqual([ 'e1' ]);
    } finally {
      await raw.close();
    }
  });

  it('rejects a conditional overwrite with a stale base version (no unconditional fallback)', async () => {
    server = await startPodContractServer({ token: TOKEN, files: { 'alpha.txt': ALPHA } });
    const request = authedFetch(TOKEN);
    const lower = new PodHttpLowerFileSystem({
      baseUrl: server.podRoot,
      request,
      client: new AgentDirectoryClient({ baseUrl: server.podRoot, request }),
    });
    server.mutate('alpha.txt', 'REMOTE\n');
    await expect(lower.write('alpha.txt', Buffer.from('LOCAL\n'), '"v1"')).rejects.toBeInstanceOf(PodLowerConflictError);
    expect(server.readBody('alpha.txt')).toBe('REMOTE\n');
  });
});
