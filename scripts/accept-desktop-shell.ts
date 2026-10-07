/** Real isolated Standalone acceptance. Start the runtime separately and supply its URL.
 * No mocks, injected browser session or user credentials. All artifacts stay in .test-data.
 * bun scripts/accept-desktop-shell.ts http://localhost:57391/
 */
import '../src/runtime/configure-drizzle-solid';
import { drizzle } from '@undefineds.co/drizzle-solid';
import { approvalResource, decideApprovalRequest } from '@undefineds.co/models';
import { chromium, _electron as electron } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setupAccount, loginWithClientCredentials } from '../tests/integration/helpers/solidAccount';
import { completeOidcLogin } from '../tests/helpers/browserSolidOidc';
import { fetchBrowserXpodGateway, readBrowserXpodRuntime, readBrowserXpodAccount, readBrowserSessionAccountControls } from '../tests/helpers/browserXpodRuntime';
import { createTasksClient } from '../packages/tasks/src/client';

const baseUrl = process.argv[2];
if (!baseUrl || !['localhost', '127.0.0.1'].includes(new URL(baseUrl).hostname)) {
  throw new Error('Supply the isolated Standalone loopback URL');
}
const output = path.resolve('.test-data/desktop-shell-acceptance', process.env.XPOD_ACCEPT_RUN ?? '.');
mkdirSync(output, { recursive: true });
const report: Record<string, unknown> = { baseUrl, startedAt: new Date().toISOString(), runtime: false };
const save = () => writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
const status = await fetch(new URL('/service/status', baseUrl));
report.runtime = status.ok;
if (!status.ok) throw new Error(`Runtime health: ${status.status}`);
const account = process.env.XPOD_ACCEPT_ACCOUNT_FILE
  ? JSON.parse(readFileSync(process.env.XPOD_ACCEPT_ACCOUNT_FILE, 'utf8')) as NonNullable<Awaited<ReturnType<typeof setupAccount>>>
  : await setupAccount(baseUrl, 'acceptance-shell');
if (!account?.email || !account.password) throw new Error('Isolated account creation failed');
writeFileSync(path.join(output, 'account-private.json'), JSON.stringify(account), { mode: 0o600 });
report.webId = account.webId;
report.podUrl = account.podUrl;
const session = await loginWithClientCredentials(account);

