import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { NgrokTunnelProvider } from '../src/tunnel/NgrokTunnelProvider';
import { startXpodRuntime, type XpodRuntimeHandle } from '../src/runtime/XpodRuntime';

interface CliOptions {
  dryRun: boolean;
  headed: boolean;
  localOnly: boolean;
  ngrokUrl?: string;
  ngrokAuthtoken?: string;
  ngrokBin?: string;
  timeoutMs: number;
}

interface FetchProbe {
  ok: boolean;
  status: number;
  body: string;
  attempts: number;
}

interface PasswordAccount {
  email: string;
  password: string;
  webId: string;
  podUrl: string;
  podName: string;
}

interface OidcObservations {
  authCodeChallenge: boolean;
  authCodeChallengeMethodS256: boolean;
  redirectCode: boolean;
  tokenGrantAuthorizationCode: boolean;
  tokenCodeVerifier: boolean;
  tokenRequestUrl?: string;
}

const STORAGE_PATH = '.data/inrupt-smoke/probe.ttl#this';

const PROVES = [
  'Inrupt browser SDK starts an authorization-code redirect flow with PKCE code_challenge.',
  'The browser receives an authorization code redirect back to /app/inrupt-smoke.html.',
  'The Inrupt SDK exchanges the code at the token endpoint with grant_type=authorization_code and code_verifier.',
  'session.info.isLoggedIn is true after handleIncomingRedirect.',
  'session.fetch can read the WebID profile and drizzle-solid can write/read/delete a Pod RDF resource.',
];

