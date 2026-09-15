import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { expect, test } from '@playwright/test';

type Fixture = { baseUrl: string; runtime: string; bytes: number; sha256: string };

test.use({ trace: 'retain-on-failure' });

test.describe('Gateway response completeness', () => {
  test.describe.configure({ retries: 0 });

  test('delivers every byte of large modules across repeated browser navigation', async ({ browser }, testInfo) => {
    test.setTimeout(180_000);
    const child = spawn(process.env.XPOD_TEST_BUN ?? 'bun', [path.resolve('tests/helpers/proxyResponseFixture.ts')], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let diagnostics = '';
    child.stderr?.on('data', (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-4_096); });
    let completed = 0;
    let runtime = 'unknown';
    let expectedBytes = 0;
    try {
      const fixture = await new Promise<Fixture>((resolve, reject) => {
        let output = '';
        const timeout = setTimeout(() => reject(new Error(`Fixture startup timed out: ${diagnostics}`)), 30_000);
        child.once('error', (error) => { clearTimeout(timeout); reject(error); });
        child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Fixture exited ${code}: ${diagnostics}`)); });
        child.stdout?.on('data', (chunk: Buffer) => {
          output += chunk.toString();
          const line = output.slice(0, output.lastIndexOf('\n') + 1).split('\n').find((value) => value.startsWith('PROXY_RESPONSE_READY '));
          if (!line) return;
          clearTimeout(timeout);
          resolve(JSON.parse(line.slice('PROXY_RESPONSE_READY '.length)) as Fixture);
          output = '';
        });
      });
      runtime = fixture.runtime;
      expectedBytes = fixture.bytes;
      testInfo.annotations.push({ type: 'runtime', description: fixture.runtime });
      testInfo.annotations.push({ type: 'load', description: '64 new browser contexts; 50 ms upstream-consumer delay; cache disabled; no retries' });
      for (let iteration = 0; iteration < 64; iteration += 1) {
        const context = await browser.newContext();
        try {
          const page = await context.newPage();
          const cdp = await context.newCDPSession(page);
          await cdp.send('Network.enable');
          await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
          const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === '/module.js', { timeout: 5_000 });
          const [, response] = await Promise.all([
            page.goto(fixture.baseUrl, { waitUntil: 'domcontentloaded', timeout: 5_000 }),
            responsePromise,
          ]);
          const body = await response.body();
          expect(response.status(), `iteration ${iteration} on ${fixture.runtime}`).toBe(200);
          expect(body.byteLength).toBe(fixture.bytes);
          expect(createHash('sha256').update(body).digest('hex')).toBe(fixture.sha256);
          expect(await page.evaluate(() => Boolean((globalThis as { __proxyPayloadComplete?: boolean }).__proxyPayloadComplete))).toBe(true);
          completed += 1;
        } finally {
          await context.close();
        }
      }
    } finally {
      const reportPath = testInfo.outputPath('completed-transfers.json');
      writeFileSync(reportPath, JSON.stringify({ runtime, expectedBytes, completed }, null, 2));
      await testInfo.attach('completed-transfers', { path: reportPath, contentType: 'application/json' });
      await stopFixture(child);
    }
  });
});

async function stopFixture(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); }, 5_000);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`Proxy response fixture failed to stop cleanly: code=${code}, signal=${signal}`));
    });
    child.kill('SIGTERM');
  });
}
