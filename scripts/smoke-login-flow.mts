/* eslint-disable no-console */
import { chromium } from '@playwright/test';

const base = 'http://localhost:3000';
const browser = await chromium.launch();
const page = await browser.newPage();

const logs = [];
page.on('console', (msg) => { if (msg.type() === 'error' || msg.type() === 'warning') logs.push(`[console:${msg.type()}] ${msg.text()}`); });
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));
page.on('requestfailed', (req) => logs.push(`[requestfailed] ${req.url()} :: ${req.failure()?.errorText}`));
page.on('response', (res) => { if (res.status() >= 400) logs.push(`[http ${res.status()}] ${res.url()}`); });

const dump = async (label) => {
  const text = (await page.locator('body').innerText()).replace(/\n{2,}/g, '\n').slice(0, 400);
  console.log(`=== ${label} @ ${page.url()} ===`);
  console.log(text);
};

await page.goto(`${base}/settings/models`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
await dump('login page');

await page.getByRole('button', { name: /登录/ }).first().click();
await page.waitForTimeout(5000);
await dump('after click');

// CSS account frontend: password login form
const emailInput = page.locator('input[type="email"], input[name="email"]').first();
if (await emailInput.count() > 0) {
  await emailInput.fill('alice@dev.local');
  await page.locator('input[type="password"], input[name="password"]').first().fill('alice123456');
  await page.locator('button[type="submit"], button:has-text("Log in"), button:has-text("登录")').first().click();
  await page.waitForTimeout(5000);
  await dump('after password');
}

// WebID pick step (ScopedPickWebIdHandler)
const webIdButton = page.locator('button:has-text("alice"), [role="radio"]:has-text("alice"), label:has-text("alice")').first();
if (await webIdButton.count() > 0) {
  await webIdButton.click().catch(() => undefined);
  const confirm = page.locator('button:has-text("Select"), button:has-text("Continue"), button:has-text("Confirm"), button[type="submit"]').first();
  if (await confirm.count() > 0) await confirm.click().catch(() => undefined);
  await page.waitForTimeout(4000);
  await dump('after webid pick');
}

// Consent step
const allow = page.locator('button:has-text("Allow"), button:has-text("Authorize"), button:has-text("Consent"), button:has-text("Yes"), button[type="submit"]').first();
if (await allow.count() > 0) {
  await allow.click().catch(() => undefined);
  await page.waitForTimeout(6000);
  await dump('after consent');
}

await page.screenshot({ path: '/tmp/xpod-login-flow.png', fullPage: true });
console.log('=== FINAL URL ===', page.url());
console.log('=== LOGS ===');
for (const line of logs.slice(0, 30)) console.log(line);

await browser.close();