const CAVEATS = [
  'This smoke verifies formal Inrupt OIDC redirect/PKCE in a real Chromium browser context.',
  'It can run against a local loopback origin, or against an ngrok endpoint used as the temporary same-origin Solid issuer and SP base URL.',
  'For free ngrok dev domains, browser requests send ngrok-skip-browser-warning to bypass the ngrok interstitial warning page.',
  'It does not use the client credentials shortcut for browser login.',
  'It does not prove canonical node-*.undefineds.co browser routing unless the tunnel provider serves that canonical Host/SNI.',
];

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.dryRun) {
    const localSteps = [
      'start local xpod runtime with a loopback CSS_BASE_URL',
      'create a test account, password login, and pod through the loopback origin',
      'open /app/inrupt-smoke.html in Chromium',
      'click the Inrupt login button',
      'submit the CSS password login form in the redirected OIDC flow',
      'observe PKCE code_challenge, authorization code redirect, and token code_verifier exchange',
      'run Inrupt session discovery and drizzle-solid Pod read/write/delete from the browser',
    ];
    const ngrokSteps = [
      'start local xpod runtime with ngrok endpoint as CSS_BASE_URL',
      'start ngrok tunnel to local xpod gateway',
      'create a test account, password login, and pod through the public endpoint',
      ...localSteps.slice(2),
    ];
    writeJson({
      kind: 'ngrok-inrupt-oidc-smoke',
      dryRun: true,
      endpoint: options.localOnly ? 'auto-local-loopback-origin' : normalizeEndpoint(options.ngrokUrl) ?? 'auto-discover-from-ngrok-agent',
      browser: 'chromium',
      steps: options.localOnly ? localSteps : ngrokSteps,
      proves: PROVES,
      caveats: options.localOnly ? [...CAVEATS, 'Local-only mode proves OIDC/PKCE on loopback, not public tunnel reachability.'] : CAVEATS,
    });
    return;
  }

  let endpoint = options.localOnly ? '' : await resolveEndpoint(options);
  let runtime: XpodRuntimeHandle | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let provider: NgrokTunnelProvider | undefined;

  const result: Record<string, unknown> = {
    kind: 'ngrok-inrupt-oidc-smoke',
    dryRun: false,
    endpoint: options.localOnly ? 'pending-local-loopback-origin' : endpoint,
    mode: options.localOnly ? 'local-only' : 'ngrok',
    stages: [],
    proves: PROVES,
    caveats: options.localOnly ? [...CAVEATS, 'Local-only mode proves OIDC/PKCE on loopback, not public tunnel reachability.'] : CAVEATS,
  };

  try {
    if (options.localOnly) {
      runtime = await startXpodRuntime({
        mode: 'local',
        transport: 'port',
        bindHost: 'localhost',
        open: false,
        apiOpen: false,
        env: {
          CSS_LOGGING_LEVEL: 'warn',
          CSS_REDIS_CLIENT: undefined,
          CSS_REDIS_USERNAME: undefined,
          CSS_REDIS_PASSWORD: undefined,
        },
      });
      endpoint = runtime.baseUrl;
      result.endpoint = endpoint;
    } else {
      const endpointHost = new URL(endpoint).host;
      runtime = await startXpodRuntime({
        mode: 'local',
        transport: 'port',
        open: false,
        apiOpen: false,
        baseUrl: endpoint,
        env: {
          CSS_ALLOWED_HOSTS: `${endpointHost},localhost,127.0.0.1`,
          CSS_LOGGING_LEVEL: 'warn',
          CSS_REDIS_CLIENT: undefined,
          CSS_REDIS_USERNAME: undefined,
          CSS_REDIS_PASSWORD: undefined,
        },
      });
    }

    const localPort = runtime.ports.gateway;
    if (!localPort) {
      throw new Error('xpod gateway port was not allocated');
    }

    const localGateway = options.localOnly ? endpoint : `http://127.0.0.1:${localPort}/`;
    await fetchUntilOk(new URL('/service/status', localGateway).toString(), options.timeoutMs);
    pushStage(result, 'xpod-started');
    result.localGateway = localGateway;
    result.localPort = localPort;

    if (!options.localOnly) {
      provider = new NgrokTunnelProvider({
        authtoken: options.ngrokAuthtoken,
        url: endpoint,
        ngrokPath: options.ngrokBin,
        connectTimeoutMs: options.timeoutMs,
      });
      const tunnelConfig = await provider.setup({
        subdomain: 'ngrok-inrupt-oidc-smoke',
        localPort,
        localProtocol: 'http',
      });
      await provider.start(tunnelConfig);
      pushStage(result, 'ngrok-started');
      result.tunnelStatus = provider.getStatus();

      const actualEndpoint = provider.getEndpoint();
      if (actualEndpoint && actualEndpoint !== endpoint) {
        throw new Error(`ngrok endpoint changed: expected ${endpoint}, got ${actualEndpoint}`);
      }
    }

    const statusUrl = new URL('/service/status', endpoint).toString();
    const statusProbe = await fetchUntilOk(statusUrl, options.timeoutMs, {
      headers: { Accept: 'application/json', 'ngrok-skip-browser-warning': 'true' },
    });
    result.statusCheck = {
      url: statusUrl,
      status: statusProbe.status,
      attempts: statusProbe.attempts,
      bodyPreview: statusProbe.body.slice(0, 200),
    };
    if (!statusProbe.ok) {
      throw new Error(`status endpoint failed: ${statusProbe.status} ${statusProbe.body.slice(0, 200)}`);
    }
    pushStage(result, options.localOnly ? 'loopback-status-ok' : 'public-status-ok');

    const account = await createPasswordAccount(endpoint);
    result.account = {
      email: account.email,
      webId: account.webId,
      podUrl: account.podUrl,
      podName: account.podName,
    };
    pushStage(result, 'account-password-pod-created');

    browser = await chromium.launch({ headless: !options.headed });
    context = await browser.newContext({
      extraHTTPHeaders: {
        'ngrok-skip-browser-warning': 'true',
      },
    });
    await context.route('**/*', async(route) => {
      await route.continue({
        headers: {
          ...route.request().headers(),
          'ngrok-skip-browser-warning': 'true',
        },
      });
    });

    const page = await context.newPage();
    const observations = observeOidc(page);
    const verifierUrl = buildVerifierUrl(endpoint);
    result.verifierUrl = verifierUrl;

    await page.goto(verifierUrl, {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs,
    });
    pushStage(result, 'browser-opened-inrupt-verifier');

    await page.getByRole('button', { name: /login cloud/i }).click({ timeout: options.timeoutMs });
    pushStage(result, 'inrupt-login-clicked');

    await completeOidcLogin(page, account, endpoint, options.timeoutMs);
    pushStage(result, 'oidc-login-form-submitted');

    await waitForLoggedIn(page, options.timeoutMs);
    pushStage(result, 'inrupt-session-logged-in');

    if (!observations.authCodeChallenge || !observations.authCodeChallengeMethodS256) {
      throw new Error(`PKCE authorization request was not observed: ${JSON.stringify(observations)}`);
    }
    if (!observations.redirectCode) {
      throw new Error(`authorization code redirect was not observed: ${JSON.stringify(observations)}`);
    }
    if (!observations.tokenGrantAuthorizationCode || !observations.tokenCodeVerifier) {
      throw new Error(`PKCE token exchange was not observed: ${JSON.stringify(observations)}`);
    }
    result.oidc = observations;
    pushStage(result, 'pkce-observed');

    await clickAndWaitForReport(page, /check cloud discovery/i, (report) => Boolean(report.discovery?.ok), options.timeoutMs);
    pushStage(result, 'session-fetch-discovery-ok');

    const storageReport = await clickAndWaitForReport(page, /discover storage home/i, (report) => {
      return typeof report.storage?.storageUrl === 'string' && report.storage.storageUrl.length > 0;
    }, options.timeoutMs);
    pushStage(result, 'webid-storage-discovered');

    const drizzleReport = await clickAndWaitForReport(page, /drizzle read\/write\/delete/i, (report) => {
      return report.drizzleSolid?.ok === true;
    }, options.timeoutMs);
    pushStage(result, 'drizzle-solid-readwrite-ok');

    result.browser = {
      session: drizzleReport.session,
      storage: storageReport.storage,
      drizzleSolid: drizzleReport.drizzleSolid,
    };
    result.smokeOk = true;
  } catch (error) {
    result.smokeOk = false;
    result.error = error instanceof Error ? error.message : String(error);
    if (context) {
      result.browserUrl = context.pages()[0]?.url();
    }
    process.exitCode = 1;
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await provider?.stop().catch(() => undefined);
    await runtime?.stop().catch(() => undefined);
  }

  writeJson(result);
}

