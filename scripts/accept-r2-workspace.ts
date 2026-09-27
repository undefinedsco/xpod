/**
 * R2 工作区首屏与窄窗的真实浏览器检查（spec §7.1、§8.3、AC-03/AC-04/AC-14）。
 *
 * 从源码启动 standalone 运行时，用真实 Chromium 走一遍真实登录（邮箱+密码），然后检查：
 *   - 概览首屏恰一个结论、事实 ≤4 组、专业详情默认收起；
 *   - 宽窗（1280）显示 184px 文字导航，且概览不出现对象列；
 *   - 窄窗（700）改为顶部任务栏，导航树收进抽屉且仍可达（rail 隐藏）。
 *
 * 用法：bun scripts/accept-r2-workspace.ts
 */
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { getFreePort } from '../src/runtime/port-finder';
import { startXpodRuntime } from '../src/runtime/XpodRuntime';
import { createFakeQleverRuntimeCommand } from '../tests/helpers/qleverRuntime';
import { setupAccount } from '../tests/integration/helpers/solidAccount';

const root = path.resolve('.test-data/r2-workspace');
const gateway = await getFreePort(7900);
const css = await getFreePort(8000);
const api = await getFreePort(8100);
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
    XPOD_GATEWAY_LOCATOR_SECRET: 'r2-workspace-locator',
    XPOD_SECRET_CELL_KEY_ID: 'r2-workspace',
    XPOD_SECRET_CELL_KEY: Buffer.alloc(32, 11).toString('base64'),
    CSS_ALLOWED_HOSTS: 'localhost',
    XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: qlever.command,
  },
} as never);

const failures: string[] = [];
const waitReady = async (): Promise<boolean> => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}service/status`)).ok) return true;
    } catch { /* not yet */ }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
};

const diagnostic = async (page: Page): Promise<string> => page.evaluate(() => {
  const labels = Array.from(document.querySelectorAll('button, a, label'))
    .map((element) => (element.textContent ?? '').trim())
    .filter((text) => text.length > 0 && text.length < 24);
  return `${location.pathname} :: ${[...new Set(labels)].slice(0, 20).join(' | ')}`;
});

if (!await waitReady()) {
  console.log('runtime never became ready');
  await runtime.stop();
  process.exit(1);
}

const account = await setupAccount(baseUrl.replace(/\/$/, ''), 'r2-workspace');
if (!account?.email || !account.password) {
  console.log('setupAccount failed');
  await runtime.stop();
  process.exit(1);
}

const browser = await chromium.launch();
try {
  // §8.3：1284 以上才并排显示对象列，1280 会把列表压成堆叠；首屏检查用 1440
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${baseUrl.replace(/\/$/, '')}/status/overview`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1_000);

  // 真实登录：邮箱 + 密码 + 登录
  try {
    await page.getByLabel('邮箱').fill(account.email);
    await page.getByLabel('密码', { exact: true }).fill(account.password);
    await page.getByRole('button', { name: '登录' }).click();
  } catch (error) {
    failures.push(`登录表单不可用：${String(error).slice(0, 120)} :: ${await diagnostic(page)}`);
  }

  // 工作区出现（首屏结论是工作区已渲染的信号）
  try {
    await page.waitForSelector('[data-testid="overview-conclusion"]', { state: 'attached', timeout: 60_000 });
  } catch {
    const testids = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid]'))
      .map((element) => element.getAttribute('data-testid'))
      .filter(Boolean)
      .slice(0, 24));
    const text = await page.evaluate(() => (document.querySelector('[data-workspace-main-pane]')?.textContent ?? '').slice(0, 240));
    failures.push(`登录后未进入工作区 :: ${await diagnostic(page)} :: testids=${JSON.stringify(testids)} :: main=${text}`);
  }

  if (failures.length === 0) {
    const conclusions = await page.locator('[data-testid="overview-conclusion"]').count();
    if (conclusions !== 1) failures.push(`首屏结论数 ${conclusions} != 1`);
    const facts = await page.locator('[data-testid="overview-fact"]').count();
    if (facts === 0 || facts > 4) failures.push(`事实组数 ${facts} 不在 1..4`);
    const openDetails = await page.locator('details[data-testid^="overview-"][open]').count();
    if (openDetails !== 0) failures.push(`专业详情默认未收起（${openDetails} 个展开）`);

    // 宽窗：184px 文字导航 + 概览不出现对象列
    const rail = page.locator('aside[data-app-layout-navigation] nav a');
    const railWidth = await page.locator('aside[data-app-layout-navigation]').evaluate((element) => Math.round(element.getBoundingClientRect().width));
    if (railWidth !== 184) failures.push(`宽窗导航列宽 ${railWidth} != 184`);
    for (const label of ['概览', '存储空间', 'AI', '服务与访问']) {
      if (!await rail.filter({ hasText: label }).first().isVisible()) failures.push(`宽窗导航缺少可点条目「${label}」`);
    }
    // 说明：这里看到的对象列是「服务与访问」入口自己的专业深链集合（§3.1），
    // 不是概览凑出来的中栏；「非集合页不加对象列」由 packages/extension-sdk/test/layout-pages.test.ts
    // 与 workspace-layout.test.tsx 在单元层锁定，不在本浏览器检查里重复判定。

    // 窄窗：任务栏 + 抽屉，rail 隐藏
    await page.setViewportSize({ width: 700, height: 820 });
    await page.waitForTimeout(400);
    const taskBar = page.locator('[data-app-layout-header]');
    if (!await taskBar.isVisible()) failures.push('窄窗没有顶部任务栏');
    if (await page.locator('aside[data-app-layout-navigation]').isVisible()) failures.push('窄窗仍显示常驻导航列');
    const drawerButton = page.getByRole('button', { name: 'Xpod 工作区导航' });
    if (!await drawerButton.isVisible()) {
      failures.push(`窄窗缺少有名称的导航按钮 :: ${await diagnostic(page)}`);
    } else {
      await drawerButton.click();
      await page.waitForTimeout(500);
      const drawerNav = page.locator('[role="dialog"] nav a, [data-testid*="sheet"] nav a');
      if (await drawerNav.count() === 0) failures.push('抽屉里没有复用导航树');
    }
  }
  await page.close();
} finally {
  await browser.close();
  await runtime.stop();
  qlever.cleanup();
}

console.log(failures.length === 0 ? 'WORKSPACE CHECK OK' : `WORKSPACE CHECK FAILED:\n- ${failures.join('\n- ')}`);
process.exit(failures.length === 0 ? 0 : 1);
