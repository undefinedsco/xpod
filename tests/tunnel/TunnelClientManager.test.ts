import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { TunnelClientManager } from '../../src/tunnel/TunnelClientManager';

/**
 * N16（配置旁边的按钮）：产物不发客户端，但操作者该有"检查"和"下载"。检查报告每个 provider
 * 的客户端从哪来、能不能跑；下载只做我们有稳定直链的客户端（cloudflared），并且**下载完必须
 * 能跑**才留下。
 */
const silentLogger = { info: vi.fn(), warn: vi.fn() };

async function tempRoot(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'tunnel-client-manager-'));
}

async function fakeClient(file: string, version = 'cloudflared version 2026.9.0'): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `#!/bin/sh\necho "${version}"\n`, { mode: 0o755 });
}

describe('TunnelClientManager (N16)', () => {
  it('reports the plugin directory as the place downloads land', async () => {
    const root = await tempRoot();
    const manager = new TunnelClientManager({ packageRoot: root, logger: silentLogger });

    expect(manager.pluginDirectory()).toBe(path.join(root, 'vendor', 'tunnel-clients'));
  });

  it('lists every provider with its client, licence and install hint', async () => {
    const root = await tempRoot();
    const manager = new TunnelClientManager({
      packageRoot: root,
      env: {},
      platform: 'linux',
      arch: 'x64',
      runVersion: async () => undefined,
      logger: silentLogger,
    });

    const clients = await manager.inspectAll();

    expect(clients.map((client) => client.provider)).toEqual([ 'ngrok', 'cloudflare', 'sakura_frp', 'frp' ]);
    expect(clients.every((client) => client.state === 'missing')).toBe(true);
    expect(clients.every((client) => client.installHint.length > 0)).toBe(true);
    expect(clients.find((client) => client.provider === 'cloudflare')?.installable).toBe(true);
    // ngrok and the natfrp fork have no pinned direct asset: the answer is the hint.
    expect(clients.find((client) => client.provider === 'ngrok')?.installable).toBe(false);
    expect(clients.find((client) => client.provider === 'sakura_frp')?.installable).toBe(false);
  });

  it('marks a client ready only once it answers --version', async () => {
    const root = await tempRoot();
    const binary = path.join(root, 'vendor', 'tunnel-clients', 'cloudflared');
    await fakeClient(binary, 'cloudflared version 2026.9.0');
    const manager = new TunnelClientManager({ packageRoot: root, env: {}, runVersion: async () => 'cloudflared version 2026.9.0', logger: silentLogger });

    const cloudflare = await manager.inspect('cloudflare');

    expect(cloudflare).toMatchObject({
      state: 'ready',
      source: 'bundled',
      path: binary,
      version: 'cloudflared version 2026.9.0',
    });
  });

  it('keeps a downloaded binary that runs, in the plugin directory and executable', async () => {
    const root = await tempRoot();
    const fetchImpl = vi.fn(async () => new Response('fake-binary-bytes', { status: 200 }));
    const manager = new TunnelClientManager({
      packageRoot: root,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      runVersion: async () => 'cloudflared version 2026.9.0',
      logger: silentLogger,
    });

    const installed = await manager.install('cloudflare');

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64',
      expect.objectContaining({ redirect: 'follow' }),
    );
    expect(installed.installedPath).toBe(path.join(root, 'vendor', 'tunnel-clients', 'cloudflared'));
    expect(installed.version).toBe('cloudflared version 2026.9.0');
    expect((await fs.stat(installed.installedPath)).mode & 0o777).toBe(0o755);
  });

  it('deletes a download that cannot run instead of calling it installed', async () => {
    const root = await tempRoot();
    const manager = new TunnelClientManager({
      packageRoot: root,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: (async () => new Response('not-a-binary', { status: 200 })) as unknown as typeof fetch,
      runVersion: async () => undefined,
      logger: silentLogger,
    });

    await expect(manager.install('cloudflare')).rejects.toThrow(/did not run/u);
    await expect(fs.stat(path.join(root, 'vendor', 'tunnel-clients', 'cloudflared'))).rejects.toThrow();
  });

  it('refuses providers without a pinned download and says what to do', async () => {
    const root = await tempRoot();
    const manager = new TunnelClientManager({ packageRoot: root, platform: 'linux', arch: 'x64', logger: silentLogger });

    await expect(manager.install('ngrok')).rejects.toThrow(/install it manually|No pinned download/u);
  });

  it('extracts a tgz asset on macOS and verifies the extracted binary', async () => {
    const root = await tempRoot();
    const extractTgz = vi.fn(async (_archive: string, destination: string) => {
      await fakeClient(path.join(destination, 'cloudflared'), 'cloudflared version 2026.9.0');
    });
    const manager = new TunnelClientManager({
      packageRoot: root,
      platform: 'darwin',
      arch: 'arm64',
      fetchImpl: (async () => new Response('tgz-bytes', { status: 200 })) as unknown as typeof fetch,
      extractTgz,
      runVersion: async () => 'cloudflared version 2026.9.0',
      logger: silentLogger,
    });

    const installed = await manager.install('cloudflare');

    expect(extractTgz).toHaveBeenCalledTimes(1);
    expect(installed.version).toBe('cloudflared version 2026.9.0');
  });

  it('surfaces a failed download as a plain error', async () => {
    const root = await tempRoot();
    const manager = new TunnelClientManager({
      packageRoot: root,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: (async () => new Response('nope', { status: 502 })) as unknown as typeof fetch,
      logger: silentLogger,
    });

    await expect(manager.install('cloudflare')).rejects.toThrow(/HTTP 502/u);
  });
});
