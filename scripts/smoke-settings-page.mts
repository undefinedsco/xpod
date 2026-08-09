/* eslint-disable no-console */
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://localhost:3000/settings/models';
const waitMs = Number(process.argv[3] ?? 8000);

const browser = await chromium.launch();
const page = await browser.newPage();

const logs = [];
page.on('console', (msg) => logs.push(`[console:${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));
page.on('requestfailed', (req) => logs.push(`[requestfailed] ${req.url()} :: ${req.failure()?.errorText}`));
page.on('response', (res) => {
  if (res.status() >= 400) logs.push(`[http ${res.status()}] ${res.url()}`);
});

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(waitMs);

const bodyText = (await page.locator('body').innerText()).slice(0, 800);
const buttons = await page.locator('button').evaluateAll((els) =>
  els.map((el) => ({
    text: el.textContent?.trim().slice(0, 40),
    disabled: el.disabled,
    visible: el.checkVisibility?.() ?? true,
    pointerEvents: getComputedStyle(el).pointerEvents,
  })),
);

await page.screenshot({ path: '/tmp/xpod-settings-smoke.png', fullPage: true });

console.log('=== BODY TEXT ===');
console.log(bodyText);
console.log('=== BUTTONS ===');
console.log(JSON.stringify(buttons, null, 1));
console.log('=== LOGS ===');
for (const line of logs.slice(0, 40)) console.log(line);

await browser.close();
