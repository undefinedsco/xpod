/**
 * R2 路由表的真实实例冒烟（spec §3.1/§3.3）。
 *
 * 在从源码启动的 standalone 运行时上逐一访问本轮的目标路径，记录 HTTP 状态与页面外壳标记。
 * 它证明这些路径在真实运行时可用；不替代浏览器走查（见
 * docs/superpowers/audits/2026-09-27-r2-walkthrough-checklist.md）。
 *
 * 用法：bun scripts/accept-r2-route-map.ts
 */
import path from 'node:path';
import { getFreePort } from '../src/runtime/port-finder';
import { startXpodRuntime } from '../src/runtime/XpodRuntime';
import { createFakeQleverRuntimeCommand } from '../tests/helpers/qleverRuntime';

const root = path.resolve('.test-data/r2-route-smoke');
const gateway = await getFreePort(7300);
const css = await getFreePort(7400);
const api = await getFreePort(7500);
const baseUrl = `http://localhost:${gateway}/`;
const qlever = createFakeQleverRuntimeCommand();

const runtime = await startXpodRuntime({
  mode: 'local',
  transport: 'port',
  gatewayPort: gateway,
  cssPort: css,
  apiPort: api,
  baseUrl,
  runtimeRoot: root,
  rootFilePath: path.join(root, 'data'),
  sparqlEndpoint: path.join(root, 'standalone.sqlite'),
  identityDbUrl: path.join(root, 'standalone-identity.sqlite'),
  logLevel: 'error',
  env: {
    SOLID_OIDC_ISSUER: baseUrl,
    XPOD_GATEWAY_LOCATOR_SECRET: 'r2-route-smoke-locator',
    XPOD_SECRET_CELL_KEY_ID: 'r2-route-smoke',
    XPOD_SECRET_CELL_KEY: Buffer.alloc(32, 7).toString('base64'),
    CSS_ALLOWED_HOSTS: 'localhost',
    XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: qlever.command,
  },
} as never);

const waitReady = async (): Promise<boolean> => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}service/status`)).ok) return true;
    } catch { /* not yet */ }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
};

if (!await waitReady()) {
  console.log('runtime never became ready');
  await runtime.stop();
  process.exit(1);
}

const paths = [
  '/status/overview',
  '/status/usage/overview',
  '/settings/pod',
  '/settings/runtime',
  '/ai-connections',
  '/network/overview',
  '/network/domain-dns',
];

const results: Array<{ path: string; status: number; shell: boolean }> = [];
for (const route of paths) {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}${route}`, { redirect: 'manual' });
  const body = await response.text();
  results.push({ path: route, status: response.status, shell: /<div id="root"|<script type="module"/u.test(body) });
}
for (const result of results) {
  console.log(`${result.status} ${result.path} shell=${result.shell}`);
}
const failures = results.filter((result) => result.status !== 200 || !result.shell);
console.log(failures.length === 0 ? 'ROUTE SMOKE OK' : `ROUTE SMOKE FAILED: ${JSON.stringify(failures)}`);

await runtime.stop();
qlever.cleanup();
process.exit(failures.length === 0 ? 0 : 1);
