import { describe, expect, it } from 'vitest';
import {
  AcceptanceArgumentError,
  acceptLiveDirectory,
  assertStoredLoginTarget,
  resolveAcceptanceTarget,
  type LiveDirectoryOptions,
} from '../../scripts/accept-live-agent-directory';

const gateway = 'https://gateway.example/';
const podRoot = 'https://alice.example/storage/';

function transport(options: { invalidApi?: boolean; headDenied?: boolean; lostUpdateReceipt?: boolean; lostConflictReceipt?: boolean; cleanupRace?: boolean; deleteNoop?: boolean; cleanupChild?: boolean } = {}) {
  const store = new Map<string, { body: string; version: number }>();
  const calls: { url: string; method: string; headers: Headers }[] = [];
  const request: LiveDirectoryOptions['discover'] = async (url, init) => {
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    calls.push({ url, method, headers });
    const parsed = new URL(url);
    if (parsed.pathname === '/.well-known/openid-configuration') {
      return Response.json({ issuer: gateway, token_endpoint: `${gateway}token` });
    }
    const root = parsed.searchParams.get('root')!;
    if (parsed.pathname === '/-/agent-directory/list') {
      if (options.invalidApi) return new Response('<html>OLD_GATEWAY</html>', { status: 200 });
      const listing = {
        root, complete: true, truncated: false, scanned: store.size,
        entries: [...store.keys()].filter((key) => key !== root && key.startsWith(root)).map((key) => ({
          path: key.slice(root.length), url: key, type: key.endsWith('/') ? 'container' : 'file',
        })),
      };
      if (options.cleanupChild && root !== podRoot && listing.entries.length === 0) {
        const directory = store.get(root)!;
        directory.version += 1;
        store.set(new URL('external.txt', root).href, { body: 'ANOTHER_CLIENT_CHILD', version: 1 });
      }
      return Response.json(listing);
    }
    if (parsed.pathname === '/-/agent-directory/search') {
      const query = parsed.searchParams.get('q')!;
      return Response.json({
        root, query, mode: 'literal', ignoreCase: false, complete: true, truncated: false,
        scannedFiles: 1, skippedUnsupported: 0, hasUnscannedScope: false,
        matches: [...store].filter(([key, value]) => key.startsWith(root) && value.body.includes(query)).map(([key, value]) => ({
          path: key.slice(root.length), url: key, line: 1, column: 1, text: value.body.trim(), matched: query,
        })),
      });
    }
    if (url === podRoot && method === 'HEAD') {
      return new Response(options.headDenied ? 'SECRET_SERVER_BODY' : null, { status: options.headDenied ? 403 : 200 });
    }
    let current = store.get(url);
    const version = (): string => `"v${current!.version}"`;
    if (method === 'PUT') {
      if ((headers.get('if-none-match') === '*' && current) ||
        (headers.has('if-match') && (!current || headers.get('if-match') !== version()))) {
        if (options.lostConflictReceipt) throw new Error('SECRET_LOST_CONFLICT_RESPONSE');
        return new Response(null, { status: 412 });
      }
      current = { body: String(init.body ?? ''), version: (current?.version ?? 0) + 1 };
      store.set(url, current);
      if (options.lostUpdateReceipt && headers.has('if-match')) throw new Error('SECRET_TRANSPORT_FAILURE');
      return new Response(null, { status: 201, headers: { ETag: version() } });
    }
    if (!current) return new Response(null, { status: 404 });
    if (method === 'DELETE') {
      if (options.cleanupRace && !url.endsWith('/') && headers.get('if-match') === version()) {
        current = { body: 'ANOTHER_CLIENT_CONTENT', version: current.version + 1 };
        store.set(url, current);
      }
      if (headers.get('if-match') !== version()) return new Response(null, { status: 412 });
      if (options.deleteNoop) return new Response(null, { status: 204 });
      store.delete(url);
      return new Response(null, { status: 204 });
    }
    if (method === 'HEAD') return new Response(null, { headers: { ETag: version() } });
    if (headers.has('if-match') && headers.get('if-match') !== version()) return new Response(null, { status: 412 });
    if (headers.has('range')) return new Response(current.body.slice(5, 16), {
      status: 206, headers: { ETag: version(), 'Content-Range': `bytes 5-15/${Buffer.byteLength(current.body)}` },
    });
    return new Response(current.body, { headers: { ETag: version() } });
  };
  const config: LiveDirectoryOptions = {
    baseUrl: gateway, podRoot, write: true, discover: request,
    authenticate: async () => ({ webId: 'https://alice.example/profile/card#me', request }),
  };
  return { config, calls, store };
}

