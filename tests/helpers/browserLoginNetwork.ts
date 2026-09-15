import { expect, type BrowserContext, type Page } from '@playwright/test';
import { fetchBrowserXpodPod, readBrowserXpodRuntime } from './browserXpodRuntime';

/** The document is already loaded; offline cold starts are a separate browser/platform contract. */
export async function verifyOfflinePodRecovery(
  page: Page,
  context: BrowserContext,
  resourcePath: string,
  expectedBody: string,
): Promise<void> {
  const identity = await readBrowserXpodRuntime(page);
  expect(identity.status).toBe('authenticated');
  expect(await fetchBrowserXpodPod(page, resourcePath)).toEqual({ status: 200, body: expectedBody });
  const sessionId = await page.evaluate(() => localStorage.getItem('solidClientAuthn:currentSession'));
  expect(sessionId).toBeTruthy();
  let authorizationCodeRequests = 0;
  const observe = (request: import('@playwright/test').Request) => {
    if (request.method() === 'POST'
      && new URLSearchParams(request.postData() ?? '').get('grant_type') === 'authorization_code') {
      authorizationCodeRequests += 1;
    }
  };
  page.on('request', observe);
  try {
    await context.setOffline(true);
    await expect(fetchBrowserXpodPod(page, resourcePath)).rejects.toThrow(/fetch|network|internet|offline/iu);
    expect(await readBrowserXpodRuntime(page)).toEqual(identity);
    expect(await page.evaluate(() => localStorage.getItem('solidClientAuthn:currentSession'))).toBe(sessionId);
    await context.setOffline(false);
    expect(await fetchBrowserXpodPod(page, resourcePath)).toEqual({ status: 200, body: expectedBody });
    expect(await readBrowserXpodRuntime(page)).toEqual(identity);
    expect(authorizationCodeRequests).toBe(0);
  } finally {
    await context.setOffline(false);
    page.off('request', observe);
  }
}

/** Exercise real browser network loss, preserving the product operation's failed Account step. */
export async function completeOfflineProductLogout(page: Page, context: BrowserContext): Promise<void> {
  await page.getByTestId('xpod-user-card-trigger').click();
  await context.setOffline(true);
  try {
    await page.getByRole('button', { name: 'Sign out', exact: true }).evaluate((button) => {
      (button as HTMLButtonElement).click();
    });
    await expect(page.getByText('退出未完成', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '重试退出', exact: true })).toBeEnabled();
    expect(await page.evaluate(() => localStorage.getItem('solidClientAuthn:currentSession'))).toBeNull();
    await context.setOffline(false);
    await page.getByRole('button', { name: '重试退出', exact: true }).click();
    await expect(page.getByText('退出未完成', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('xpod-user-card-trigger')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('solidClientAuthn:currentSession'))).toBeNull();
  } finally {
    await context.setOffline(false);
  }
}
