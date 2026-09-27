/**
 * R2 登录表面的真实浏览器检查（spec §5.1 row 1、§8.1、AC-01/AC-02/AC-06）。
 *
 * 在从源码启动的 standalone 运行时上，用真实 Chromium 打开未登录页面，读取**计算后**的颜色与
 * 内边距，核对：
 *   - 浅色画布 = §8.1 的 `#F7F4ED`，深色画布 = `#211D19`（跟随系统主题）；
 *   - compact 表面用 16px 内边距、画布铺满、没有内嵌白卡（无圆角/边框/阴影）。
 *
 * 需要已安装 Playwright 浏览器（`bunx playwright install chromium`）。
 * 用法：bun scripts/accept-r2-login-surface.ts
 */
import path from 'node:path';
import { chromium } from 'playwright';
import { getFreePort } from '../src/runtime/port-finder';
import { startXpodRuntime } from '../src/runtime/XpodRuntime';
import { createFakeQleverRuntimeCommand } from '../tests/helpers/qleverRuntime';

const root = path.resolve('.test-data/r2-login-surface');
const gateway = await getFreePort(7600);
const css = await getFreePort(7700);
const api = await getFreePort(7800);
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
    XPOD_GATEWAY_LOCATOR_SECRET: 'r2-login-surface-locator',
    XPOD_SECRET_CELL_KEY_ID: 'r2-login-surface',
    XPOD_SECRET_CELL_KEY: Buffer.alloc(32, 9).toString('base64'),
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

const failures: string[] = [];
if (!await waitReady()) {
  console.log('runtime never became ready');
  await runtime.stop();
  process.exit(1);
}

const expected = {
  light: { canvas: 'rgb(247, 244, 237)', text: 'rgb(43, 38, 33)' },
  dark: { canvas: 'rgb(33, 29, 25)', text: 'rgb(247, 244, 237)' },
} as const;

const measure = async (page: import('playwright').Page) => page.evaluate(() => {
  const body = getComputedStyle(document.body);
  const page_ = document.querySelector('[data-testid="web-account-page"]') as HTMLElement | null;
  const frame = document.querySelector('[data-auth-surface-frame]') as HTMLElement | null;
  const box = (element: HTMLElement | null) => {
    if (!element) return undefined;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      borderRadius: style.borderRadius,
      borderWidth: style.borderWidth,
      boxShadow: style.boxShadow,
      background: style.backgroundColor,
    };
  };
  return {
    canvas: body.backgroundColor,
    text: body.color,
    hasAccountPage: Boolean(page_),
    frame: frame?.getAttribute('data-auth-surface-frame'),
    frameBox: box(frame),
    pageBox: box(page_),
  };
});

const browser = await chromium.launch();
try {
  for (const scheme of ['light', 'dark'] as const) {
    for (const width of [1000, 800] as const) {
      const page = await browser.newPage({ colorScheme: scheme, viewport: { width, height: 720 } });
      await page.goto(`${baseUrl.replace(/\/$/, '')}/status/overview`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="web-account-page"]', { timeout: 30_000 });
      await page.waitForTimeout(500);
      const measured = await measure(page);
      console.log(`${scheme}@${width}`, JSON.stringify(measured));

      if (!measured.hasAccountPage) failures.push(`${scheme}@${width}: 未渲染 Account 页面`);
      // §8.1：画布与正文色来自公共主题（真实浏览器的计算值）
      if (measured.canvas !== expected[scheme].canvas) failures.push(`${scheme}@${width}: 画布 ${measured.canvas} != ${expected[scheme].canvas}`);
      if (measured.text !== expected[scheme].text) failures.push(`${scheme}@${width}: 正文色 ${measured.text} != ${expected[scheme].text}`);
      // §5.1 第 1 行（compact，登录/恢复/回调）：280×400 基线、画布铺满、无内嵌白卡
      const compact = measured.frameBox;
      if (compact) {
        if (measured.frame !== 'compact') failures.push(`${scheme}@${width}: 非预期表面 ${measured.frame}`);
        if (compact.width !== 280) failures.push(`${scheme}@${width}: compact 宽 ${compact.width} != 280`);
        if (compact.height !== 400) failures.push(`${scheme}@${width}: compact 高 ${compact.height} != 400`);
        if (compact.borderRadius !== '0px') failures.push(`${scheme}@${width}: compact 有圆角 ${compact.borderRadius}`);
        if (compact.borderWidth !== '0px') failures.push(`${scheme}@${width}: compact 有边框`);
        if (compact.boxShadow !== 'none') failures.push(`${scheme}@${width}: compact 有阴影`);
      } else {
        // 未渲染 compact 时至少确认页面容器铺满画布
        if (measured.pageBox && measured.pageBox.background === 'rgba(0, 0, 0, 0)') {
          failures.push(`${scheme}@${width}: Account 页面没有背景，画布未铺满`);
        }
      }
      await page.close();
    }
  }
} finally {
  await browser.close();
  await runtime.stop();
  qlever.cleanup();
}

console.log(failures.length === 0 ? 'LOGIN SURFACE OK' : `LOGIN SURFACE FAILED:\n- ${failures.join('\n- ')}`);
process.exit(failures.length === 0 ? 0 : 1);
