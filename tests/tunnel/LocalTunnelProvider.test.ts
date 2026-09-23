import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalTunnelProvider, readDashboardOrigin } from '../../src/tunnel/LocalTunnelProvider';

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

  it('reports a timeout as not ready instead of a running tunnel', async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);

    const provider = new LocalTunnelProvider({ tunnelToken: 'cf-token', connectTimeoutMs: 800 });
    const config = await provider.setup({ subdomain: 'local', localPort: 3300 });
    await provider.start(config);

    expect(provider.getStatus()).toMatchObject({
      connected: false,
      stage: 'failed',
      error: 'cloudflared-connect-timeout',
    });
  }, 20_000);

  it('keeps the last error visible after a stop', async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);

    const provider = new LocalTunnelProvider({ tunnelToken: 'cf-token', connectTimeoutMs: 800 });
    const config = await provider.setup({ subdomain: 'local', localPort: 3300 });
    await provider.start(config);
    await provider.stop();

    expect(provider.getStatus()).toMatchObject({
      running: false,
      connected: false,
      stage: 'stopped',
      error: 'cloudflared-connect-timeout',
    });
  }, 20_000);

  it('names a missing cloudflared binary instead of reporting a network failure', async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);

    const provider = new LocalTunnelProvider({ tunnelToken: 'cf-token', connectTimeoutMs: 800 });
    const config = await provider.setup({ subdomain: 'local', localPort: 3300 });
    const started = provider.start(config);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    const error = Object.assign(new Error('spawn cloudflared ENOENT'), { code: 'ENOENT' });
    child.emit('error', error);

    await expect(started).rejects.toThrow(/cloudflared/);
    // The prefix stays machine-readable; the catalog's install hint is appended for operators.
    expect(provider.getStatus().error).toMatch(/^binary-missing:cloudflare:cloudflared/u);
    expect(provider.getStatus().error).toContain('CLOUDFLARED_BIN');
  }, 20_000);

  it('only reports ready once cloudflared registered the tunnel connection', async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);

    const provider = new LocalTunnelProvider({ tunnelToken: 'cf-token', connectTimeoutMs: 5_000 });
    const config = await provider.setup({ subdomain: 'local', localPort: 3300 });
    const started = provider.start(config);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

    child.stderr.emit('data', Buffer.from('2026-01-01T00:00:00Z INF Starting tunnel\n'));
    expect(provider.getStatus().connected).toBe(false);

    child.stderr.emit('data', Buffer.from('2026-01-01T00:00:00Z INF Registered tunnel connection connIndex=0\n'));
    await started;

    expect(provider.getStatus()).toMatchObject({ connected: true, stage: 'proxy-ready' });
  }, 20_000);
});

describe('cloudflared dashboard origin', () => {
  it('reads both the scheme and the port a remotely-managed tunnel declares', () => {
    const line = 'INF Updated to new configuration config="{\"ingress\":[{\"hostname\":\"node.example.com\",\"service\":\"http://localhost:5737\"}]}" originCertPath=';
    expect(readDashboardOrigin(line)).toEqual({ scheme: 'http', port: 5737 });
    // An https service in front of this plain-HTTP ingress listener is a 502 with no clue.
    const https = 'INF Updated to new configuration config="{\"ingress\":[{\"service\":\"https://localhost:5737\"}]}"';
    expect(readDashboardOrigin(https)).toEqual({ scheme: 'https', port: 5737 });
    expect(readDashboardOrigin('INF Registered tunnel connection connIndex=0')).toBeUndefined();
  });
});
