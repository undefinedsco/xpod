import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SakuraFrpTunnelProvider,
  parseSakuraCredential,
} from '../../src/tunnel/SakuraFrpTunnelProvider';

const { spawnMock, execSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  execSync: execSyncMock,
}));

/** A fetch stand-in that answers the two SakuraFrp open API reads discovery needs. */
function createSakuraApi(options: {
  tunnels?: unknown;
  nodes?: unknown;
  tunnelsStatus?: number;
  reject?: Error;
}) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (options.reject) {
      throw options.reject;
    }
    if (url.endsWith('/tunnels')) {
      return new Response(JSON.stringify(options.tunnels ?? []), {
        status: options.tunnelsStatus ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(options.nodes ?? {}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

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

    const provider = new SakuraFrpTunnelProvider({
      token: 'sakura-token',
      fetchImpl: createSakuraApi({ tunnels: [] }) as unknown as typeof fetch,
    });
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

    const provider = new SakuraFrpTunnelProvider({
      token: 'sakura-token',
      connectTimeoutMs: 1_200,
      fetchImpl: createSakuraApi({ tunnels: [] }) as unknown as typeof fetch,
    });
    const config = await provider.setup({ subdomain: 'local', localPort: 3300 });
    const started = provider.start(config);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

    child.stdout.emit('data', Buffer.from('login to server success\n'));
    expect(provider.getStatus()).toMatchObject({ connected: false, stage: 'control-connected' });

    await expect(started).rejects.toThrow(/timeout|failed/i);
    expect(provider.getStatus().connected).toBe(false);
  }, 40_000);

  it('keeps a proxy start failure instead of leaving the tunnel connected', async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);

    const provider = new SakuraFrpTunnelProvider({
      token: 'sakura-token',
      connectTimeoutMs: 20_000,
      fetchImpl: createSakuraApi({ tunnels: [] }) as unknown as typeof fetch,
    });
    const config = await provider.setup({ subdomain: 'local', localPort: 3300 });
    const started = provider.start(config);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

    child.stdout.emit('data', Buffer.from('login to server success\nstart proxy success\n'));
    await started;
    expect(provider.getStatus()).toMatchObject({ connected: true, stage: 'proxy-ready' });

    child.stdout.emit('data', Buffer.from('start proxy error: port already used\n'));
    expect(provider.getStatus()).toMatchObject({ connected: false, stage: 'failed' });
  }, 40_000);

  it('reads the platform-assigned entry instead of asking the operator for a domain', async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);
    const fetchImpl = createSakuraApi({
      tunnels: [{ id: 114514, node: 62, type: 'tcp', remote: '23333', extra: 'auto_https = auto' }],
      nodes: { 62: { host: 'cn-62.natfrp.com' } },
    });

    const provider = new SakuraFrpTunnelProvider({
      token: 'access-key:114514',
      connectTimeoutMs: 20_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const config = await provider.setup({ subdomain: 'local', localPort: 3399 });
    const started = provider.start(config);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

    child.stdout.emit('data', Buffer.from('login to server success\nstart proxy success\n'));
    await started;

    expect(provider.getStatus()).toMatchObject({
      connected: true,
      stage: 'proxy-ready',
      endpoint: 'https://cn-62.natfrp.com:23333/',
    });
    expect(provider.getEndpoint()).toBe('https://cn-62.natfrp.com:23333/');
  }, 40_000);

  it('uses the bound domain when the platform assigned one', async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);
    const fetchImpl = createSakuraApi({
      tunnels: [{ id: 7, node: 62, type: 'https', remote: 'xpod.example.com' }],
      nodes: { 62: { host: 'cn-62.natfrp.com' } },
    });

    const provider = new SakuraFrpTunnelProvider({
      token: 'access-key:7',
      connectTimeoutMs: 20_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const config = await provider.setup({ subdomain: 'local', localPort: 3399 });
    const started = provider.start(config);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.stdout.emit('data', Buffer.from('start proxy success\n'));
    await started;

    expect(provider.getStatus().endpoint).toBe('https://xpod.example.com/');
  }, 40_000);

  it('refuses to claim a plain-HTTP entry the platform itself blocks', async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);
    const fetchImpl = createSakuraApi({
      tunnels: [{ id: 114514, node: 35, type: 'tcp', remote: '35246' }],
      nodes: { 35: { host: 'frp-dad.com' } },
    });

    const provider = new SakuraFrpTunnelProvider({
      token: 'access-key:114514',
      connectTimeoutMs: 20_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const config = await provider.setup({ subdomain: 'local', localPort: 5737 });
    const started = provider.start(config);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.stdout.emit('data', Buffer.from('start proxy success\n'));
    await started;

    expect(provider.getStatus()).toMatchObject({ connected: true, stage: 'proxy-ready' });
    expect(provider.getStatus().endpoint).toBeUndefined();
    expect(provider.getStatus().error).toMatch(/^sakura-auto-https-required:/u);
  }, 40_000);

  it('claims no endpoint when the platform cannot be asked', async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);
    const fetchImpl = createSakuraApi({ reject: new Error('offline') });

    const provider = new SakuraFrpTunnelProvider({
      token: 'access-key:114514',
      connectTimeoutMs: 20_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const config = await provider.setup({ subdomain: 'local', localPort: 3399 });
    const started = provider.start(config);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.stdout.emit('data', Buffer.from('start proxy success\n'));
    await started;

    // Readiness is still reported, but no URL is invented for it.
    expect(provider.getStatus()).toMatchObject({ connected: true, stage: 'proxy-ready' });
    expect(provider.getStatus().endpoint).toBeUndefined();
    expect(provider.getEndpoint()).toBeUndefined();
  }, 40_000);

  it('keeps the declared endpoint as the fallback when discovery has nothing to say', async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);
    const fetchImpl = createSakuraApi({ tunnels: [] });

    const provider = new SakuraFrpTunnelProvider({
      token: 'access-key:114514',
      publicUrl: 'https://declared.example.com',
      connectTimeoutMs: 20_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const config = await provider.setup({ subdomain: 'local', localPort: 3399 });
    const started = provider.start(config);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.stdout.emit('data', Buffer.from('start proxy success\n'));
    await started;

    expect(provider.getStatus().endpoint).toBe('https://declared.example.com/');
  }, 40_000);

  it('splits the console startup parameter into an access key and tunnel ids', () => {
    expect(parseSakuraCredential('wdnmdtoken6666666:114514,114516')).toEqual({
      accessKey: 'wdnmdtoken6666666',
      tunnelIds: [ '114514', '114516' ],
    });
    expect(parseSakuraCredential('bare-access-key')).toEqual({ accessKey: 'bare-access-key', tunnelIds: [] });
    expect(parseSakuraCredential(undefined)).toEqual({ tunnelIds: [] });
  });

  it('uses the frpc binary the deployment points at', async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);

    const provider = new SakuraFrpTunnelProvider({
      token: 'access-key:114514',
      frpcPath: '/opt/natfrp/frpc',
      connectTimeoutMs: 20_000,
      fetchImpl: createSakuraApi({ tunnels: [] }) as unknown as typeof fetch,
    });
    const config = await provider.setup({ subdomain: 'local', localPort: 3399 });
    const started = provider.start(config);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    expect(spawnMock.mock.calls[0][0]).toBe('/opt/natfrp/frpc');

    child.stdout.emit('data', Buffer.from('start proxy success\n'));
    await started;
  }, 40_000);

  it('completes a bare access key with the single tunnel the platform reports', async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);
    const fetchImpl = createSakuraApi({
      tunnels: [{ id: 29212252, node: 35, type: 'tcp', remote: '35246', extra: 'auto_https = auto' }],
      nodes: { 35: { host: 'frp-dad.com' } },
    });

    const provider = new SakuraFrpTunnelProvider({
      token: 'bare-access-key',
      connectTimeoutMs: 20_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const config = await provider.setup({ subdomain: 'local', localPort: 5737 });
    const started = provider.start(config);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.stdout.emit('data', Buffer.from('start proxy success\n'));
    await started;

    // `frpc -f` needs the tunnel id, and the platform just told us which tunnel this key owns.
    expect(spawnMock.mock.calls[0][1]).toEqual([ '-f', 'bare-access-key:29212252' ]);
    expect(provider.getStatus().endpoint).toBe('https://frp-dad.com:35246/');
  }, 40_000);

  it('leaves an ambiguous credential alone instead of guessing a tunnel', async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);
    const fetchImpl = createSakuraApi({
      tunnels: [
        { id: 1, node: 35, type: 'tcp', remote: '35246' },
        { id: 2, node: 35, type: 'tcp', remote: '35247' },
      ],
      nodes: { 35: { host: 'frp-dad.com' } },
    });

    const provider = new SakuraFrpTunnelProvider({
      token: 'bare-access-key',
      connectTimeoutMs: 20_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const config = await provider.setup({ subdomain: 'local', localPort: 5737 });
    const started = provider.start(config);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.stdout.emit('data', Buffer.from('start proxy success\n'));
    await started;

    expect(spawnMock.mock.calls[0][1]).toEqual([ '-f', 'bare-access-key' ]);
  }, 40_000);

  it('reads the official client vocabulary, not only the upstream one', async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);

    const provider = new SakuraFrpTunnelProvider({
      token: 'access-key:29212252',
      connectTimeoutMs: 20_000,
      fetchImpl: createSakuraApi({
        tunnels: [{ id: 29212252, node: 35, type: 'tcp', remote: '35246', extra: 'auto_https = auto' }],
        nodes: { 35: { host: 'frp-dad.com' } },
      }) as unknown as typeof fetch,
    });
    const config = await provider.setup({ subdomain: 'local', localPort: 5737 });
    const started = provider.start(config);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

    child.stdout.emit('data', Buffer.from('正在连接节点 [lt.frp-dad.com, tcp]\n连接节点成功, 运行 ID [3428400-2f51ab03]\n'));
    expect(provider.getStatus()).toMatchObject({ connected: false, stage: 'control-connected' });

    child.stdout.emit('data', Buffer.from('已为 lt.frp-dad.com 生成自签证书\n隧道启动中: [xpod, tcp]\n隧道启动成功\n'));
    await started;
    expect(provider.getStatus()).toMatchObject({ connected: true, stage: 'proxy-ready' });
  }, 40_000);

  it('falls back to the entry the client printed when the platform API publishes no host', async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);

    const provider = new SakuraFrpTunnelProvider({
      token: 'access-key:29212252',
      connectTimeoutMs: 20_000,
      fetchImpl: createSakuraApi({
        tunnels: [{ id: 29212252, node: 99, type: 'tcp', remote: '35246', extra: 'auto_https = auto' }],
        nodes: { 99: { host: '' } },
      }) as unknown as typeof fetch,
    });
    const config = await provider.setup({ subdomain: 'local', localPort: 5737 });
    const started = provider.start(config);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.stdout.emit('data', Buffer.from('使用 >>frp-dad.com:35246<< 连接你的隧道\n隧道启动成功\n'));
    await started;

    expect(provider.getStatus()).toMatchObject({ connected: true, endpoint: 'https://frp-dad.com:35246/' });
  }, 40_000);

  it('names a missing frpc binary instead of reporting a network failure', async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);

    const provider = new SakuraFrpTunnelProvider({
      token: 'sakura-token',
      connectTimeoutMs: 800,
      fetchImpl: createSakuraApi({ tunnels: [] }) as unknown as typeof fetch,
    });
    const config = await provider.setup({ subdomain: 'local', localPort: 3300 });
    const started = provider.start(config);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.emit('error', Object.assign(new Error('spawn frpc ENOENT'), { code: 'ENOENT' }));

    await expect(started).rejects.toThrow(/frpc/);
    // The provider segment is the catalog id (`sakura_frp`), never the implementation-local
    // `sakura-frp`; the install hint from the catalog follows the machine-readable prefix.
    expect(provider.getStatus().error).toMatch(/^binary-missing:sakura_frp:frpc/u);
    expect(provider.getStatus().error).toContain('natfrp');
  }, 40_000);
});
