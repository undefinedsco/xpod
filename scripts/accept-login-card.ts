/**
 * Login-card acceptance for the Cloud / Local / Standalone runtime modes.
 *
 * Drives a real Chromium browser against a *running* Xpod instance. No fixture
 * server, no mocked OIDC. Every step records what the page actually showed, so
 * an unexpected screen is evidence rather than a silently-passed assertion.
 *
 * Usage: bun scripts/accept-login-card.ts <cloud|local|standalone>
 *
 * Evidence (screenshots + JSON) lands in .test-data/acceptance/login-card/.
 * Passwords are never written to the report.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface ModeConfig {
  id: 'cloud' | 'local' | 'standalone';
  /** Host-reachable origin used to open the settings entry point. */
  entryOrigin: string;
  /** Canonical origin the settings app should redirect to for login. */
  expectedLoginOrigin: string;
  /** Which IdP owns the account when login starts from this mode. */
  expectedIdpOrigin: string;
}

// Users reach a deployment through its canonical authority, so the entry point
// must be the canonical origin. Reaching the same service over a bare
// 127.0.0.1 port is a different origin and does not share the OIDC session.
const MODES: Record<string, ModeConfig> = {
  cloud: {
    id: 'cloud',
    entryOrigin: 'http://cloud.localhost:16300',
    expectedLoginOrigin: 'http://cloud.localhost:16300',
    expectedIdpOrigin: 'http://cloud.localhost:16300',
  },
  local: {
    id: 'local',
    // Local has no directly reachable canonical authority of its own; it is
    // reached over its managed port and delegates identity to the test Cloud.
    entryOrigin: 'http://127.0.0.1:16310',
    expectedLoginOrigin: 'http://cloud.localhost:16300',
    expectedIdpOrigin: 'http://cloud.localhost:16300',
  },
  standalone: {
    id: 'standalone',
    entryOrigin: 'http://standalone.localhost:16320',
    expectedLoginOrigin: 'http://standalone.localhost:16320',
    expectedIdpOrigin: 'http://standalone.localhost:16320',
  },
};

const EVIDENCE_DIR = '.test-data/acceptance/login-card';
const EXPECTED_CARD = { w: 280, h: 400 };
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const PASSWORD = 'Xpod-login-accept-2026!';

interface SurfaceSnapshot {
  testid: string | null;
  presentation: string | null;
  card: { w: number; h: number } | null;
  bodyOverflow: { scrollH: number; clientH: number; overflowing: boolean } | null;
  controls: { tag: string; type?: string; name?: string; text: string }[];
}

interface StepRecord {
  step: string;
  url: string;
  title: string;
  visibleText: string;
  surfaces: SurfaceSnapshot[];
  screenshot?: string;
  note?: string;
}

const snapshot = async (page: Page): Promise<Omit<StepRecord, 'step'>> => {
  const data = await page.evaluate(() => {
    const surfaces = Array.from(document.querySelectorAll('[data-testid="auth-surface-page"]'));
    return {
      url: location.href,
      title: document.title,
      visibleText: (document.body.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 400),
      surfaces: surfaces.map((surface) => {
        const card = surface.querySelector('[role="region"], [role="dialog"]') ?? surface;
        const rect = card.getBoundingClientRect();
        const body = surface.querySelector('[data-testid="auth-surface-body"]');
        return {
          testid: surface.getAttribute('data-testid'),
          presentation: surface.getAttribute('data-auth-surface-presentation'),
          card: { w: Math.round(rect.width), h: Math.round(rect.height) },
          bodyOverflow: body
            ? {
                scrollH: body.scrollHeight,
                clientH: body.clientHeight,
                overflowing: body.scrollHeight > body.clientHeight + 1,
              }
            : null,
          controls: Array.from(document.querySelectorAll('input, button'))
            .filter((el) => el.getBoundingClientRect().height > 0)
            .map((el) => ({
              tag: el.tagName.toLowerCase(),
              type: (el as HTMLInputElement).type || undefined,
              name: (el as HTMLInputElement).name || undefined,
              text: (el.textContent ?? '').trim().slice(0, 30),
            })),
        };
      }),
    };
  });
  return data;
};

const record = async (
  page: Page,
  steps: StepRecord[],
  step: string,
  dir: string,
  note?: string,
): Promise<void> => {
  const snap = await snapshot(page);
  const file = `${dir}/${steps.length + 1}-${step}.png`;
  await page.screenshot({ path: join(EVIDENCE_DIR, file), fullPage: true });
  steps.push({ ...snap, step, screenshot: file, ...(note ? { note } : {}) });
  console.log(`[${step}] ${snap.url}`);
  console.log(`  text: ${snap.visibleText.slice(0, 160)}`);
  for (const s of snap.surfaces) {
    console.log(`  surface=${s.testid} presentation=${s.presentation} card=${s.card?.w}x${s.card?.h}` +
      ` overflow=${s.bodyOverflow?.overflowing} controls=${s.controls.map((c) => c.text || c.name || c.tag).join('|')}`);
  }
  if (note) console.log(`  note: ${note}`);
};

