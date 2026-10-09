import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startPodContractServer } from './support/podContractServer';
import { discoverAgentFsHelper } from './support/helperDiscovery';

interface CapturedCall {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: unknown };
}

const state = vi.hoisted(() => ({
  calls: [] as CapturedCall[],
  requireCount: 0,
  handler: undefined as undefined | ((url: string, init: CapturedCall['init']) => Promise<Response>),
}));

vi.mock('../../src/cli/lib/auth-context', () => ({
  authFetch: async (_context: unknown, url: string, init: CapturedCall['init']) => {
    state.calls.push({ url, init });
    if (!state.handler) {
      throw new Error('no authFetch handler configured');
    }
    return state.handler(url, init);
  },
  requireAuthContext: async () => {
    state.requireCount += 1;
    return { accessToken: `token-${state.requireCount}`, podRoot: 'https://pod.example/alice/' };
  },
}));

const { startAuthProxy } = await import('../../packages/xpod-afs/src/agent-fs/auth-proxy');

const POD_ROOT = 'https://pod.example/alice/';
const CAP = 'test-capability';
const CAP_HEADER = 'x-xpod-agentfs-capability';
const native = discoverAgentFsHelper().helperPath;
const nativeExec = promisify(execFile);

describe('auth-proxy loopback bridge contract (mocked CLI auth, no real credentials)', () => {
  let proxy: Awaited<ReturnType<typeof startAuthProxy>>;

  beforeEach(async () => {
    state.calls = [];
    state.requireCount = 0;
    state.handler = async () => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    proxy = await startAuthProxy({ podRoot: POD_ROOT, capability: CAP });
  });

  afterEach(async () => {
    await proxy.close();
  });

  function cap(extra: Record<string, string> = {}): Record<string, string> {
    return { [CAP_HEADER]: proxy.capability, ...extra };
  }

  it('maps the resource path without doubling the Pod container prefix', async () => {
    const response = await fetch(`${proxy.origin}/alice/a.txt`, { headers: cap() });
    expect(response.status).toBe(200);
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].url).toBe('https://pod.example/alice/a.txt');
    expect(state.calls[0].url).not.toContain('/alice/alice/');
  });

  it('preserves upstream Content-Length on HEAD instead of reporting 0', async () => {
    state.handler = async () => new Response(null, { status: 200, headers: { 'content-length': '22', etag: '"v1"' } });
    const response = await fetch(`${proxy.origin}/alice/a.txt`, { method: 'HEAD', headers: cap() });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('22');
  });

  it('maps its own transport root to the canonical Pod but rejects other loopback origins', async () => {
    state.handler = async () => new Response(JSON.stringify({ entries: [] }), { status: 200, headers: { 'content-type': 'application/json' } });

    const canonical = await fetch(`${proxy.origin}/-/agent-directory/list?root=${encodeURIComponent(POD_ROOT)}`, { headers: cap() });
    expect(canonical.status).toBe(200);
    const forwarded = new URL(state.calls[0].url);
    expect(forwarded.origin).toBe('https://pod.example');
    expect(forwarded.pathname).toBe('/-/agent-directory/list');
    expect(forwarded.searchParams.get('root')).toBe(POD_ROOT);

    state.calls = [];
    const loopbackRoot = `${proxy.origin}/alice/`;
    const own = await fetch(`${proxy.origin}/-/agent-directory/list?root=${encodeURIComponent(loopbackRoot)}`, { headers: cap() });
    expect(own.status).toBe(200);
    expect(new URL(state.calls[0].url).searchParams.get('root')).toBe(POD_ROOT);
    state.calls = [];
    const untrusted = await fetch(`${proxy.origin}/-/agent-directory/list?root=${encodeURIComponent('http://127.0.0.1:1/alice/')}`, { headers: cap() });
    expect(untrusted.status).toBe(403);
    expect(state.calls).toHaveLength(0);
  });

  it('rejects a sidecar read whose URL leaves the Pod root (no cross-identity read)', async () => {
    const bobUrl = 'https://pod.example/bob/secret.txt';
    const response = await fetch(`${proxy.origin}/-/agent-directory/read?url=${encodeURIComponent(bobUrl)}`, { headers: cap() });
    expect(response.status).toBe(403);
    expect(state.calls).toHaveLength(0);
  });

  it('refuses to follow a redirect that leaves the Pod origin', async () => {
    state.handler = async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } });
    const response = await fetch(`${proxy.origin}/alice/a.txt`, { headers: cap() });
    expect(response.status).toBe(403);
  });

  it('refuses mutation redirects rather than letting the native caller escape the proxy', async () => {
    state.handler = async () => new Response(null, { status: 307, headers: { location: 'https://evil.example/delete' } });
    const response = await fetch(`${proxy.origin}/alice/a.txt`, { method: 'DELETE', headers: cap(), redirect: 'manual' });
    expect(response.status).toBe(502);
    expect(response.headers.get('location')).toBeNull();
    expect(state.calls).toHaveLength(1);
  });

  it('keeps the bridge alive when an upstream response body fails midstream', async () => {
    state.handler = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial'));
        setTimeout(() => controller.error(new Error('upstream disconnected')), 20);
      },
    }));
    const response = await fetch(`${proxy.origin}/alice/a.txt`, { headers: cap() });
    await expect(response.text()).rejects.toThrow();
    state.handler = async () => new Response('next-request');
    expect(await (await fetch(`${proxy.origin}/alice/a.txt`, { headers: cap() })).text()).toBe('next-request');
  });

  it('requires the per-mount capability header: a request without it is refused before any Pod call', async () => {
    const response = await fetch(`${proxy.origin}/alice/a.txt`);
    expect(response.status).toBe(401);
    expect(state.calls).toHaveLength(0);
  });

  it('shuts down only through its own capability and never forwards control to the Pod', async () => {
    await proxy.close();
    const shutdown = vi.fn();
    proxy = await startAuthProxy({ podRoot: POD_ROOT, capability: CAP, onShutdown: shutdown });
    const url = `${proxy.origin}/-/agentfs-proxy/shutdown`;
    expect((await fetch(url, { method: 'POST' })).status).toBe(401);
    expect((await fetch(url, { headers: cap() })).status).toBe(405);
    expect(shutdown).not.toHaveBeenCalled();
    expect((await fetch(url, { method: 'POST', headers: cap() })).status).toBe(204);
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
    expect(state.calls).toHaveLength(0);
  });

  it.runIf(Boolean(native) && process.env.XPOD_AGENTFS_RUN_OVERLAY === '1')('mounts the real helper through the authenticated proxy transport', async () => {
    const parent = path.resolve('.test-data/agentfs-proxy');
    await mkdir(parent, { recursive: true });
    const dir = await mkdtemp(path.join(parent, 'bridge-'));
    const mountpoint = path.join(dir, 'mnt');
    const session = path.join(dir, 'session');
    await mkdir(mountpoint);
    const fixture = await startPodContractServer({ token: 'bridge-token', files: { 'alpha.txt': 'PROXY_BODY\n' } });
    await proxy.close();
    proxy = await startAuthProxy({ podRoot: fixture.podRoot, capability: CAP });
    state.handler = async (url, init) => fetch(url, {
      ...init as RequestInit,
      headers: { ...init.headers, authorization: 'Bearer bridge-token' },
    });
    const env = {
      ...process.env, XPOD_AGENTFS_TOKEN: '', XPOD_AGENTFS_CAPABILITY: CAP,
      XPOD_AGENTFS_POD_ROOT: fixture.podRoot, XPOD_AGENTFS_IDENTITY: 'fixture-webid',
    };
    const transport = `${proxy.origin}${new URL(fixture.podRoot).pathname}`;
    try {
      await nativeExec(native as string, [ 'mount', '--server', transport, '--backend', 'nfs', '--mountpoint', mountpoint, '--session-dir', session ], { env, timeout: 30_000 });
      expect(await readFile(path.join(mountpoint, 'alpha.txt'), 'utf8')).toBe('PROXY_BODY\n');
      expect(state.calls.some((call) => new URL(call.url).searchParams.get('root') === fixture.podRoot)).toBe(true);
      await writeFile(path.join(mountpoint, 'new.txt'), 'BRIDGE_LOCAL\n');
      expect(fixture.readBody('new.txt')).toBe('');
      await nativeExec(native as string, [ 'commit', '--pod-root', transport, '--session-dir', session ], { env, timeout: 30_000 });
      expect(fixture.readBody('new.txt')).toBe('BRIDGE_LOCAL\n');
      await writeFile(path.join(mountpoint, 'lost.txt'), 'LOST_RECEIPT_BODY\n');
      fixture.dropNextMutationReceipt();
      await expect(nativeExec(native as string, [ 'commit', '--pod-root', transport, '--session-dir', session ], { env, timeout: 30_000 })).rejects.toThrow();
      expect(fixture.readBody('lost.txt')).toBe('LOST_RECEIPT_BODY\n');
      fixture.resetLog();
      const recovery = await nativeExec(native as string, [ 'recover', '--pod-root', transport, '--session-dir', session, '--json' ], { env, timeout: 30_000 });
      expect(JSON.parse(recovery.stdout)).toEqual({ confirmed: [ 'lost.txt' ], retryable: [], conflicts: [], errors: [] });
      expect(fixture.log.every((entry) => entry.method === 'HEAD' || entry.method === 'GET')).toBe(true);
      expect(await readFile(path.join(mountpoint, 'lost.txt'), 'utf8')).toBe('LOST_RECEIPT_BODY\n');
    } finally {
      await nativeExec(native as string, [ 'unmount', '--mountpoint', mountpoint, '--session-dir', session ], { env, timeout: 30_000 });
      await fixture.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('refreshes credentials on 401 but not on 403', async () => {
    let call = 0;
    state.handler = async () => {
      call += 1;
      return call === 1 ? new Response('denied', { status: 403 }) : new Response('ok', { status: 200 });
    };
    await fetch(`${proxy.origin}/alice/protected.txt`, { headers: cap() });
    expect(state.requireCount).toBe(1);

    state.calls = [];
    state.requireCount = 0;
    call = 0;
    state.handler = async () => {
      call += 1;
      return call === 1 ? new Response('unauthorized', { status: 401 }) : new Response('ok', { status: 200 });
    };
    await fetch(`${proxy.origin}/alice/protected.txt`, { headers: cap() });
    expect(state.requireCount).toBe(2);
  });
});
