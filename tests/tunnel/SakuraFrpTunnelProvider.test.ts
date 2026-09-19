import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SakuraFrpTunnelProvider } from '../../src/tunnel/SakuraFrpTunnelProvider';

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

describe('SakuraFrpTunnelProvider', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    execSyncMock.mockReset();
    execSyncMock.mockImplementation(() => {
      throw new Error('no frpc running');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the active profile public endpoint in setup status', async () => {
    const provider = new SakuraFrpTunnelProvider({
      token: 'sakura-token',
      publicUrl: 'https://sakura.example.com',
    });

    const config = await provider.setup({
      subdomain: 'local',
      localPort: 5737,
    });

    expect(config.endpoint).toBe('https://sakura.example.com/');
    expect(provider.getEndpoint()).toBe('https://sakura.example.com/');
  });

  it('refuses to adopt a foreign frpc instead of reporting it as our tunnel', async () => {
    execSyncMock.mockImplementation(() => Buffer.from(''));

    const provider = new SakuraFrpTunnelProvider({ token: 'sakura-token' });
    const config = await provider.setup({ subdomain: 'local', localPort: 3300 });
    await provider.start(config);

    expect(spawnMock).not.toHaveBeenCalled();
    expect(provider.getStatus()).toMatchObject({
      connected: false,
      stage: 'failed',
      error: 'frpc-already-running',
    });
    expect(provider.isManagedByUs()).toBe(false);
  });

  it('treats a successful login as a control connection, not a published proxy', async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);

    const provider = new SakuraFrpTunnelProvider({ token: 'sakura-token', connectTimeoutMs: 1_200 });
    const config = await provider.setup({ subdomain: 'local', localPort: 3300 });
    const started = provider.start(config);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

    child.stdout.emit('data', Buffer.from('login to server success\n'));
    expect(provider.getStatus()).toMatchObject({ connected: false, stage: 'control-connected' });

    await expect(started).rejects.toThrow(/timeout|failed/i);
    expect(provider.getStatus().connected).toBe(false);
  }, 20_000);

  it('keeps a proxy start failure instead of leaving the tunnel connected', async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);

    const provider = new SakuraFrpTunnelProvider({ token: 'sakura-token', connectTimeoutMs: 5_000 });
    const config = await provider.setup({ subdomain: 'local', localPort: 3300 });
    const started = provider.start(config);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

    child.stdout.emit('data', Buffer.from('login to server success\nstart proxy success\n'));
    await started;
    expect(provider.getStatus()).toMatchObject({ connected: true, stage: 'proxy-ready' });

    child.stdout.emit('data', Buffer.from('start proxy error: port already used\n'));
    expect(provider.getStatus()).toMatchObject({ connected: false, stage: 'failed' });
  }, 20_000);

  it('names a missing frpc binary instead of reporting a network failure', async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);

    const provider = new SakuraFrpTunnelProvider({ token: 'sakura-token', connectTimeoutMs: 800 });
    const config = await provider.setup({ subdomain: 'local', localPort: 3300 });
    const started = provider.start(config);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.emit('error', Object.assign(new Error('spawn frpc ENOENT'), { code: 'ENOENT' }));

    await expect(started).rejects.toThrow(/frpc/);
    expect(provider.getStatus().error).toBe('binary-missing:sakura-frp:frpc');
  }, 20_000);
});