describe('live directory acceptance boundaries (injected transport, not live evidence)', () => {
  it('keeps default preflight read-only and does not claim OS mount acceptance', async () => {
    const fixture = transport();
    const result = await acceptLiveDirectory({ ...fixture.config, write: false });
    expect(result.status).toBe('pass');
    expect(result.phase).toBe('preflight');
    expect(result.mount).toBe('not-run');
    expect(fixture.calls.every((call) => call.method === 'GET' || call.method === 'HEAD')).toBe(true);
  });

  it('stops before mutations when an old Gateway returns HTML for the directory endpoint', async () => {
    const fixture = transport({ invalidApi: true });
    const result = await acceptLiveDirectory(fixture.config);
    expect(result.status).toBe('fail');
    expect(result.checks[result.checks.length - 1]?.name).toBe('directory-api');
    expect(fixture.calls.some((call) => call.method === 'PUT' || call.method === 'DELETE')).toBe(false);
  });

  it('does not print server bodies or credential errors and stops at failed prerequisites', async () => {
    const fixture = transport({ headDenied: true });
    const result = await acceptLiveDirectory(fixture.config);
    expect(result.checks[result.checks.length - 1]).toEqual({ name: 'pod-read-access', status: 'fail', code: 'http_403' });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(fixture.calls.some((call) => call.method === 'PUT')).toBe(false);
    const authFailure = await acceptLiveDirectory({ ...fixture.config, authenticate: async () => { throw new Error('SECRET_TOKEN'); } });
    expect(authFailure.status).toBe('fail');
    expect(JSON.stringify(authFailure)).not.toContain('SECRET');
  });

  it('exercises Range and stale versions, then conditionally removes only its isolated resources', async () => {
    const fixture = transport();
    const result = await acceptLiveDirectory(fixture.config);
    expect(result.status).toBe('pass');
    expect(result.phase).toBe('pod-http-contract');
    expect(result.checks.every((check) => check.status === 'pass')).toBe(true);
    expect(result.cleanup).toEqual({ status: 'pass', retained: [] });
    expect(fixture.store.size).toBe(0);
    const mutations = fixture.calls.filter((call) => call.method === 'PUT' || call.method === 'DELETE');
    expect(mutations.length).toBeGreaterThan(5);
    expect(mutations.every((call) => call.url.startsWith(`${podRoot}xpod-cli-acceptance-`))).toBe(true);
    expect(mutations.every((call) => call.headers.has('if-match') || call.headers.get('if-none-match') === '*')).toBe(true);
  });

  it('retains an unknown write instead of deleting it using the earlier receipt', async () => {
    const fixture = transport({ lostUpdateReceipt: true });
    const result = await acceptLiveDirectory(fixture.config);
    expect(result.status).toBe('fail');
    expect(result.cleanup.status).toBe('retained');
    expect(result.cleanup.retained).toHaveLength(2);
    expect(fixture.calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('does not use an earlier receipt for cleanup when a conflict response is lost', async () => {
    const fixture = transport({ lostConflictReceipt: true });
    const result = await acceptLiveDirectory(fixture.config);
    expect(result.status).toBe('fail');
    expect(result.cleanup.status).toBe('retained');
    expect(result.cleanup.retained).toHaveLength(2);
    expect(fixture.calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
  });

  it('does not erase a concurrent external change during cleanup or report a clean pass', async () => {
    const fixture = transport({ cleanupRace: true });
    const result = await acceptLiveDirectory(fixture.config);
    expect(result.status).toBe('fail');
    expect(result.cleanup.status).toBe('retained');
    expect([...fixture.store.values()].some((entry) => entry.body === 'ANOTHER_CLIENT_CONTENT')).toBe(true);
    expect(fixture.calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/'))).toBe(false);
  });

  it('verifies absence rather than trusting a successful cleanup receipt', async () => {
    const fixture = transport({ deleteNoop: true });
    const result = await acceptLiveDirectory(fixture.config);
    expect(result.status).toBe('fail');
    expect(result.cleanup.status).toBe('retained');
    expect(result.checks.every((check) => check.status === 'pass')).toBe(true);
    expect(result.cleanup.retained).toHaveLength(2);
    expect(fixture.store.size).toBe(2);
  });

  it('keeps the directory version from before listing if another client adds a child during cleanup', async () => {
    const fixture = transport({ cleanupChild: true });
    const result = await acceptLiveDirectory(fixture.config);
    expect(result.status).toBe('fail');
    expect(result.cleanup.status).toBe('retained');
    expect([...fixture.store.values()].some((entry) => entry.body === 'ANOTHER_CLIENT_CHILD')).toBe(true);
    const directoryDeletes = fixture.calls.filter((call) => call.method === 'DELETE' && call.url.endsWith('/'));
    expect(directoryDeletes).toHaveLength(1);
    expect(directoryDeletes[0].headers.get('if-match')).toBe('"v1"');
  });

  it('reports the target as baseUrl rather than a gateway field', async () => {
    const fixture = transport();
    const result = await acceptLiveDirectory({ ...fixture.config, write: false });
    expect(result.target).toMatchObject({ baseUrl: gateway, podRoot });
    expect(JSON.stringify(result)).not.toContain('"gateway"');
  });
});

describe('acceptance target resolution (arguments and environment only)', () => {
  const local = 'http://127.0.0.1:3000/';
  const remote = 'https://node.example/';
  const localPod = 'http://127.0.0.1:3000/alice/';
  const remotePod = 'https://node.example/alice/';

  function argumentError(argv: readonly string[], env: NodeJS.ProcessEnv): AcceptanceArgumentError {
    try {
      resolveAcceptanceTarget(argv, env);
    } catch (error) {
      if (error instanceof AcceptanceArgumentError) return error;
      throw error;
    }
    throw new Error('expected AcceptanceArgumentError');
  }

  it('accepts explicit local and remote --base_url targets', () => {
    expect(resolveAcceptanceTarget(
      [ '--base_url', local, '--pod-root', localPod ], {},
    )).toEqual({ baseUrl: local, podRoot: localPod, write: false, report: undefined, help: false });
    expect(resolveAcceptanceTarget(
      [ '--base_url', remote, '--pod-root', remotePod, '--write' ], {},
    )).toMatchObject({ baseUrl: remote, podRoot: remotePod, write: true });
  });

  it('uses XPOD_BASE_URL only when --base_url is absent and lets the flag win', () => {
    expect(resolveAcceptanceTarget([ '--pod-root', remotePod ], { XPOD_BASE_URL: remote }))
      .toMatchObject({ baseUrl: remote });
    expect(resolveAcceptanceTarget(
      [ '--base_url', local, '--pod-root', localPod ], { XPOD_BASE_URL: remote },
    )).toMatchObject({ baseUrl: local });
  });

  it('never falls back to CSS_BASE_URL and prefers the remote XPOD_BASE_URL', () => {
    expect(resolveAcceptanceTarget(
      [ '--pod-root', remotePod ], { CSS_BASE_URL: local, XPOD_BASE_URL: remote },
    )).toMatchObject({ baseUrl: remote });
    expect(argumentError([ '--pod-root', localPod ], { CSS_BASE_URL: local }).code).toBe('invalid_target_url');
  });

  it('never reads the removed XPOD_LIVE_GATEWAY_URL', () => {
    expect(argumentError([ '--pod-root', remotePod ], { XPOD_LIVE_GATEWAY_URL: remote }).code)
      .toBe('invalid_target_url');
  });

  it('rejects the removed --gateway flag explicitly instead of ignoring it', () => {
    for (const argv of [
      [ '--gateway', remote, '--pod-root', remotePod ],
      [ '--gateway=' + remote, '--pod-root', remotePod ],
    ]) {
      expect(argumentError(argv, { XPOD_BASE_URL: local }).code).toBe('removed_argument_gateway');
    }
  });

  it('accepts only the exact underscore --base_url switch', () => {
    expect(argumentError([ '--base-url', remote, '--pod-root', remotePod ], {}).code).toBe('invalid_arguments');
  });

  it('binds the stored login to the canonical target before authenticated Pod requests', () => {
    expect(() => assertStoredLoginTarget('https://node.example', remote)).not.toThrow();
    expect(() => assertStoredLoginTarget(remote, remote)).not.toThrow();
    try {
      assertStoredLoginTarget('https://other.example/', remote);
      expect.unreachable('a mismatched stored login must be rejected');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('stored_login_base_url_mismatch');
    }
  });
});