try {
  const db = drizzle(session as never, { podUrl: account.podUrl, schema: { approval: approvalResource }, autoConnect: false, resourcePreparation: 'off' });
  const id = `${new Date().toISOString().slice(0, 10).replaceAll('-', '/')}.ttl#acceptance-${Date.now()}`;
  await db.insert(approvalResource).values({ id, session: `${account.podUrl}sessions/acceptance`, toolCallId: id,
    toolName: 'acceptance.read', target: account.podUrl, action: 'http://www.w3.org/ns/odrl/2/read',
    risk: 'low', status: 'pending', assignedTo: account.webId });
  const iri = approvalResource.buildIri(account.podUrl, { id });
  const secondSession = await loginWithClientCredentials(account);
  const clients = [session, secondSession];
  const results = await Promise.all((['approved', 'rejected'] as const).map((decision, index) => decideApprovalRequest({
    approval: iri, decision, decisionBy: account.webId, authenticatedFetch: clients[index].fetch,
  })));
  const stored = await db.findByIri(approvalResource, iri);
  const terminal = stored && ['approved', 'rejected'].includes(stored.status);
  await secondSession.logout();
  report.approval = { iri, results, persistedStatus: stored?.status, terminal, singleWinner: results.filter(result => result.status === 'decided').length === 1 };
} catch (error) { report.approval = { error: String(error) }; }
save();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors: string[] = [];
const taskResponses: unknown[] = [];
const authNetwork: unknown[] = [];
page.on('response', response => { const url = new URL(response.url()); if (url.pathname.startsWith('/.account') || url.pathname.startsWith('/api/tasks')) authNetwork.push({ path: url.pathname.split('/').map(segment => ['', '.account', 'account', 'session', 'login', 'password', 'oidc', 'consent', 'bindings', 'webid', 'pick-webid', 'pod', 'client-credentials', 'api', 'tasks'].includes(segment) ? segment : '<id>').join('/'), method: response.request().method(), status: response.status() }); });
page.on('response', response => {
  if (new URL(response.url()).pathname.startsWith('/api/tasks')) {
    void response.json().then(body => taskResponses.push({ method: response.request().method(), path: new URL(response.url()).pathname, status: response.status(), error: body.error })).catch(() => undefined);
  }
});
let consoleErrorCount = 0;
page.on('console', message => { if (message.type() === 'error') consoleErrorCount += 1; });
page.on('pageerror', error => errors.push(error.message));
try {
  report.oidc = await completeOidcLogin(page, { email: account.email, password: account.password, webId: account.webId, podUrl: account.podUrl }, {
    baseUrl, startUrl: new URL('/tasks', baseUrl).href, timeoutMs: 90000,
    ready: async current => { const state = await readBrowserXpodRuntime(current).catch(() => undefined); return state?.status === 'authenticated' && state.webId === account.webId && state.podUrl === account.podUrl; },
  });
  if (process.env.XPOD_ACCEPT_TASK_DELAY_MS) {
    report.taskDelayMs = Number(process.env.XPOD_ACCEPT_TASK_DELAY_MS);
    await page.waitForTimeout(Number(process.env.XPOD_ACCEPT_TASK_DELAY_MS));
  }
  try {
    const tasks = createTasksClient({ baseUrl, fetch: async (input, init) => {
      const url = new URL(String(input), baseUrl);
      const result = await fetchBrowserXpodGateway(page, account.webId, new URL(baseUrl).origin, `${url.pathname}${url.search}`, { method: init?.method, headers: init?.headers as Record<string, string> | undefined, body: init?.body as string | undefined });
      taskResponses.push({method:init?.method ?? 'GET', status:result.status, path:url.pathname});
      return new Response(result.body, { status: result.status });
    } });
    const { task } = await tasks.create({ kind: 'todo', prompt: '验收：检查桌面任务', workspace: account.podUrl, dueAt: Math.floor(Date.now() / 1000) + 86400 });
    const listed = await tasks.list();
    if (!listed.tasks.some(item => item.id === task.id)) throw new Error('Created todo not persisted');
    const completed = await tasks.update(task.id, { completed: true, notes: '隔离 Standalone 验收' });
    if (!completed.task.completedAt) throw new Error('Todo completion was not persisted');
    const reloaded = (await tasks.list()).tasks.find(item => item.id === task.id);
  if (!reloaded?.completedAt || reloaded.notes !== '隔离 Standalone 验收') throw new Error('Todo update readback disagrees');
  await tasks.update(task.id, { completed: false });
    report.todo = { createListUpdate: true, id: task.id };
  } catch (error) { report.todo = { error: String(error) }; }
  report.runtimeSnapshot = await readBrowserXpodRuntime(page);
  const accountSnapshot = await readBrowserXpodAccount(page, account.webId);
  report.accountSnapshot = { status: accountSnapshot.status, authority: accountSnapshot.authority, isAnonymous: accountSnapshot.isAnonymous, hasClientCredentialsControl: accountSnapshot.hasClientCredentialsControl, hasIdentityWebId: accountSnapshot.hasIdentityWebId, identityMatchesRuntime: accountSnapshot.identityMatchesRuntime };
  report.sessionAccountControls = await readBrowserSessionAccountControls(page);
  const captures: unknown[] = [];
  const enlargeText = () => page.evaluate(() => {
        const textElements = Array.from(document.body.querySelectorAll<HTMLElement>('*')).filter(element =>
          !element.hasAttribute('data-acceptance-font-size') && (element.matches('input, select, textarea') || Array.from(element.childNodes).some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())));
        const sizes = textElements.map(element => [element, Number.parseFloat(getComputedStyle(element).fontSize)] as const);
        for (const [element, size] of sizes) { element.dataset.acceptanceFontSize = element.style.fontSize; element.style.fontSize = `${size * 2}px`; }
      });
  for (const variant of (process.env.XPOD_ACCEPT_SKIP_CAPTURES === '1' ? [] : [{ width: 1280, theme: 'light', text: 100 }, { width: 390, theme: 'light', text: 100 }, { width: 1280, theme: 'dark', text: 100 }, { width: 390, theme: 'light', text: 200 }] as const)) {
    await page.setViewportSize({ width: variant.width, height: 800 });
    await page.emulateMedia({ colorScheme: variant.theme });
    for (const route of ['tasks', 'ai-connections', 'pod/models', 'pod/search', 'pod/apps', 'pod/data', 'device/network', 'device/services', 'device/runtime', 'device/logs', 'settings/appearance', 'inbox', 'notifications']) {
      // Exercise each React route with the authenticated session retained, as in sidebar navigation.
      await page.evaluate(pathname => {
        for (const element of document.querySelectorAll<HTMLElement>('[data-acceptance-font-size]')) {
          element.style.fontSize = element.dataset.acceptanceFontSize ?? '';
          delete element.dataset.acceptanceFontSize;
        }
        window.history.pushState(null, '', pathname);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, new URL(route, baseUrl).pathname);
      await page.waitForTimeout(800);
      await page.waitForFunction(() => !/正在(?:打开|读取)|加载中/.test(document.body.innerText), undefined, { timeout: 15000 }).catch(() => undefined);
      if (variant.text === 200) await enlargeText();
      const file = `${route.replaceAll('/', '-')}-${variant.width}-${variant.theme}-${variant.text}.png`;
      await page.screenshot({ path: path.join(output, file) });
      captures.push({ route, ...variant, file, measurement: await page.evaluate(() => ({
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
        loadingVisible: /正在(?:打开|读取)|加载中/.test(document.body.innerText),
        loadErrorVisible: /暂时无法读取 Pod 设置|Pod 设置暂时无法保存/.test(document.body.innerText),
        headings: Array.from(document.querySelectorAll('h1')).map(item => item.textContent),
        text: document.body.innerText.slice(0, 1800),
      })) });
      if (variant.width === 390 && route === 'tasks') {
        const navigation = page.getByRole('button', { name: '打开导航', exact: true });
        await navigation.click();
        await page.getByRole('dialog', { name: 'Xpod 导航', exact: true }).waitFor();
        await page.waitForFunction(() => !/正在(?:打开|读取)|加载中/.test(document.body.innerText), undefined, { timeout: 15000 }).catch(() => undefined);
        if (variant.text === 200) await enlargeText();
        const drawerLoadingVisible = await page.evaluate(() => /正在(?:打开|读取)|加载中/.test(document.body.innerText));
        await page.screenshot({ path: path.join(output, `tasks-drawer-${variant.width}-${variant.theme}-${variant.text}.png`) });
        await page.keyboard.press('Escape');
        captures.push({ route, ...variant, drawerLoadingVisible, drawerEscapeClosed: await navigation.getAttribute('aria-expanded') === 'false', focusRestored: await navigation.evaluate(element => element === document.activeElement) });
      }
    }
  }
  report.captures = captures;
} catch (error) { report.browserFailure = String(error); await page.screenshot({ path: path.join(output, 'browser-failure.png') }); }
finally { report.authNetwork = authNetwork; report.taskResponses = taskResponses; report.pageErrors = errors; report.consoleErrorCount = consoleErrorCount; save(); await browser.close(); }
if (process.env.XPOD_ACCEPT_ELECTRON === '1') {
  const app = await electron.launch({ executablePath: process.env.XPOD_ACCEPT_ELECTRON_EXECUTABLE, args: [path.resolve('desktop/dist/main.js')], env: {
    ...process.env, XPOD_DESKTOP_URL: new URL('/device/services', baseUrl).href,
    XPOD_DESKTOP_ACCEPTANCE: '1', XPOD_DESKTOP_ALLOW_PARALLEL_ACCEPTANCE: '1',
    XPOD_DESKTOP_USER_DATA_DIR: path.join(output, 'electron-profile'),
  } });
  try {
    const window = await app.firstWindow();
    await window.waitForTimeout(1500);
    await window.screenshot({ path: path.join(output, 'electron-services.png') });
    report.electron = { url: window.url(), text: await window.locator('body').innerText() };
  } finally { await app.close(); save(); }
}
await session.logout();
const todo = report.todo as { createListUpdate?: boolean } | undefined;
const approval = report.approval as { singleWinner?: boolean; terminal?: boolean } | undefined;
report.interactionPassed = todo?.createListUpdate === true && approval?.singleWinner === true && approval.terminal === true
  && !report.browserFailure && errors.length === 0;
const captures = report.captures as Array<{ measurement?: { horizontalOverflow: boolean; loadingVisible: boolean; loadErrorVisible: boolean }; drawerLoadingVisible?: boolean; drawerEscapeClosed?: boolean; focusRestored?: boolean }> | undefined;
report.captureChecksPassed = captures?.every(capture => capture.measurement
  ? !capture.measurement.horizontalOverflow && !capture.measurement.loadingVisible && !capture.measurement.loadErrorVisible
  : capture.drawerLoadingVisible === false && capture.drawerEscapeClosed === true && capture.focusRestored === true) ?? false;
report.ok = report.interactionPassed === true && report.captureChecksPassed === true;
save();
console.log(JSON.stringify({ report: path.join(output, 'report.json'), ok: report.ok, browserFailure: report.browserFailure, todo: report.todo }));
if (!report.ok) process.exitCode = 1;