function parseArgs(args: string[]): CliOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      continue;
    }
    const key = arg.slice(2);
    if (key === 'dry-run' || key === 'headed' || key === 'local-only') {
      flags.add(key);
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    values.set(key, value);
    index += 1;
  }

  return {
    dryRun: flags.has('dry-run'),
    headed: flags.has('headed'),
    localOnly: flags.has('local-only'),
    ngrokUrl: values.get('ngrok-url') ?? process.env.NGROK_URL,
    ngrokAuthtoken: values.get('ngrok-authtoken') ?? process.env.NGROK_AUTHTOKEN,
    ngrokBin: values.get('ngrok-bin') ?? process.env.NGROK_BIN,
    timeoutMs: readPositiveInt(values.get('timeout-ms')) ?? 60_000,
  };
}

async function resolveEndpoint(options: CliOptions): Promise<string> {
  const configured = normalizeEndpoint(options.ngrokUrl);
  if (configured) {
    return configured;
  }

  const provider = new NgrokTunnelProvider({
    authtoken: options.ngrokAuthtoken,
    ngrokPath: options.ngrokBin,
    connectTimeoutMs: options.timeoutMs,
  });
  const probeServer = await startProbeServer();

  try {
    const config = await provider.setup({
      subdomain: 'ngrok-inrupt-oidc-discover',
      localPort: probeServer.port,
      localProtocol: 'http',
    });
    await provider.start(config);
    const endpoint = normalizeEndpoint(provider.getEndpoint());
    if (!endpoint) {
      throw new Error('ngrok did not expose an endpoint');
    }
    return endpoint;
  } finally {
    await provider?.stop().catch(() => undefined);
    await closeServer(probeServer.server).catch(() => undefined);
  }
}

function buildVerifierUrl(endpoint: string): string {
  const url = new URL('/app/inrupt-smoke.html', endpoint);
  url.searchParams.set('issuer', endpoint);
  url.searchParams.set('storagePath', STORAGE_PATH);
  return url.toString();
}

function observeOidc(page: Page): OidcObservations {
  const observations: OidcObservations = {
    authCodeChallenge: false,
    authCodeChallengeMethodS256: false,
    redirectCode: false,
    tokenGrantAuthorizationCode: false,
    tokenCodeVerifier: false,
  };

  page.on('request', (request) => {
    try {
      const url = new URL(request.url());
      if (url.searchParams.has('code_challenge')) {
        observations.authCodeChallenge = true;
        observations.authCodeChallengeMethodS256 = url.searchParams.get('code_challenge_method') === 'S256';
      }
      if (url.pathname.endsWith('/.oidc/token') || url.pathname.includes('/.oidc/token')) {
        observations.tokenRequestUrl = url.toString();
        const body = request.postData() ?? '';
        const params = new URLSearchParams(body);
        observations.tokenGrantAuthorizationCode = params.get('grant_type') === 'authorization_code'
          || body.includes('grant_type=authorization_code');
        observations.tokenCodeVerifier = params.has('code_verifier') || body.includes('code_verifier=');
      }
    } catch {
      // Ignore non-URL request entries.
    }
  });

  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) {
      return;
    }
    try {
      const url = new URL(frame.url());
      if (url.pathname === '/app/inrupt-smoke.html' && url.searchParams.has('code')) {
        observations.redirectCode = true;
      }
    } catch {
      // Ignore transient browser URLs.
    }
  });

  return observations;
}

