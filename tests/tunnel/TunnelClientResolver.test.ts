import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  describeTunnelClientMissing,
  redistributableTunnelClients,
  resolveAllTunnelClients,
  resolveTunnelClient,
  TunnelClientPathError,
} from '../../src/tunnel/TunnelClientResolver';
import { TUNNEL_PROVIDERS } from '../../src/tunnel/TunnelProviderCatalog';

/**
 * N16: the release artifacts carry no tunnel client, and each provider used to spawn its own bare
 * default name. The catalog now declares the client (name, env key, install hint, licence), one
 * resolver applies the same precedence everywhere, and a missing client says what to install.
 */
describe('tunnel client resolution (N16)', () => {
  async function fakeBinary(name: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tunnel-client-'));
    const file = path.join(dir, name);
    await fs.writeFile(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    return file;
  }

  it('declares a client for every provider, including how to install it', () => {
    for (const descriptor of TUNNEL_PROVIDERS) {
      expect(descriptor.client.binary.length).toBeGreaterThan(0);
      expect(descriptor.client.envKey.length).toBeGreaterThan(0);
      expect(descriptor.client.installHint.length).toBeGreaterThan(0);
      expect(descriptor.client.license.length).toBeGreaterThan(0);
    }
  });

  it('prefers an explicit path over everything else', async () => {
    const explicit = await fakeBinary('cloudflared');

    const resolved = resolveTunnelClient('cloudflare', {
      explicitPath: explicit,
      packageRoot: '/nonexistent-package-root',
      env: { CLOUDFLARED_BIN: '/should/not/be/used' },
    });

    expect(resolved).toMatchObject({ command: explicit, source: 'explicit' });
  });

  it('takes the catalog env key when no explicit path is given', async () => {
    const viaEnv = await fakeBinary('ngrok');

    const resolved = resolveTunnelClient('ngrok', { env: { NGROK_BIN: viaEnv } });

    expect(resolved).toMatchObject({ command: viaEnv, source: 'explicit' });
  });

  it('refuses a configured path that is not executable instead of falling back', () => {
    // Silent fallback would run a different binary than the operator asked for.
    expect(() => resolveTunnelClient('ngrok', { explicitPath: '/definitely/not/ngrok' }))
      .toThrow(TunnelClientPathError);
    try {
      resolveTunnelClient('sakura_frp', { env: { FRPC_BIN: '/definitely/not/frpc' } });
      throw new Error('expected the resolver to refuse the configured path');
    } catch (error) {
      expect(error).toBeInstanceOf(TunnelClientPathError);
      expect((error as Error).message).toContain('natfrp');
    }
  });

  it('uses a bundled client before falling back to PATH', async () => {
    const packageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tunnel-package-'));
    const vendorDir = path.join(packageRoot, 'vendor', 'tunnel-clients');
    await fs.mkdir(vendorDir, { recursive: true });
    const bundled = path.join(vendorDir, 'cloudflared');
    await fs.writeFile(bundled, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const resolved = resolveTunnelClient('cloudflare', { packageRoot, env: {} });

    expect(resolved).toMatchObject({ command: bundled, source: 'bundled' });
  });

  it('resolves a PATH hit to an absolute path so readiness can be judged', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tunnel-path-'));
    const binary = path.join(directory, 'cloudflared');
    await fs.writeFile(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const resolved = resolveTunnelClient('cloudflare', {
      env: { PATH: directory },
      packageRoot: '/nonexistent',
    });

    // The settings page has to be able to say "ready, at <path>"; leaving the bare name for the
    // OS made PATH clients permanently "missing" while the preflight script called them ready.
    expect(resolved).toMatchObject({ command: binary, source: 'path', resolvedPath: binary });
  });

  it('falls back to the bare name when nothing on PATH matches', () => {
    const resolved = resolveTunnelClient('cloudflare', {
      env: { PATH: '/definitely/not/here' },
      packageRoot: '/nonexistent',
    });

    expect(resolved).toMatchObject({ command: 'cloudflared', source: 'path' });
    expect(resolved.resolvedPath).toBeUndefined();
  });

  it('reports a missing client with the provider hint while keeping the machine-readable prefix', () => {
    const message = describeTunnelClientMissing('sakura_frp');

    expect(message).toMatch(/^binary-missing:sakura_frp:frpc/u);
    expect(message).toContain('natfrp');
  });

  it('resolves every provider without throwing, even when clients are absent', () => {
    const results = resolveAllTunnelClients({ env: {}, packageRoot: '/nonexistent' });

    expect(results).toHaveLength(TUNNEL_PROVIDERS.length);
    expect(results.every((entry) => entry.resolved || entry.error)).toBe(true);
  });

  it('only marks clients we may actually ship as redistributable', () => {
    const redistributable = redistributableTunnelClients().map((entry) => entry.provider);

    // cloudflared and upstream frpc are Apache-2.0; ngrok's agent is proprietary and the natfrp
    // fork has no published source, so neither may ride along in our artifacts.
    expect(redistributable).toContain('cloudflare');
    expect(redistributable).not.toContain('ngrok');
    expect(redistributable).not.toContain('sakura_frp');
  });
});
