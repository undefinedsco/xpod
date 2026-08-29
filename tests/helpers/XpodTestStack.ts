import path from 'path';
import { randomUUID } from 'node:crypto';
import { getFreePort } from '../../src/runtime/port-finder';
import { startXpodRuntime, type XpodRuntimeHandle, type XpodRuntimeOptions } from '../../src/runtime/XpodRuntime';
import { resolveTestRuntimeTransport } from './runtimeTransport';

export class XpodTestStack {
  public port = 0;
  public baseUrl = '';
  public socketPath?: string;
  private runtime: XpodRuntimeHandle | null = null;
  private runtimeGatewayAdminProxyAuthSecret?: string;

  /**
   * Test-only access to the ephemeral gateway secret generated for this
   * runtime. The production runtime intentionally does not expose it on its
   * public handle; integration fixtures that exercise trusted loopback
   * access need the same secret as the child API process.
   */
  public get testGatewayAdminProxyAuthSecret(): string {
    if (!this.runtimeGatewayAdminProxyAuthSecret) {
      throw new Error('XpodTestStack has not captured a gateway admin proxy secret.');
    }
    return this.runtimeGatewayAdminProxyAuthSecret;
  }

  async start(mode = 'local', options: Partial<XpodRuntimeOptions> = {}): Promise<void> {
    const transport = resolveTestRuntimeTransport(options.transport);
    const portOptions = transport === 'port' ? await this.resolvePortOptions(options) : {};
    const runtimeRoot = options.runtimeRoot
      ?? path.resolve('.test-data', 'xpod-test-stack', randomUUID());
    const rootFilePath = options.rootFilePath ?? path.join(runtimeRoot, 'data');

    const runtimeBaseUrl = options.baseUrl ?? portOptions.baseUrl;
    const env = {
      // Test stacks are hermetic by default. A local test runtime is its own issuer
      // unless the test explicitly supplies an external IdP.
      ...(runtimeBaseUrl ? { SOLID_OIDC_ISSUER: runtimeBaseUrl } : {}),
      ...(options.env ?? {}),
    };

    // resolveRuntimeBootstrap applies this secret to the parent environment
    // before the child services start, then startXpodRuntime restores it
    // before returning. Capture it only while startup is in flight; never
    // write it to logs, snapshots, or runtime artifacts.
    let capturedSecret: string | undefined;
    const captureSecret = (): void => {
      const candidate = process.env.XPOD_GATEWAY_ADMIN_PROXY_AUTH_SECRET;
      if (candidate) {
        capturedSecret = candidate;
      }
    };
    captureSecret();
    const captureTimer = setInterval(captureSecret, 0);
    try {
      this.runtime = await startXpodRuntime({
        mode: mode as 'local' | 'cloud',
        open: true,
        transport,
        runtimeRoot,
        rootFilePath,
        ...portOptions,
        ...options,
        env,
      });
    } finally {
      clearInterval(captureTimer);
      captureSecret();
    }
    this.runtimeGatewayAdminProxyAuthSecret = capturedSecret;
    if (!this.runtimeGatewayAdminProxyAuthSecret) {
      throw new Error('XpodTestStack failed to capture the runtime gateway admin proxy secret.');
    }

    this.port = this.runtime.ports.gateway ?? 0;
    this.baseUrl = this.runtime.baseUrl;
    this.socketPath = this.runtime.sockets.gateway;

    await this.waitReady();
  }

  private async resolvePortOptions(options: Partial<XpodRuntimeOptions>): Promise<Partial<XpodRuntimeOptions>> {
    const basePort = 30_000 + Math.floor(Math.random() * 20_000);
    const bindHost = options.bindHost ?? '127.0.0.1';
    const gatewayPort = options.gatewayPort ?? await getFreePort(basePort, bindHost);
    const cssPort = options.cssPort ?? await getFreePort(gatewayPort + 1, bindHost);
    const apiPort = options.apiPort ?? await getFreePort(cssPort + 1, bindHost);

    return {
      bindHost,
      baseUrl: options.baseUrl ?? `http://localhost:${gatewayPort}/`,
      gatewayPort,
      cssPort,
      apiPort,
    };
  }

  async stop(): Promise<void> {
    if (!this.runtime) {
      return;
    }
    await this.runtime.stop();
    this.runtime = null;
    this.runtimeGatewayAdminProxyAuthSecret = undefined;
  }

  async runtimeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    if (!this.runtime) {
      throw new Error('XpodTestStack has not been started.');
    }
    return this.runtime.fetch(input, init);
  }

  private async waitReady(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const url = new URL('/service/status', this.baseUrl).href;

    while (Date.now() < deadline) {
      try {
        const res = await (this.runtime?.fetch(url, { signal: AbortSignal.timeout(2000) }) ?? fetch(url, { signal: AbortSignal.timeout(2000) }));
        if (res.ok) return;
      } catch { /* not ready yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`XpodTestStack: timed out waiting for ${url}`);
  }
}