async function completeOidcLogin(
  page: Page,
  account: PasswordAccount,
  endpoint: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let submittedPassword = false;

  while (Date.now() < deadline) {
    if (isVerifierUrl(page.url(), endpoint)) {
      const loggedIn = await page.locator('#loggedIn').textContent({ timeout: 500 }).catch(() => '');
      if (loggedIn?.trim() === 'true') {
        return;
      }
    }

    const emailInput = page.locator('input[name="email"], input[type="email"], input#email').first();
    const passwordInput = page.locator('input[name="password"], input[type="password"], input#password').first();
    if (await emailInput.isVisible({ timeout: 500 }).catch(() => false)
      && await passwordInput.isVisible({ timeout: 500 }).catch(() => false)) {
      await emailInput.fill(account.email);
      await passwordInput.fill(account.password);
      await Promise.allSettled([
        page.waitForLoadState('domcontentloaded', { timeout: 5_000 }),
        passwordInput.press('Enter'),
      ]);
      submittedPassword = true;
      await page.waitForTimeout(500);
      continue;
    }

    const action = page.getByRole('button', {
      name: /authorize|allow|approve|consent|continue|submit|yes|log in|login|授权|允许|继续/i,
    }).first();
    if (await action.isVisible({ timeout: 500 }).catch(() => false)) {
      await Promise.allSettled([
        page.waitForLoadState('domcontentloaded', { timeout: 5_000 }),
        action.click(),
      ]);
      await page.waitForTimeout(500);
      continue;
    }

    await page.waitForTimeout(500);
  }

  throw new Error(`OIDC login did not finish before timeout; submittedPassword=${submittedPassword}; currentUrl=${page.url()}`);
}

function isVerifierUrl(currentUrl: string, endpoint: string): boolean {
  try {
    const current = new URL(currentUrl);
    const base = new URL(endpoint);
    return current.origin === base.origin && current.pathname === '/app/inrupt-smoke.html';
  } catch {
    return false;
  }
}

async function waitForLoggedIn(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(() => {
    const loggedIn = document.getElementById('loggedIn')?.textContent?.trim();
    return loggedIn === 'true';
  }, undefined, { timeout: timeoutMs });
}

async function clickAndWaitForReport(
  page: Page,
  buttonName: RegExp,
  predicate: (report: Record<string, any>) => boolean,
  timeoutMs: number,
): Promise<Record<string, any>> {
  await page.getByRole('button', { name: buttonName }).click({ timeout: timeoutMs });
  const startedAt = Date.now();
  let lastReport: Record<string, any> | undefined;
  let lastText = '';

  while (Date.now() - startedAt < timeoutMs) {
    const text = await page.locator('#report').inputValue({ timeout: 1_000 }).catch(() => '');
    lastText = text;
    try {
      const report = JSON.parse(text) as Record<string, any>;
      lastReport = report;
      if (predicate(report)) {
        return report;
      }
      if (report.error) {
        throw new Error(String(report.error));
      }
    } catch (error) {
      if (error instanceof Error && lastReport?.error) {
        throw error;
      }
    }
    await page.waitForTimeout(500);
  }

  throw new Error(`report did not satisfy predicate for ${buttonName}; lastReport=${lastText.slice(0, 500)}`);
}

