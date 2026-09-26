import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NgrokTunnelProvider } from '../../src/tunnel/NgrokTunnelProvider';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

function createMockChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };

  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();

  return child;
}

describe('NgrokTunnelProvider', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('agent api unavailable')));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts ngrok with the configured fixed endpoint and local origin', async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);

    const provider = new NgrokTunnelProvider({
      ngrokPath: 'ngrok-test',
      url: 'https://ravioli-basics-throbbing.ngrok-free.dev',
      authtoken: 'test-token',
    });

    const config = await provider.setup({
      subdomain: 'node-0000',
      localPort: 3000,
    });

    const started = provider.start(config);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.stdout.emit('data', Buffer.from('started tunnel url=https://ravioli-basics-throbbing.ngrok-free.dev\n'));
    await started;

    expect(config).toMatchObject({
      provider: 'ngrok',
      endpoint: 'https://ravioli-basics-throbbing.ngrok-free.dev/',
      originUrl: 'http://127.0.0.1:3000',
    });
    expect(spawnMock).toHaveBeenCalledWith(
      'ngrok-test',
      [
        'http',
        '--log', 'stdout',
        '--log-format', 'json',
        '--url', 'https://ravioli-basics-throbbing.ngrok-free.dev',
        'http://127.0.0.1:3000',
      ],
      expect.objectContaining({
        stdio: ['ignore', 'pipe', 'pipe'],
        env: expect.objectContaining({ NGROK_AUTHTOKEN: 'test-token' }),
      }),
    );
    expect(provider.getStatus()).toMatchObject({
      running: true,
      connected: true,
      endpoint: 'https://ravioli-basics-throbbing.ngrok-free.dev/',
    });
  });

  it('discovers the endpoint from the ngrok agent API when no fixed url is configured', async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        tunnels: [
          {
            public_url: 'https://generated-example.ngrok-free.app',
            proto: 'https',
          },
        ],
      }),
    } as Response);

    const provider = new NgrokTunnelProvider({ ngrokPath: 'ngrok-test' });
    const config = await provider.setup({ subdomain: 'node-0000', localPort: 3000 });

    const started = provider.start(config);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    await started;

    expect(spawnMock).toHaveBeenCalledWith(
      'ngrok-test',
      [
        'http',
        '--log', 'stdout',
        '--log-format', 'json',
        'http://127.0.0.1:3000',
      ],
      expect.any(Object),
    );
    expect(provider.getEndpoint()).toBe('https://generated-example.ngrok-free.app/');
    expect(provider.getStatus()).toMatchObject({
      running: true,
      connected: true,
      endpoint: 'https://generated-example.ngrok-free.app/',
    });
  });

  it('does not treat ngrok documentation error URLs as tunnel endpoints', async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);

    const provider = new NgrokTunnelProvider({
      ngrokPath: 'ngrok-test',
      connectTimeoutMs: 1000,
    });
    const config = await provider.setup({ subdomain: 'node-0000', localPort: 3000 });

    const started = provider.start(config);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.stderr.emit('data', Buffer.from(JSON.stringify({ lvl: 'eror', msg: 'command failed', err: 'authentication failed ERR_NGROK_4018 https://dashboard.ngrok.com/signup' }) + '\nERROR:\n'));
    child.emit('exit', 1);

    await expect(started).rejects.toThrow('ERR_NGROK_4018');
    expect(provider.getEndpoint()).toBeUndefined();
    expect(provider.getStatus()).toMatchObject({
      running: false,
      connected: false,
      error: expect.stringContaining('ERR_NGROK_4018'),
    });
  });

  it('ignores ngrok json log nil errors', async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);

    const provider = new NgrokTunnelProvider({
      ngrokPath: 'ngrok-test',
      connectTimeoutMs: 1000,
    });
    const config = await provider.setup({ subdomain: 'node-0000', localPort: 3000 });

    const started = provider.start(config);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.stdout.emit('data', Buffer.from(JSON.stringify({ lvl: 'info', err: '<nil>', msg: 'open config file' }) + '\n'));
    child.stdout.emit('data', Buffer.from(JSON.stringify({ lvl: 'info', msg: 'started tunnel', url: 'https://generated-example.ngrok-free.app' }) + '\n'));
    await started;

    expect(provider.getStatus()).toMatchObject({
      running: true,
      connected: true,
      endpoint: 'https://generated-example.ngrok-free.app/',
    });
    expect(provider.getStatus().error).toBeUndefined();
  });

  it('does not treat ngrok agent update-check URLs as tunnel endpoints', async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);

    const provider = new NgrokTunnelProvider({
      ngrokPath: 'ngrok-test',
      url: 'https://ravioli-basics-throbbing.ngrok-free.dev',
      connectTimeoutMs: 1000,
    });
    const config = await provider.setup({ subdomain: 'node-0000', localPort: 3000 });

    const started = provider.start(config);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.stdout.emit('data', Buffer.from(JSON.stringify({ lvl: 'warn', msg: 'update check failed https://update.ngrok-agent.com/check/' }) + '\n'));
    child.stdout.emit('data', Buffer.from(JSON.stringify({ lvl: 'info', msg: 'started tunnel' }) + '\n'));
    await started;

    expect(provider.getEndpoint()).toBe('https://ravioli-basics-throbbing.ngrok-free.dev/');
    expect(provider.getStatus()).toMatchObject({
      running: true,
      connected: true,
      endpoint: 'https://ravioli-basics-throbbing.ngrok-free.dev/',
    });
  });


  it('does not accept the local agent web interface as the public endpoint', async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);

    const provider = new NgrokTunnelProvider({ ngrokPath: 'ngrok-test', connectTimeoutMs: 1_200 });
    const config = await provider.setup({ subdomain: 'node-0000', localPort: 3000 });

    const started = provider.start(config);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.stdout.emit('data', Buffer.from('{"url":"http://127.0.0.1:4040","msg":"web interface"}\n'));
    await expect(started).rejects.toThrow(/failed|timeout/i);

    expect(provider.getEndpoint()).not.toBe('http://127.0.0.1:4040/');
    expect(provider.getStatus().connected).toBe(false);
  }, 40_000);

  it('does not treat a bare "started" log line as a published tunnel', async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);

    const provider = new NgrokTunnelProvider({ ngrokPath: 'ngrok-test', connectTimeoutMs: 1_200 });
    const config = await provider.setup({ subdomain: 'node-0000', localPort: 3000 });

    const started = provider.start(config);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.stdout.emit('data', Buffer.from('started\n'));

    await expect(started).rejects.toThrow(/failed|timeout/i);
    expect(provider.getStatus()).toMatchObject({ connected: false, stage: 'failed' });
  }, 20_000);

  it('ignores an agent tunnel that exposes another origin', async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async() => ({
        tunnels: [
          { public_url: 'https://someone-else.ngrok-free.app', config: { addr: 'http://127.0.0.1:9999' } },
        ],
      }),
    } as Response));

    const provider = new NgrokTunnelProvider({ ngrokPath: 'ngrok-test', connectTimeoutMs: 1_200 });
    const config = await provider.setup({ subdomain: 'node-0000', localPort: 3000 });

    const started = provider.start(config);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

    await expect(started).rejects.toThrow(/failed|timeout/i);
    expect(provider.getEndpoint()).not.toBe('https://someone-else.ngrok-free.app/');
  }, 20_000);

  it('accepts the agent entry that exposes our own origin', async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async() => ({
        tunnels: [
          { public_url: 'https://ours.ngrok-free.app', config: { addr: 'http://localhost:3000' } },
        ],
      }),
    } as Response));

    const provider = new NgrokTunnelProvider({ ngrokPath: 'ngrok-test' });
    const config = await provider.setup({ subdomain: 'node-0000', localPort: 3000 });

    await provider.start(config);

    expect(provider.getStatus()).toMatchObject({
      connected: true,
      stage: 'proxy-ready',
      endpoint: 'https://ours.ngrok-free.app/',
    });
  }, 20_000);

  it('keeps the declared entry when ngrok publishes a different one', async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);

    const provider = new NgrokTunnelProvider({
      ngrokPath: 'ngrok-test',
      url: 'https://declared.ngrok-free.app',
      connectTimeoutMs: 5_000,
    });
    const config = await provider.setup({ subdomain: 'node-0000', localPort: 3000 });

    const started = provider.start(config);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.stdout.emit('data', Buffer.from('{"msg":"started tunnel","url":"https://other.ngrok-free.app"}\n'));
    await started;

    // The operator's declaration is what the runtime reports; the discrepancy stays in the
    // logs instead of silently retargeting the node.
    expect(provider.getStatus()).toMatchObject({
      connected: true,
      stage: 'proxy-ready',
      endpoint: 'https://declared.ngrok-free.app/',
    });
  }, 20_000);

  it('never adopts an entry from the shared agent API after its own start failed', async () => {
    // The local agent API is machine-wide, so another instance's tunnel answers there. A
    // provider whose spawn failed has no process and must not claim that entry.
    spawnMock.mockImplementation(() => {
      const child = createMockChildProcess();
      // ENOENT is delivered right after spawn returns, before any async discovery resolves.
      queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn ngrok ENOENT'), { code: 'ENOENT' })));
      return child;
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async() => ({ tunnels: [ { public_url: 'https://someone-elses.ngrok-free.app' } ] }),
    } as Response));

    const provider = new NgrokTunnelProvider({ ngrokPath: 'ngrok-test', connectTimeoutMs: 3_000 });
    const config = await provider.setup({ subdomain: 'node-0000', localPort: 3000 });
    const started = provider.start(config);

    await expect(started).rejects.toThrow(/ngrok|binary-missing/u);
    const status = provider.getStatus();
    expect(status.connected).toBe(false);
    expect(status.stage).toBe('failed');
    expect(status.endpoint).not.toBe('https://someone-elses.ngrok-free.app/');
  }, 20_000);
});

/**
 * N16: the client is resolved through one order (explicit option → catalog env key → bundled →
 * PATH). A provider that ignored the env key would keep spawning whatever `ngrok` happened to be
 * first on PATH, even though the operator pointed it at a specific build.
 */
describe('NgrokTunnelProvider client resolution (N16)', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('agent api unavailable')));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('spawns the binary named by the catalog env key when no explicit option is given', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ngrok-client-'));
    const binary = path.join(tmpDir, 'ngrok-from-env');
    await fs.writeFile(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);

    const provider = new NgrokTunnelProvider({
      env: { NGROK_BIN: binary },
      url: 'https://ravioli-basics-throbbing.ngrok-free.dev',
      authtoken: 'test-token',
    });
    const config = await provider.setup({ subdomain: 'node-0000', localPort: 3000 });
    const started = provider.start(config);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.stdout.emit('data', Buffer.from('started tunnel url=https://ravioli-basics-throbbing.ngrok-free.dev\n'));
    await started;

    expect(spawnMock.mock.calls[0][0]).toBe(binary);
    provider.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
