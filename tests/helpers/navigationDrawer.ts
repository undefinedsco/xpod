import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Open the host navigation drawer that owns the workspace list at 390 (design §2.7)
 * and return its toggle so callers can assert the focus the host restores on close.
 */
export async function openNavigationDrawer(page: Page): Promise<Locator> {
  const toggle = page.getByRole('button', { name: '打开导航' });
  await expect(toggle).toBeVisible({ timeout: 45_000 });
  await toggle.click();
  await expect(page.locator('[data-drawer-open="true"]')).toBeVisible({ timeout: 45_000 });
  return toggle;
}