async function createPasswordAccount(baseUrl: string): Promise<PasswordAccount> {
  const suffix = Date.now().toString(36);
  const email = `inrupt-oidc-${suffix}@test.local`;
  const password = `InruptOidc${suffix}!`;
  const podName = `inrupt-${suffix}`;
  const headers = ngrokJsonHeaders();

  const accountResponse = await fetch(new URL('/.account/account/', baseUrl), {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  });
  const accountBody = await accountResponse.text().catch(() => '');
  if (!accountResponse.ok) {
    throw new Error(`account create failed: ${accountResponse.status} ${accountBody.slice(0, 200)}`);
  }
  const accountData = JSON.parse(accountBody) as { authorization?: string };
  if (!accountData.authorization) {
    throw new Error(`account create response missing authorization: ${accountBody.slice(0, 200)}`);
  }

  const controlsResponse = await fetch(new URL('/.account/', baseUrl), {
    headers: {
      ...ngrokAcceptHeaders(),
      Authorization: `CSS-Account-Token ${accountData.authorization}`,
    },
  });
  const controlsBody = await controlsResponse.text().catch(() => '');
  if (!controlsResponse.ok) {
    throw new Error(`account controls failed: ${controlsResponse.status} ${controlsBody.slice(0, 200)}`);
  }
  const controls = JSON.parse(controlsBody) as {
    controls?: {
      password?: { create?: string };
      account?: { pod?: string };
    };
  };

  const passwordCreateUrl = controls.controls?.password?.create;
  if (!passwordCreateUrl) {
    throw new Error(`account controls missing password.create: ${controlsBody.slice(0, 200)}`);
  }
  const passwordResponse = await fetch(passwordCreateUrl, {
    method: 'POST',
    headers: {
      ...headers,
      Authorization: `CSS-Account-Token ${accountData.authorization}`,
    },
    body: JSON.stringify({ email, password }),
  });
  const passwordBody = await passwordResponse.text().catch(() => '');
  if (!passwordResponse.ok) {
    throw new Error(`password login create failed: ${passwordResponse.status} ${passwordBody.slice(0, 200)}`);
  }

  const podCreateUrl = controls.controls?.account?.pod;
  if (!podCreateUrl) {
    throw new Error(`account controls missing account.pod: ${controlsBody.slice(0, 200)}`);
  }
  const podResponse = await fetch(podCreateUrl, {
    method: 'POST',
    headers: {
      ...headers,
      Authorization: `CSS-Account-Token ${accountData.authorization}`,
    },
    body: JSON.stringify({ name: podName }),
  });
  const podBody = await podResponse.text().catch(() => '');
  if (!podResponse.ok) {
    throw new Error(`pod create failed: ${podResponse.status} ${podBody.slice(0, 200)}`);
  }
  const podData = JSON.parse(podBody) as { webId?: string; pod?: string };
  const webId = podData.webId;
  const podUrl = podData.pod ?? new URL(`/${podName}/`, baseUrl).toString();
  if (!webId) {
    throw new Error(`pod create response missing webId: ${podBody.slice(0, 200)}`);
  }

  return { email, password, webId, podUrl, podName };
}

function ngrokAcceptHeaders(): HeadersInit {
  return {
    Accept: 'application/json',
    'ngrok-skip-browser-warning': 'true',
  };
}

function ngrokJsonHeaders(): HeadersInit {
  return {
    ...ngrokAcceptHeaders(),
    'Content-Type': 'application/json',
  };
}

async function fetchUntilOk(
  target: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<FetchProbe> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastResponse: FetchProbe | undefined;
  let lastError: unknown;

  while (Date.now() < deadline) {
    attempts += 1;
    const controller = new AbortController();
    const remainingMs = Math.max(1, deadline - Date.now());
    const timeout = setTimeout(() => controller.abort(), Math.min(5_000, remainingMs));

    try {
      const response = await fetch(target, {
        ...init,
        signal: controller.signal,
      });
      const body = await response.text().catch(() => '');
      const result = {
        ok: response.ok,
        status: response.status,
        body,
        attempts,
      };
      if (result.ok) {
        return result;
      }
      lastResponse = result;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }

    const delayMs = Math.min(500, Math.max(25, deadline - Date.now()));
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  if (lastResponse) {
    return { ...lastResponse, attempts };
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown error');
  throw new Error(`endpoint was not reachable before timeout: ${reason}`);
}

async function startProbeServer(): Promise<{ server: import('node:http').Server; port: number }> {
  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('failed to allocate probe server port');
  }
  return { server, port: address.port };
}

function closeServer(server: import('node:http').Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function pushStage(result: Record<string, unknown>, stage: string): void {
  (result.stages as string[]).push(stage);
}

function normalizeEndpoint(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return new URL(value).toString().replace(/\/+$/u, '') + '/';
  } catch {
    return undefined;
  }
}

function readPositiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

void main().catch((error) => {
  writeJson({
    kind: 'ngrok-inrupt-oidc-smoke',
    dryRun: false,
    smokeOk: false,
    error: error instanceof Error ? error.message : String(error),
    proves: PROVES,
    caveats: CAVEATS,
  });
  process.exitCode = 1;
});