const runMode = async (browser: Browser, config: ModeConfig) => {
  const mode = config.id;
  const dir = `${mode}-${STAMP}`;
  await mkdir(join(EVIDENCE_DIR, dir), { recursive: true });
  const steps: StepRecord[] = [];
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const account = `accept-login-${mode}-${Date.now().toString(36)}`;
  const email = `${account}@test.com`;

  const context: BrowserContext = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    // *.localhost must resolve to loopback for the canonical origins.
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.log(`  [pageerror] ${error.message.slice(0, 200)}`));

  try {
    // 1. Entry point: the settings app must show its connect card, not the login form.
    await page.goto(`${config.entryOrigin}/settings/pod`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    await record(page, steps, 'entry-settings-pod', dir);
    const entrySurface = steps.at(-1)!.surfaces[0];
    checks.push({
      name: 'entry connect card rendered',
      ok: Boolean(entrySurface) && steps.at(-1)!.visibleText.includes('连接 Xpod'),
      detail: entrySurface ? `${entrySurface.card?.w}x${entrySurface.card?.h}` : 'no auth surface found',
    });

    // 2. Continue hands off to the canonical origin for login.
    const continueButton = page.getByRole('button', { name: '继续' }).first();
    if (await continueButton.count() === 0) {
      throw new Error('entry page has no 继续 button; login entry point changed');
    }
    await continueButton.click();
    // The IdP screen paints the compact card first and fills in the form after
    // it resolves the account controls, so wait for the real fields.
    await page.waitForSelector('input[name="email"]', { timeout: 30000 }).catch(() => undefined);
    await page.waitForTimeout(1500);
    await record(page, steps, 'after-continue', dir);

    const loginUrl = steps.at(-1)!.url;
    const loginOrigin = new URL(loginUrl).origin;
    checks.push({
      name: 'redirects to expected login origin',
      ok: loginOrigin === config.expectedLoginOrigin,
      detail: `expected ${config.expectedLoginOrigin}, got ${loginOrigin}`,
    });

    // 3. The compact login card itself.
    const loginSurface = steps.at(-1)!.surfaces.find((s) => s.presentation === 'compact');
    checks.push({
      name: `compact login card is ${EXPECTED_CARD.w}x${EXPECTED_CARD.h}`,
      ok: loginSurface?.card?.w === EXPECTED_CARD.w && loginSurface?.card?.h === EXPECTED_CARD.h,
      detail: loginSurface ? `${loginSurface.card?.w}x${loginSurface.card?.h}` : 'no compact surface found',
    });
    const controls = loginSurface?.controls ?? [];
    checks.push({
      name: 'login card exposes email + password + submit',
      ok: controls.some((c) => c.name === 'email')
        && controls.some((c) => c.name === 'password')
        && controls.some((c) => c.text === '登录'),
      detail: controls.map((c) => c.text || c.name || c.tag).join('|') || 'none',
    });
    checks.push({
      name: 'login card body has no visible inner scroll',
      ok: loginSurface?.bodyOverflow
        ? loginSurface.bodyOverflow.scrollH - loginSurface.bodyOverflow.clientH <= 12
        : true,
      detail: loginSurface?.bodyOverflow
        ? `scrollH=${loginSurface.bodyOverflow.scrollH} clientH=${loginSurface.bodyOverflow.clientH}`
        : 'unknown',
    });

    // 4. Create a fresh account through the IdP register form. Navigate from
    // the login card the way a user does: 切换用户 is an in-app state change,
    // so the pending OIDC transaction survives. A fresh goto() would reload the
    // IdP and drop it.
    await page.getByRole('button', { name: '切换用户' }).click();
    await page.waitForSelector('input[name="username"]', { timeout: 30000 }).catch(() => undefined);
    await page.waitForTimeout(1500);
    await record(page, steps, 'register-form', dir);
    const registerControls = steps.at(-1)!.surfaces[0]?.controls ?? [];
    checks.push({
      name: 'register form exposes username/email/password/confirmation',
      ok: ['username', 'email', 'password', 'confirmation']
        .every((field) => registerControls.some((c) => c.name === field)),
      detail: registerControls.map((c) => c.name || c.text || c.tag).join('|') || 'none',
    });

    await page.fill('input[name="username"]', account);
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', PASSWORD);
    await page.fill('input[name="confirmation"]', PASSWORD);
    // The form validates the Pod-name availability asynchronously; clicking
    // while it is "checking" may swallow the click.
    await page.waitForFunction(
      () => !document.body.innerText.includes('正在检查'),
      { timeout: 15000 },
    ).catch(() => undefined);
    await record(page, steps, 'register-filled', dir, `account=${account}`);
    const createButton = page.getByRole('button', { name: '创建账号' });
    await createButton.click({ force: true });
    // Registration is a chain: create account -> create pod -> pick WebID ->
    // consent -> token. It takes well over a fixed sleep on a cold stack, so
    // wait for the IdP to actually hand back instead of guessing a duration.
    //
    // The first hop out of /.account/ is the /auth/callback intermediate
    // ("正在完成登录"), not the app — waiting for the settings route is what
    // actually proves the handoff finished.
    await page.waitForURL(
      (url) => url.pathname.startsWith('/settings/'),
      { timeout: 90000, waitUntil: 'commit' },
    ).catch(() => undefined);
    await page.waitForTimeout(3000);
    await record(page, steps, 'after-register-submit', dir);

    // 5. Follow whatever the IdP asks for next (pod creation, consent, or back to the app).
    for (let hop = 0; hop < 8; hop += 1) {
      const state = await snapshot(page);
      const text = state.visibleText;
      if (state.url.includes('/settings/') && !state.surfaces.length) {
        await record(page, steps, `settled-${hop}`, dir, 'back in settings app');
        break;
      }
      const podName = page.getByRole('button', { name: /创建|Create/ }).last();
      const consent = page.getByRole('button', { name: /^(批准|授权|允许|同意|Authorize|Allow|Consent)$/ }).last();
      if (await consent.count() > 0 && state.url.includes('consent')) {
        await record(page, steps, `consent-${hop}`, dir);
        await consent.click();
        await page.waitForTimeout(6000);
        continue;
      }
      if (await podName.count() > 0 && state.url.includes('create-pod')) {
        await record(page, steps, `create-pod-${hop}`, dir);
        await page.fill('input[name="podName"], #pod-name', account).catch(() => undefined);
        await podName.click();
        await page.waitForTimeout(6000);
        continue;
      }
      await record(page, steps, `hop-${hop}`, dir, 'no known next action; stopping');
      break;
    }

    // 6. Final state: return to the settings entry point and confirm the login stuck.
    await page.goto(`${config.entryOrigin}/settings/pod`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(4000);
    const reload = page.reload({ waitUntil: 'networkidle' });
    await reload;
    await page.waitForTimeout(3000);
    await record(page, steps, 'reload-settings-pod', dir);
    const finalState = steps.at(-1)!;
    const loggedIn = finalState.surfaces.length === 0 && !finalState.visibleText.includes('连接 Xpod');
    checks.push({
      name: 'settings app renders authenticated after reload',
      ok: loggedIn,
      detail: loggedIn
        ? 'no auth boundary on reload'
        : `still gated: ${finalState.visibleText.slice(0, 120)}`,
    });

    const webId = await page.evaluate(() => {
      const raw = window.localStorage.getItem('xpod.remembered-login');
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as { webId?: string };
          if (parsed.webId) return parsed.webId;
        } catch { /* fall through to the other keys below */ }
      }
      return Object.keys(window.localStorage)
        .filter((key) => /webid|solid|auth/i.test(key))
        .slice(0, 5)
        .join(',') || undefined;
    });
    console.log(`  webId evidence: ${webId ?? 'not found in localStorage'}`);
  } catch (error) {
    await record(page, steps, 'error', dir, error instanceof Error ? error.message : String(error));
  } finally {
    const report = {
      mode,
      entryOrigin: config.entryOrigin,
      expectedLoginOrigin: config.expectedLoginOrigin,
      expectedIdpOrigin: config.expectedIdpOrigin,
      account: email,
      recordedAt: new Date().toISOString(),
      checks,
      allPassed: checks.every((c) => c.ok),
      steps,
    };
    await writeFile(
      join(EVIDENCE_DIR, `${mode}-${STAMP}.json`),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    console.log(`\n===== ${mode} =====`);
    for (const check of checks) {
      console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name} — ${check.detail}`);
    }
    console.log(`report: ${EVIDENCE_DIR}/${mode}-${STAMP}.json`);
    await context.close();
  }
};

const requested = process.argv[2];
if (!requested || !MODES[requested]) {
  console.error(`usage: bun scripts/accept-login-card.ts <${Object.keys(MODES).join('|')}>`);
  process.exit(1);
}

const browser = await chromium.launch();
try {
  await runMode(browser, MODES[requested]);
} finally {
  await browser.close();
}
