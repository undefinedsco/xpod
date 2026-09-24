import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';

import {
  readCloudflareRemoteOrigin,
  readDeclaredIngressOrigin,
} from '../../src/tunnel/TunnelDeclaredOrigin';

/**
 * The console-declared origin read-back.
 *
 * Cloudflare named tunnels: the connector's own echo of the remote configuration, parsed by
 * the same `readDashboardOrigin` the provider uses for its origin-mismatch diagnostic.
 * SakuraFrp: `GET /v4/tunnels` `local_port`. Neither reader invents a port when the console
 * says nothing, and no reader is allowed to leave a probe connector behind.
 */

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  exitCode: number | null;
  kill: (signal?: string) => boolean;
  killed: string[];
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.killed = [];
  child.kill = (signal?: string) => {
    child.killed.push(signal ?? 'SIGTERM');
    child.exitCode = 0;
    return true;
  };
  return child;
}

/** The line cloudflared prints after fetching a remotely-managed tunnel's configuration. */
const CLOUDFLARED_REMOTE_CONFIG_LINE =
  '2026-09-23T09:00:00Z INF Updated to new configuration config="{\\"ingress\\":'
  + '[{\\"hostname\\":\\"entry.example.com\\",\\"service\\":\\"http://localhost:5737\\"},'
  + '{\\"service\\":\\"http_status:404\\"}],\\"warp-routing\\":{\\"enabled\\":false}}" version=9';

describe('declared ingress origin read-back', () => {
  it('reads the SakuraFrp console local_port through GET /v4/tunnels', async() => {
    const fetchImpl = vi.fn(async() => new Response(
      JSON.stringify([ { id: 29212252, local_ip: '127.0.0.1', local_port: 5737 } ]),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    const result = await readDeclaredIngressOrigin(
      { id: 'sakura-active', provider: 'sakura_frp', credentialEnvKey: 'SAKURA_TUNNEL_TOKEN' },
      { env: { SAKURA_TUNNEL_TOKEN: 'access-key:29212252' }, active: true, fetchImpl },
    );

    expect(result).toEqual({
      origin: { port: 5737, readBack: 'sakura_frp:GET /v4/tunnels local_port' },
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('/v4/tunnels');
  });

  it('reports that the console declared nothing instead of guessing a port', async() => {
    const fetchImpl = vi.fn(async() => new Response(
      JSON.stringify([ { id: 29212252, local_ip: '127.0.0.1' } ]),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    const result = await readDeclaredIngressOrigin(
      { id: 'sakura-active', provider: 'sakura_frp' },
      { env: { SAKURA_TUNNEL_TOKEN: 'access-key' }, active: true, fetchImpl },
    );

    expect(result.origin).toBeUndefined();
    expect(result.error).toMatch(/no local_port/u);
  });

  it('reads a Cloudflare named tunnel\'s remote configuration and kills the probe connector', async() => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child as unknown as ChildProcess);

    const read = readCloudflareRemoteOrigin('cf-token', {
      command: 'cloudflared',
      timeoutMs: 2_000,
      spawnImpl: spawnImpl as unknown as typeof import('node:child_process').spawn,
    });
    // cloudflared only prints this once it has fetched the remote config.
    setTimeout(() => child.stderr.emit('data', Buffer.from(`${CLOUDFLARED_REMOTE_CONFIG_LINE}\n`)), 10);
    const result = await read;

    expect(result.origin).toEqual({
      port: 5737,
      scheme: 'http',
      readBack: 'cloudflare:connector remote-config',
    });
    expect(spawnImpl).toHaveBeenCalledOnce();
    expect(child.killed).toContain('SIGTERM');
  });

  it('keeps an https declaration visible instead of pretending the scheme matches', async() => {
    const child = fakeChild();
    const read = readCloudflareRemoteOrigin('cf-token', {
      command: 'cloudflared',
      timeoutMs: 2_000,
      spawnImpl: (() => child as unknown as ChildProcess) as unknown as typeof import('node:child_process').spawn,
    });
    setTimeout(
      () => child.stderr.emit('data', Buffer.from(CLOUDFLARED_REMOTE_CONFIG_LINE.replace('http://localhost', 'https://localhost'))),
      10,
    );

    const result = await read;

    expect(result.origin).toMatchObject({ port: 5737, scheme: 'https' });
  });

  it('reports a connector that exits before publishing its remote config', async() => {
    const child = fakeChild();
    const read = readCloudflareRemoteOrigin('cf-token', {
      command: 'cloudflared',
      timeoutMs: 2_000,
      spawnImpl: (() => child as unknown as ChildProcess) as unknown as typeof import('node:child_process').spawn,
    });
    setTimeout(() => {
      child.stderr.emit('data', Buffer.from('2026-09-23T09:00:00Z ERR Provided Tunnel token is not valid\n'));
      child.exitCode = 255;
      child.emit('exit', 255);
    }, 10);

    const result = await read;

    expect(result.origin).toBeUndefined();
    expect(result.error).toMatch(/exited with code 255/u);
  });

  it('reports a missing cloudflared binary with the machine-readable prefix', async() => {
    const child = fakeChild();
    const read = readCloudflareRemoteOrigin('cf-token', {
      command: '/nonexistent/cloudflared',
      timeoutMs: 2_000,
      spawnImpl: (() => child as unknown as ChildProcess) as unknown as typeof import('node:child_process').spawn,
    });
    setTimeout(() => {
      child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    }, 10);

    const result = await read;

    expect(result.error).toMatch(/^binary-missing:cloudflare:/u);
  });

  it('does not start a connector for an inactive Cloudflare profile', async() => {
    const spawnImpl = vi.fn();

    const result = await readDeclaredIngressOrigin(
      { id: 'cf-old', provider: 'cloudflare' },
      {
        env: { CLOUDFLARE_TUNNEL_TOKEN: 'cf-token' },
        active: false,
        readCloudflare: spawnImpl as unknown as typeof readCloudflareRemoteOrigin,
      },
    );

    expect(result.origin).toBeUndefined();
    expect(result.error).toMatch(/only read back for the active profile/u);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('declares nothing for a provider that owns its own origin port or has no credential', async() => {
    const runtimeOwned = await readDeclaredIngressOrigin(
      { id: 'ngrok', provider: 'ngrok' },
      { env: { NGROK_AUTHTOKEN: 'token' }, active: true },
    );
    const noCredential = await readDeclaredIngressOrigin(
      { id: 'sakura-active', provider: 'sakura_frp', credentialEnvKey: 'SAKURA_TUNNEL_TOKEN' },
      { env: {}, active: true },
    );
    const unknown = await readDeclaredIngressOrigin(
      { id: 'legacy', provider: 'not-a-provider' },
      { env: {}, active: true },
    );

    expect(runtimeOwned.error).toMatch(/chooses its own origin port/u);
    expect(noCredential.error).toMatch(/no credential configured/u);
    expect(unknown.error).toMatch(/unknown provider/u);
  });

  it('times out instead of hanging on a locally-managed tunnel that never echoes a config', async() => {
    const child = fakeChild();
    const result = await readCloudflareRemoteOrigin('cf-token', {
      command: 'cloudflared',
      timeoutMs: 20,
      spawnImpl: (() => child as unknown as ChildProcess) as unknown as typeof import('node:child_process').spawn,
    });

    expect(result.origin).toBeUndefined();
    expect(result.error).toMatch(/did not report the tunnel's remote configuration within 20ms/u);
    expect(child.killed).toContain('SIGTERM');
  });
});
