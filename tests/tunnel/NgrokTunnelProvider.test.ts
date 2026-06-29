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

});
