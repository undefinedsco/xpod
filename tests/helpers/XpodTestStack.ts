import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import kill from 'tree-kill';
import { getFreePort } from '../../src/runtime/port-finder';

export class XpodTestStack {
  public port = 0;
  private proc: ChildProcess | null = null;

  async start(mode = 'local'): Promise<void> {
    const envFile = path.resolve('.env.local');
    if (!fs.existsSync(envFile)) {
      throw new Error(`XpodTestStack: .env.local not found at ${envFile}. Copy from example.env first.`);
    }

    this.port = await getFreePort(10000);
    const mainJs = path.resolve('dist/main.js');

    this.proc = spawn(process.execPath, [mainJs, '--port', String(this.port), '--mode', mode, '--env', envFile], {
      stdio: 'pipe',
      env: { ...process.env, CSS_BASE_URL: `http://localhost:${this.port}/` },
    });

    this.proc.stderr?.on('data', (d: Buffer) => process.stderr.write(d));

    await this.waitReady();
  }

  async stop(): Promise<void> {
    if (!this.proc?.pid) return;
    await new Promise<void>((resolve) => {
      kill(this.proc!.pid!, 'SIGTERM', () => resolve());
    });
    this.proc = null;
  }

  private async waitReady(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const url = `http://localhost:${this.port}/service/status`;

    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return;
      } catch { /* not ready yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`XpodTestStack: timed out waiting for ${url}`);
  }
}
