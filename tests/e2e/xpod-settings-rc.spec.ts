import { readFile } from 'node:fs/promises';
import { expect, type BrowserContext, type Page, test } from '@playwright/test';
import { startBrowserExternalRp } from '../helpers/browserExternalRp';
import { authorizeRcSession, readRcAccountBindings, verifyRcPrivateIsolation, type RcIdentity, type RcRp, type RcSession } from '../helpers/rcLightWeb';

const baseUrl = requiredEnv('XPOD_SETTINGS_E2E_BASE_URL');
const statePaths = [requiredEnv('XPOD_SETTINGS_E2E_ALICE_STATE'), requiredEnv('XPOD_SETTINGS_E2E_BOB_STATE')];
test.describe.configure({ mode: 'serial', timeout: 180_000 });

test.describe('deployed Xpod lightweight Web acceptance (no desktop bridge)', () => {
  const owners: Array<{ context: BrowserContext; page: Page; session: RcSession }> = [];
  let rp: RcRp | undefined;
  const closeOwned = async () => {
    const contexts = owners.splice(0);
    const ownedRp = rp;
    rp = undefined;
    try {
      const results = await Promise.allSettled(contexts.map(owner => owner.context.close()));
      if (results.some(result => result.status === 'rejected')) throw new Error('RC browser context cleanup failed');
    } finally { await ownedRp?.close(); }
  };
  test.beforeAll(async ({ browser }) => {
    try {
      rp = await startBrowserExternalRp(baseUrl);
      for (const statePath of statePaths) {
        const identity = JSON.parse(await readFile(`${statePath}.identity.json`, 'utf8')) as RcIdentity;
        const context = await browser.newContext({ storageState: statePath, viewport: { width: 1440, height: 900 } });
        try {
          const page = await context.newPage();
          // No password is provided on reuse. A fresh authorization transaction
          // must authenticate using the server Account Cookie from preparation.
          const session = await authorizeRcSession(page, rp, baseUrl);
          expect(session.identity).toEqual(identity);
          owners.push({ context, page, session });
        } catch (error) {
          await context.close();
          throw error;
        }
      }
    } catch (error) {
      await closeOwned();
      throw error;
    }
  });
  test.afterAll(closeOwned);

  test('restores independent Account Cookies, authenticates real OIDC owners, and enforces private Pod isolation', async () => {
    expect(owners).toHaveLength(2);
    await verifyRcPrivateIsolation(owners.map(owner => owner.session));
    for (const owner of owners) await assertLightAccount(owner.page, owner.session.identity);
  });

  for (const viewport of [{ name: 'wide', width: 1440, height: 900 }, { name: 'narrow', width: 390, height: 844 }]) {
    test(`keeps lightweight Account and desktop entry usable at ${viewport.name} width`, async ({}, testInfo) => {
      const { page, session } = owners[0];
      await page.setViewportSize(viewport);
      await assertLightAccount(page, session.identity);
      await page.screenshot({ path: testInfo.outputPath(`${viewport.name}-account.png`), fullPage: true });
      for (const route of ['/ai-connections', '/settings/pod', '/network', '/status/overview']) {
        const response = await page.goto(new URL(route, baseUrl).href, { waitUntil: 'domcontentloaded' });
        expect(response?.status()).toBe(200);
        await expect(page.getByRole('heading', { name: '在桌面 Xpod 中管理', exact: true })).toBeVisible();
        await expect(page.getByRole('link', { name: '下载桌面 Xpod', exact: true })).toHaveAttribute('href',
          'https://github.com/undefinedsco/xpod/releases/latest');
        const accountLink = page.getByRole('link', { name: '账号页面', exact: true });
        await expect(accountLink).toBeVisible();
        const accountUrl = new URL((await accountLink.getAttribute('href'))!, baseUrl);
        expect(accountUrl.origin).toBe(new URL(baseUrl).origin);
        expect(accountUrl.pathname).toMatch(/^\/\.account\/account\//u);
        await assertNoHeavyWorkspace(page);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`${viewport.name}-${route.replaceAll('/', '_')}.png`), fullPage: true });
      }
    });
  }
});

async function assertLightAccount(page: Page, identity: RcIdentity) {
  const response = await page.goto(new URL('/.account/account/', baseUrl).href, { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: /账号总览|Account (?:overview|dashboard)/iu })).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  const account = await readRcAccountBindings(page, baseUrl);
  expect(account.accountId).toBe(identity.accountId);
  expect(account.bindings).toContainEqual(expect.objectContaining({ webId: identity.webId, storageUrl: identity.storageUrl }));
  await assertNoHeavyWorkspace(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

async function assertNoHeavyWorkspace(page: Page) {
  expect(await page.evaluate(() => Boolean((globalThis as { xpodDesktop?: unknown }).xpodDesktop))).toBe(false);
  await expect(page.locator('[data-testid="ai-connections-panel"], [data-workspace-layout], [data-testid="workspace-list-pane"]')).toHaveCount(0);
}
function requiredEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`${key} is required for deployed RC browser acceptance`);
  return value;
}
