import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { ApiServer } from '../../src/api/ApiServer';
import type { AuthMiddleware } from '../../src/api/middleware/AuthMiddleware';
import { registerStaticSpaRoutes } from '../../src/api/handlers/StaticSpaHandler';
import { GatewayProxy } from '../../src/runtime/Proxy';
import { getFreePort } from '../../src/runtime/port-finder';
import { Supervisor } from '../../src/supervisor/Supervisor';

/**
 * A completed upstream response must also finish at the browser-facing gateway.
 * Bun 1.3.8 intermittently emits ClientRequest.close without IncomingMessage.end
 * here, leaving an asset pending forever. No retries are permitted in this probe.
 */
// Budget the whole 1.8 GB stress run separately from each request's 4s deadline.
export const gatewayAssetTransportBudgetMs = 90_000;

export async function verifyGatewayAssetTransport(rounds = 100): Promise<void> {
  const testRoot = path.resolve('.test-data/gateway-asset-transport');
  await mkdir(testRoot, { recursive: true });
  const staticDir = await mkdtemp(path.join(testRoot, 'run-'));
  // Larger than the HTTP stream buffer, representative of a login JS bundle.
  const asset = `export const payload = '${'0123456789abcdef'.repeat(32768)}';`;
  await writeFile(path.join(staticDir, 'main.js'), asset);
  const api = new ApiServer({
    port: 0, host: '127.0.0.1',
    authMiddleware: { process: async () => true } as unknown as AuthMiddleware,
  });
  registerStaticSpaRoutes(api, { prefix: '/settings', staticDir, entryFiles: ['main.js'], label: 'Asset transport test' });
  // Exercise both gateway branches: API static products and the CSS/default path.
  const css = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/javascript');
    response.end(asset);
  });
  let gateway: GatewayProxy | undefined;
  try {
    await api.start();
    await new Promise<void>((resolve) => css.listen(0, '127.0.0.1', resolve));
    const apiPort = (api.address() as AddressInfo).port;
    const cssPort = (css.address() as AddressInfo).port;
    const gatewayPort = await getFreePort(45000, '127.0.0.1');
    gateway = new GatewayProxy(gatewayPort, new Supervisor(), '127.0.0.1');
    gateway.setTargets({ api: `http://127.0.0.1:${apiPort}`, css: `http://127.0.0.1:${cssPort}` });
    await gateway.start();

    for (const [name, port, assetPath] of [
      ['direct-api', apiPort, '/settings/main.js'],
      ['gateway-api', gatewayPort, '/settings/main.js'],
      ['gateway-css', gatewayPort, '/app/assets/main.js'],
    ] as const) {
      for (let round = 0; round < rounds; round++) {
        // allSettled drains sibling clients even if one request times out.
        const results = await Promise.allSettled(Array.from({ length: 12 }, async (_, index) => {
          const response = await fetch(`http://127.0.0.1:${port}${assetPath}?round=${round}&asset=${index}`, {
            signal: AbortSignal.timeout(4_000),
          });
          assert.equal(response.status, 200, `${name}: HTTP status`);
          assert.equal(await response.text(), asset, `${name}: complete asset body`);
        }));
        for (const result of results) {
          if (result.status === 'rejected') {
            throw new Error(`${name} round ${round}: asset response did not complete: ${String(result.reason)}`);
          }
        }
      }
      process.stdout.write(`${name}: ${rounds * 12} complete responses\n`);
    }
  } finally {
    await gateway?.stop();
    await api.stop();
    if (css.listening) await new Promise<void>((resolve) => css.close(() => resolve()));
    await rm(staticDir, { recursive: true, force: true });
  }
}
