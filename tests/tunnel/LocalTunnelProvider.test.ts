import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalTunnelProvider } from '../../src/tunnel/LocalTunnelProvider';

const { spawnMock, execSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  execSync: execSyncMock,
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

describe('LocalTunnelProvider', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    execSyncMock.mockReset();
    execSyncMock.mockImplementation(() => {
      throw new Error('not running');
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('metrics unavailable')));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts cloudflared with the configured local origin url', async() => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);

    const provider = new LocalTunnelProvider({
      tunnelToken: 'cf-token',
      cloudflaredPath: 'cloudflared-test',
    });

    const config = await provider.setup({
      subdomain: 'local',
      localPort: 5737,
    });

    const started = provider.start(config);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.stderr.emit('data', Buffer.from('Registered tunnel connection\n'));
    await started;

    expect(config.originUrl).toBe('http://127.0.0.1:5737');
    expect(spawnMock).toHaveBeenCalledWith(
      'cloudflared-test',
      [
        'tunnel',
        '--protocol',
        'http2',
        '--no-autoupdate',
        'run',
        '--token',
        'cf-token',
        '--url',
        'http://127.0.0.1:5737',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  });


  it('uses the active profile public endpoint in setup status', async() => {
    const provider = new LocalTunnelProvider({
      tunnelToken: 'cf-token',
      publicUrl: 'https://home-tunnel.example.com',
      cloudflaredPath: 'cloudflared-test',
    });

    const config = await provider.setup({
      subdomain: 'local',
      localPort: 5737,
    });

    expect(config.endpoint).toBe('https://home-tunnel.example.com/');
    expect(provider.getEndpoint()).toBe('https://home-tunnel.example.com/');
  });

  it('does not treat unrelated cloudflared processes as the managed tunnel', async() => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);
    execSyncMock.mockReturnValue(Buffer.from('12345\n'));

    const provider = new LocalTunnelProvider({
      tunnelToken: 'cf-token',
      cloudflaredPath: 'cloudflared-test',
    });

    const started = provider.start({
      subdomain: 'local',
      provider: 'cloudflare',
      endpoint: '',
      originUrl: 'http://127.0.0.1:5737',
      tunnelToken: 'cf-token',
    });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.stderr.emit('data', Buffer.from('Registered tunnel connection\n'));
    await started;

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(provider.isManagedByUs()).toBe(true);
  });
});
