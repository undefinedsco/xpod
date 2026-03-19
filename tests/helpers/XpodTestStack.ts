import fs from 'fs';
import path from 'path';
import { getFreePort } from '../../src/runtime/port-finder';
import { startXpodRuntime, type XpodRuntimeHandle, type XpodRuntimeOptions } from '../../src/runtime/XpodRuntime';
import { resolveTestRuntimeTransport } from './runtimeTransport';

export class XpodTestStack {
  public port = 0;
  public baseUrl = '';
  public socketPath?: string;
  private runtime: XpodRuntimeHandle | null = null;

  async start(mode = 'local', options: Partial<XpodRuntimeOptions> = {}): Promise<void> {
    const envFile = path.resolve('.env.local');
    const transport = resolveTestRuntimeTransport(options.transport);
    const portOptions = transport === 'port' ? await this.resolvePortOptions(options) : {};

    this.runtime = await startXpodRuntime({
      mode: mode as 'local' | 'cloud',
      open: true,
      transport,
      envFile: fs.existsSync(envFile) ? envFile : undefined,
      ...portOptions,
      ...options,
    });

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
