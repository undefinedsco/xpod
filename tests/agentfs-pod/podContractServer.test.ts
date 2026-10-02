import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPodContractServer, type PodContractServer } from './support/podContractServer';

const BIG_BODY = `${'x'.repeat(200_000)}\nBIG_END\n`;

describe('Pod HTTP contract fixture used by the AgentFS mount lower', () => {
  let server: PodContractServer;

  beforeAll(async () => {
    server = await startPodContractServer({
      token: 'contract-token',
      deniedPaths: [ 'secret.txt' ],
      files: {
        'alpha.txt': 'ALPHA_BODY_0123456789\n',
        'big.txt': BIG_BODY,
        'secret.txt': 'SECRET_CONTRACT_PAYLOAD\n',
      },
    });
  });

  afterAll(async () => {
    await server.close();
  });

  function authorized(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: 'Bearer contract-token', ...extra };
  }

  function fileUrl(relative: string): string {
    return `${server.podRoot}${relative}`;
  }

  it('readdir returns metadata only and never touches file bodies', async () => {
    server.resetLog();
    const response = await fetch(`${server.origin}/-/agent-directory/list?root=${encodeURIComponent(server.podRoot)}`, { headers: authorized() });
    const body = (await response.json()) as { entries: { path: string; size: number }[] };

    expect(response.status).toBe(200);
    expect(body.entries.map((entry) => entry.path).sort()).toEqual([ 'alpha.txt', 'big.txt' ]);
    expect(body.entries.find((entry) => entry.path === 'big.txt')?.size).toBe(Buffer.byteLength(BIG_BODY));

    expect(server.log).toHaveLength(1);
    expect(server.log[0].path).toContain('/-/agent-directory/list');
    expect(server.log[0].responseBytes).toBeLessThan(1_024);
    expect(server.log.some((entry) => entry.method === 'GET' && entry.resource !== undefined)).toBe(false);
  });

  it('search returns matching lines only and never the directory body', async () => {
    server.resetLog();
    const response = await fetch(`${server.origin}/-/agent-directory/search?q=BIG_END&root=${encodeURIComponent(server.podRoot)}`, { headers: authorized() });
    const body = (await response.json()) as { matches: { path: string; line: number; text: string }[]; complete: boolean };

    expect(response.status).toBe(200);
    expect(body.matches).toEqual([
      expect.objectContaining({ path: 'big.txt', line: 2, text: 'BIG_END' }),
    ]);
    const searchLog = server.log.find((entry) => entry.path.includes('/search'));
    expect(searchLog?.responseBytes).toBeLessThan(1_024);
    expect(searchLog?.responseBytes).toBeLessThan(Buffer.byteLength(BIG_BODY) / 50);
  });

  it('HEAD returns stat metadata with no response body', async () => {
    server.resetLog();
    const response = await fetch(fileUrl('alpha.txt'), { method: 'HEAD', headers: authorized() });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength('ALPHA_BODY_0123456789\n')));
    expect(response.headers.get('etag')).toBe('"v1"');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect((await response.text()).length).toBe(0);

    expect(server.log).toHaveLength(1);
    expect(server.log[0].responseBytes).toBe(0);
  });

  it('GET returns the full body for a single file', async () => {
    const response = await fetch(fileUrl('alpha.txt'), { headers: authorized() });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ALPHA_BODY_0123456789\n');
  });

  it('range reads return the exact requested bytes only', async () => {
    server.resetLog();
    const response = await fetch(fileUrl('alpha.txt'), { headers: authorized({ range: 'bytes=6-14' }) });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 6-14/22');
    expect(await response.text()).toBe('BODY_0123');

    expect(server.log).toHaveLength(1);
    expect(server.log[0].range).toBe('bytes=6-14');
    expect(server.log[0].responseBytes).toBe(9);
    expect(server.log[0].responseBytes).toBeLessThan(Buffer.byteLength('ALPHA_BODY_0123456789\n'));
  });

  it('conditional create uses If-None-Match and rejects an existing resource', async () => {
    const created = await fetch(fileUrl('created.txt'), {
      method: 'PUT',
      headers: authorized({ 'if-none-match': '*' }),
      body: 'NEW_FILE',
    });
    expect(created.status).toBe(201);

    const conflict = await fetch(fileUrl('created.txt'), {
      method: 'PUT',
      headers: authorized({ 'if-none-match': '*' }),
      body: 'AGAIN',
    });
    expect(conflict.status).toBe(412);
    expect(server.readBody('created.txt')).toBe('NEW_FILE');
  });

  it('conditional update rejects a stale version with 412 and keeps content', async () => {
    const current = await fetch(fileUrl('alpha.txt'), { method: 'HEAD', headers: authorized() });
    const etag = current.headers.get('etag');
    expect(etag).toBe('"v1"');

    const stale = await fetch(fileUrl('alpha.txt'), {
      method: 'PUT',
      headers: authorized({ 'if-match': '"v0"' }),
      body: 'STALE_WRITE',
    });
    expect(stale.status).toBe(412);
    expect(server.readBody('alpha.txt')).toBe('ALPHA_BODY_0123456789\n');

    const accepted = await fetch(fileUrl('alpha.txt'), {
      method: 'PUT',
      headers: authorized({ 'if-match': etag ?? '' }),
      body: 'UPDATED_BODY\n',
    });
    expect(accepted.status).toBe(204);
    expect(accepted.headers.get('etag')).toBe('"v2"');
    expect(server.readBody('alpha.txt')).toBe('UPDATED_BODY\n');
  });

  it('conditional delete requires the current version', async () => {
    const head = await fetch(fileUrl('alpha.txt'), { method: 'HEAD', headers: authorized() });
    const etag = head.headers.get('etag') ?? '';

    const noVersion = await fetch(fileUrl('alpha.txt'), { method: 'DELETE', headers: authorized() });
    expect(noVersion.status).toBe(412);

    const deleted = await fetch(fileUrl('alpha.txt'), { method: 'DELETE', headers: authorized({ 'if-match': etag }) });
    expect(deleted.status).toBe(204);
    expect(server.readBody('alpha.txt')).toBe('');
  });

  it('enforces authentication, denial and path scope', async () => {
    const anonymous = await fetch(`${server.origin}/-/agent-directory/list?root=${encodeURIComponent(server.podRoot)}`);
    expect(anonymous.status).toBe(401);

    const denied = await fetch(fileUrl('secret.txt'), { headers: authorized() });
    expect(denied.status).toBe(403);

    const traversal = await fetch(`${server.podRoot}..%2Foutside.txt`, { headers: authorized() });
    expect(traversal.status).toBe(403);
  });

  it('exposes external mutations so a cached reader can detect staleness', async () => {
    const before = await fetch(fileUrl('big.txt'), { method: 'HEAD', headers: authorized() });
    const etag = before.headers.get('etag') ?? '';
    expect(etag).toBe('"v1"');

    server.mutate('big.txt', 'REMOTE_UPDATE\n');

    const after = await fetch(fileUrl('big.txt'), { headers: authorized() });
    expect(after.headers.get('etag')).toBe('"v2"');
    expect(await after.text()).toBe('REMOTE_UPDATE\n');

    const staleWrite = await fetch(fileUrl('big.txt'), {
      method: 'PUT',
      headers: authorized({ 'if-match': etag }),
      body: 'LOCAL_WRITE',
    });
    expect(staleWrite.status).toBe(412);
    expect(server.readBody('big.txt')).toBe('REMOTE_UPDATE\n');
  });

  it('accounts request and response bytes for writes', async () => {
    server.resetLog();
    const response = await fetch(fileUrl('bytes.txt'), {
      method: 'PUT',
      headers: authorized({ 'if-none-match': '*' }),
      body: 'PAYLOAD_1234567890',
    });
    expect(response.status).toBe(201);
    const put = server.log.find((entry) => entry.method === 'PUT');
    expect(put?.requestBytes).toBe(Buffer.byteLength('PAYLOAD_1234567890'));
  });
});
